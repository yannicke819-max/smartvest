import { UnauthorizedException } from '@nestjs/common';

/**
 * Extrait l'ID utilisateur depuis les headers entrants.
 *
 * Ordre de priorité :
 *  1. Header `x-user-id` — envoyé explicitement par apiFetch côté client.
 *  2. Claim `sub` du JWT Bearer — fallback si x-user-id manque (ex. race
 *     condition au montage React). On décode sans vérifier la signature :
 *     le service role Supabase ne vérifie pas non plus les JWTs entrants
 *     (verify_jwt: false implicite avec la service role key).
 *
 * Lève UnauthorizedException si aucune source ne fournit d'UUID.
 */
export function extractUserId(headers: Record<string, string>): string {
  // 1. Header explicite
  const fromHeader = headers['x-user-id'];
  if (fromHeader) return fromHeader;

  // 2. Bearer JWT → payload.sub
  const auth = headers['authorization'];
  if (auth?.startsWith('Bearer ')) {
    try {
      const parts = auth.slice(7).split('.');
      if (parts.length === 3) {
        // base64url → base64 (add padding, swap URL-safe chars)
        const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/').padEnd(
          parts[1].length + (4 - (parts[1].length % 4)) % 4, '=',
        );
        const payload = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
        if (payload?.sub) return payload.sub as string;
      }
    } catch {
      // JWT malformé — continuer vers le throw
    }
  }

  throw new UnauthorizedException('Authentification requise (x-user-id ou Bearer absent)');
}
