// LISA refonte B.4.c — Web Push notifications via VAPID.
//
// Implémentation native (Node crypto, pas de dep web-push). On envoie des
// pushes "trigger-only" (body vide) → le service worker côté front fait
// fetch /lisa/notifications pour afficher le contenu réel. Évite la
// complexité d'aes128gcm encryption pour le payload.
//
// Pré-requis env :
//   VAPID_PUBLIC_KEY  (base64url uncompressed P-256, ex: BNc...)
//   VAPID_PRIVATE_KEY (base64url raw 32 bytes)
//   VAPID_SUBJECT     (mailto:admin@example.com, default 'mailto:lisa@smartvest.app')
//
// Génération clés (one-shot) : `node scripts/generate-vapid-keys.mjs` ou
// `npx web-push generate-vapid-keys` depuis n'importe où.

import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { SupabaseService } from '../../supabase/supabase.service';

export interface PushSubscriptionPayload {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  userAgent?: string;
}

@Injectable()
export class PushNotificationsService {
  private readonly logger = new Logger(PushNotificationsService.name);
  private vapidPublicKey: string | null = null;
  private vapidPrivateKey: string | null = null;
  private vapidSubject: string = 'mailto:lisa@smartvest.app';

  constructor(
    private readonly config: ConfigService,
    private readonly supabase: SupabaseService,
  ) {
    this.vapidPublicKey = this.config.get<string>('VAPID_PUBLIC_KEY') ?? null;
    this.vapidPrivateKey = this.config.get<string>('VAPID_PRIVATE_KEY') ?? null;
    this.vapidSubject = this.config.get<string>('VAPID_SUBJECT') ?? this.vapidSubject;
    if (!this.vapidPublicKey || !this.vapidPrivateKey) {
      this.logger.warn(
        '[push] VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY missing — sends will SKIP. Subscribe still works.',
      );
    }
  }

  isReady(): boolean {
    return !!this.vapidPublicKey && !!this.vapidPrivateKey;
  }

  getPublicKey(): string | null {
    return this.vapidPublicKey;
  }

  async subscribe(userId: string, sub: PushSubscriptionPayload) {
    if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) {
      throw new BadRequestException('Invalid subscription payload');
    }
    const { error } = await this.supabase.getClient()
      .from('push_subscriptions')
      .upsert(
        {
          user_id: userId,
          endpoint: sub.endpoint,
          p256dh: sub.keys.p256dh,
          auth: sub.keys.auth,
          user_agent: sub.userAgent ?? null,
        },
        { onConflict: 'user_id,endpoint' },
      );
    if (error) throw new BadRequestException(error.message);
    return { ok: true };
  }

  async unsubscribe(userId: string, endpoint: string) {
    const { error } = await this.supabase.getClient()
      .from('push_subscriptions')
      .delete()
      .eq('user_id', userId)
      .eq('endpoint', endpoint);
    if (error) throw new BadRequestException(error.message);
    return { ok: true };
  }

  async listSubscriptions(userId: string) {
    const { data } = await this.supabase.getClient()
      .from('push_subscriptions')
      .select('endpoint, created_at, user_agent, last_sent_at')
      .eq('user_id', userId);
    return data ?? [];
  }

  /**
   * Envoie un push "trigger-only" (body vide) à toutes les subs d'un user.
   * Le service worker côté front gère l'affichage via fetch /lisa/notifications.
   */
  async notifyUser(userId: string, kind: string): Promise<{ sent: number; errors: number }> {
    if (!this.isReady()) {
      this.logger.debug(`[push] notifyUser SKIP — VAPID keys missing (kind=${kind})`);
      return { sent: 0, errors: 0 };
    }
    const { data: subs } = await this.supabase.getClient()
      .from('push_subscriptions')
      .select('endpoint, p256dh, auth')
      .eq('user_id', userId);
    if (!subs || subs.length === 0) return { sent: 0, errors: 0 };

    let sent = 0;
    let errors = 0;
    for (const s of subs as Array<{ endpoint: string }>) {
      try {
        await this.sendTriggerOnly(s.endpoint);
        await this.supabase.getClient()
          .from('push_subscriptions')
          .update({ last_sent_at: new Date().toISOString(), last_error: null })
          .eq('endpoint', s.endpoint);
        sent++;
      } catch (e) {
        const msg = String(e).slice(0, 200);
        await this.supabase.getClient()
          .from('push_subscriptions')
          .update({ last_error: msg })
          .eq('endpoint', s.endpoint);
        // Endpoint 410 Gone → cleanup
        if (msg.includes('410')) {
          await this.supabase.getClient()
            .from('push_subscriptions')
            .delete()
            .eq('endpoint', s.endpoint);
          this.logger.debug(`[push] cleaned up 410 endpoint`);
        }
        errors++;
      }
    }
    this.logger.log(`[push] notifyUser kind=${kind} sent=${sent} errors=${errors}`);
    return { sent, errors };
  }

  private async sendTriggerOnly(endpoint: string): Promise<void> {
    const audience = new URL(endpoint).origin;
    const jwt = this.signVapidJwt(audience);
    const headers: Record<string, string> = {
      'Authorization': `vapid t=${jwt}, k=${this.vapidPublicKey}`,
      'TTL': '60',
      'Urgency': 'normal',
    };
    const res = await fetch(endpoint, { method: 'POST', headers });
    if (!res.ok) {
      throw new Error(`Push ${res.status} ${res.statusText}`);
    }
  }

  /**
   * Signe un JWT VAPID (ES256 alg, P-256 curve).
   * Sans dependency externe : utilise Node crypto.createSign avec une clé
   * PEM dérivée de la VAPID_PRIVATE_KEY (32 bytes base64url → PEM PKCS8).
   */
  private signVapidJwt(audience: string): string {
    if (!this.vapidPrivateKey) throw new Error('VAPID_PRIVATE_KEY missing');
    const header = { typ: 'JWT', alg: 'ES256' };
    const claims = {
      aud: audience,
      exp: Math.floor(Date.now() / 1000) + 12 * 3600,
      sub: this.vapidSubject,
    };
    const segHeader = base64UrlJson(header);
    const segClaims = base64UrlJson(claims);
    const signingInput = `${segHeader}.${segClaims}`;

    const privatePem = derivePrivatePem(this.vapidPrivateKey, this.vapidPublicKey!);
    const signer = crypto.createSign('SHA256');
    signer.update(signingInput);
    const derSignature = signer.sign({ key: privatePem, dsaEncoding: 'ieee-p1363' });
    const sigB64 = base64UrlBuf(derSignature);
    return `${signingInput}.${sigB64}`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers (out-of-class pour testabilité éventuelle).
// ─────────────────────────────────────────────────────────────────────────────

function base64UrlBuf(buf: Buffer): string {
  return buf.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function base64UrlJson(obj: object): string {
  return base64UrlBuf(Buffer.from(JSON.stringify(obj), 'utf8'));
}
function base64UrlToBuf(s: string): Buffer {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4 !== 0) s += '=';
  return Buffer.from(s, 'base64');
}

/**
 * Convertit une VAPID_PRIVATE_KEY (32 bytes base64url, raw P-256 scalar)
 * en PEM PKCS8 importable par crypto.createSign.
 *
 * Format PKCS8 ECPrivateKey + AlgoIdentifier prefix pour P-256.
 * Référence : RFC 5208 + RFC 5915.
 */
function derivePrivatePem(vapidPrivateKey: string, vapidPublicKey: string): string {
  const privRaw = base64UrlToBuf(vapidPrivateKey);
  if (privRaw.length !== 32) {
    throw new Error(`VAPID_PRIVATE_KEY must be 32 bytes raw, got ${privRaw.length}`);
  }
  const pubRaw = base64UrlToBuf(vapidPublicKey);
  if (pubRaw.length !== 65 || pubRaw[0] !== 0x04) {
    throw new Error(`VAPID_PUBLIC_KEY must be 65 bytes uncompressed P-256 (0x04 + X + Y), got ${pubRaw.length}`);
  }
  const xRaw = pubRaw.subarray(1, 33);
  const yRaw = pubRaw.subarray(33, 65);
  // Import via JWK (P-256 EC, format requis par Node : d + x + y).
  const keyObj = crypto.createPrivateKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      d: vapidPrivateKey,
      x: base64UrlBuf(xRaw),
      y: base64UrlBuf(yRaw),
    } as crypto.JsonWebKey,
    format: 'jwk',
  });
  return keyObj.export({ format: 'pem', type: 'pkcs8' }).toString();
}
