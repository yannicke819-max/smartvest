// LISA refonte B.4.b — Daily digest email cron via Resend API.
//
// Cron 09:00 UTC : pour chaque portfolio avec lisa_daily_digest_enabled=true
// ET lisa_notification_email IS NOT NULL, envoie un récap HTML du jour D-1.
//
// Resend API : POST https://api.resend.com/emails (fetch direct, pas de dep).
// Pré-requis : secret Fly RESEND_API_KEY + DAILY_DIGEST_FROM_EMAIL.
// Sans ces secrets, le cron tourne et log SKIP/ERROR mais ne crash pas.

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { SupabaseService } from '../../supabase/supabase.service';

interface PortfolioConfig {
  portfolio_id: string;
  user_id: string;
  lisa_notification_email: string;
  lisa_initial_capital_usd: number;
  lisa_compound_pnl_enabled: boolean;
  kill_switch_active: boolean;
  lisa_target_daily_usd: number;
  lisa_target_daily_pct: number;
}

interface DigestData {
  cfg: PortfolioConfig;
  currentCapital: number;
  yesterdayPnl: number;
  yesterdayCount: number;
  yesterdayWins: number;
  yesterdayLosses: number;
  effectiveDailyTarget: number;
  topLessons: Array<{ kind: string; citations: number; sumPnl: number }>;
}

@Injectable()
export class DailyDigestService {
  private readonly logger = new Logger(DailyDigestService.name);
  private enabled = false;
  private apiKey: string | null = null;
  private fromEmail: string | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly supabase: SupabaseService,
    private readonly schedulerRegistry: SchedulerRegistry,
  ) {}

  onModuleInit(): void {
    this.enabled = (this.config.get<string>('DAILY_DIGEST_ENABLED') ?? 'true').toLowerCase() === 'true';
    this.apiKey = this.config.get<string>('RESEND_API_KEY') ?? null;
    this.fromEmail = this.config.get<string>('DAILY_DIGEST_FROM_EMAIL') ?? 'lisa@smartvest.app';

    if (!this.enabled) {
      this.logger.log('[daily-digest] disabled via env DAILY_DIGEST_ENABLED=false');
      return;
    }

    try {
      // 09:00 UTC chaque jour
      const job = new CronJob('0 9 * * *', () => {
        this.runDigest().catch((e) =>
          this.logger.error(`[daily-digest] cron failed: ${String(e).slice(0, 200)}`),
        );
      });
      this.schedulerRegistry.addCronJob('lisa-daily-digest', job);
      job.start();
      this.logger.log(
        `[daily-digest] ENABLED — cron 09:00 UTC, resend_key=${this.apiKey ? 'set' : 'MISSING'}, from=${this.fromEmail}`,
      );
    } catch (e) {
      this.logger.error(`[daily-digest] cron register failed: ${String(e).slice(0, 200)}`);
    }
  }

  /**
   * Exécutable manuellement (via admin endpoint si besoin) ou via cron.
   * Retourne stats { sent, skipped, errors }.
   */
  async runDigest(): Promise<{ sent: number; skipped: number; errors: number }> {
    if (!this.supabase.isReady()) {
      this.logger.warn('[daily-digest] supabase not ready, skip');
      return { sent: 0, skipped: 0, errors: 0 };
    }
    if (!this.apiKey) {
      this.logger.warn('[daily-digest] RESEND_API_KEY missing — runs in DRY mode (log only)');
    }

    const client = this.supabase.getClient();
    const { data: configs, error } = await client
      .from('lisa_session_configs')
      .select('portfolio_id, user_id, lisa_notification_email, lisa_initial_capital_usd, lisa_compound_pnl_enabled, kill_switch_active, lisa_target_daily_usd, lisa_target_daily_pct')
      .eq('lisa_daily_digest_enabled', true)
      .not('lisa_notification_email', 'is', null);
    if (error) {
      this.logger.error(`[daily-digest] config fetch err: ${error.message}`);
      return { sent: 0, skipped: 0, errors: 1 };
    }

    let sent = 0;
    let skipped = 0;
    let errors = 0;
    for (const cfg of (configs ?? []) as Array<Record<string, unknown>>) {
      const portfolioId = String(cfg.portfolio_id);
      const email = String(cfg.lisa_notification_email ?? '').trim();
      if (!email) { skipped++; continue; }

      try {
        const data = await this.buildDigestData(cfg as unknown as PortfolioConfig);
        const html = this.renderHtml(data);
        const subject = this.buildSubject(data);

        if (this.apiKey) {
          await this.sendViaResend(email, subject, html);
        } else {
          this.logger.log(`[daily-digest] DRY would-send to ${email} subject="${subject}"`);
        }
        await client.from('lisa_decision_log').insert({
          portfolio_id: portfolioId,
          kind: 'daily_digest_sent',
          payload: {
            email,
            yesterday_pnl: data.yesterdayPnl,
            trades_count: data.yesterdayCount,
            dry: !this.apiKey,
          },
        });
        sent++;
      } catch (e) {
        const msg = String(e).slice(0, 200);
        this.logger.warn(`[daily-digest] portfolio=${portfolioId.slice(0, 8)} err: ${msg}`);
        await client.from('lisa_decision_log').insert({
          portfolio_id: portfolioId,
          kind: 'daily_digest_error',
          payload: { email, error: msg },
        });
        errors++;
      }
    }
    this.logger.log(`[daily-digest] done sent=${sent} skipped=${skipped} errors=${errors}`);
    return { sent, skipped, errors };
  }

  private async buildDigestData(cfg: PortfolioConfig): Promise<DigestData> {
    const client = this.supabase.getClient();
    const now = new Date();
    const yesterdayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));
    const yesterdayEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

    const initialCapital = Number(cfg.lisa_initial_capital_usd ?? 10000);
    const compound = Boolean(cfg.lisa_compound_pnl_enabled ?? true);

    const { data: allClosed } = await client
      .from('lisa_positions')
      .select('realized_pnl_usd, exit_timestamp')
      .eq('portfolio_id', cfg.portfolio_id)
      .neq('status', 'open');
    const cumulative = (allClosed ?? []).reduce(
      (s, c) => s + Number((c as { realized_pnl_usd?: unknown }).realized_pnl_usd ?? 0),
      0,
    );
    const currentCapital = compound ? initialCapital + cumulative : initialCapital;

    const yesterdayRows = (allClosed ?? []).filter((c) => {
      const t = String((c as { exit_timestamp?: string }).exit_timestamp ?? '');
      return t >= yesterdayStart.toISOString() && t < yesterdayEnd.toISOString();
    });
    const yesterdayPnl = yesterdayRows.reduce(
      (s, c) => s + Number((c as { realized_pnl_usd?: unknown }).realized_pnl_usd ?? 0),
      0,
    );
    const yesterdayWins = yesterdayRows.filter((c) => Number((c as { realized_pnl_usd?: unknown }).realized_pnl_usd ?? 0) > 0).length;
    const yesterdayLosses = yesterdayRows.filter((c) => Number((c as { realized_pnl_usd?: unknown }).realized_pnl_usd ?? 0) < 0).length;

    const dailyUsdFloor = Number(cfg.lisa_target_daily_usd ?? 200);
    const dailyPct = Number(cfg.lisa_target_daily_pct ?? 2);
    const effectiveDailyTarget = Math.max(dailyUsdFloor, (dailyPct / 100) * currentCapital);

    // Top lessons cited last 24h
    const { data: citations } = await client
      .from('scanner_lesson_citations')
      .select('lesson_id, marker_text, outcome_pnl_usd')
      .eq('portfolio_id', cfg.portfolio_id)
      .gte('cited_at', yesterdayStart.toISOString())
      .lt('cited_at', yesterdayEnd.toISOString());
    const lessonAgg = new Map<string, { kind: string; citations: number; sumPnl: number }>();
    for (const c of (citations ?? []) as Array<Record<string, unknown>>) {
      const key = String(c.marker_text ?? '?');
      let b = lessonAgg.get(key);
      if (!b) { b = { kind: key, citations: 0, sumPnl: 0 }; lessonAgg.set(key, b); }
      b.citations += 1;
      b.sumPnl += Number(c.outcome_pnl_usd ?? 0);
    }
    const topLessons = [...lessonAgg.values()].sort((a, b) => b.citations - a.citations).slice(0, 3);

    return { cfg, currentCapital, yesterdayPnl, yesterdayCount: yesterdayRows.length, yesterdayWins, yesterdayLosses, effectiveDailyTarget, topLessons };
  }

  private buildSubject(d: DigestData): string {
    const pnlStr = d.yesterdayPnl >= 0 ? `+$${d.yesterdayPnl.toFixed(2)}` : `-$${Math.abs(d.yesterdayPnl).toFixed(2)}`;
    const emoji = d.yesterdayPnl >= 0 ? '✅' : '⚠️';
    const ks = d.cfg.kill_switch_active ? ' 🛑' : '';
    return `${emoji} LISA jour D-1 : ${pnlStr} · ${d.yesterdayCount} trades${ks}`;
  }

  private renderHtml(d: DigestData): string {
    const pnlColor = d.yesterdayPnl > 0 ? '#059669' : d.yesterdayPnl < 0 ? '#dc2626' : '#6b7280';
    const pnlSign = d.yesterdayPnl >= 0 ? '+' : '-';
    const pnlAbs = Math.abs(d.yesterdayPnl).toFixed(2);
    const pctTarget = d.effectiveDailyTarget > 0 ? (d.yesterdayPnl / d.effectiveDailyTarget * 100).toFixed(0) : '—';
    const wr = (d.yesterdayWins + d.yesterdayLosses) > 0
      ? ((d.yesterdayWins / (d.yesterdayWins + d.yesterdayLosses)) * 100).toFixed(0)
      : '—';

    const killBanner = d.cfg.kill_switch_active
      ? `<div style="background:#fee2e2;border-left:4px solid #dc2626;padding:12px;margin-bottom:16px;border-radius:4px;"><strong>🛑 Kill-switch anti-spirale armé</strong><br/><span style="font-size:13px;color:#991b1b">TRADER suspendu. Désarme manuellement dans Config LISA pour reprendre.</span></div>`
      : '';

    const lessonsBlock = d.topLessons.length > 0
      ? `<h3 style="font-size:14px;margin-top:24px;margin-bottom:8px;">📚 Top lessons hier</h3><ul style="padding-left:20px;font-size:13px;">${d.topLessons.map(l => `<li><code style="background:#f3f4f6;padding:2px 6px;border-radius:3px;">${l.kind}</code> · ${l.citations} citation(s) · ${l.sumPnl >= 0 ? '+' : ''}$${l.sumPnl.toFixed(2)}</li>`).join('')}</ul>`
      : '';

    return `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#111827;">
  <h1 style="font-size:20px;margin-bottom:4px;">🤖 LISA — Récap jour D-1</h1>
  <p style="color:#6b7280;font-size:13px;margin-top:0;">Capital actuel : $${d.currentCapital.toFixed(0)} (initial $${d.cfg.lisa_initial_capital_usd.toFixed(0)})</p>

  ${killBanner}

  <div style="background:#f9fafb;border-radius:8px;padding:16px;margin:16px 0;">
    <div style="font-size:13px;color:#6b7280;">P&amp;L réalisé hier</div>
    <div style="font-size:32px;font-weight:700;color:${pnlColor};margin:4px 0;">${pnlSign}$${pnlAbs}</div>
    <div style="font-size:12px;color:#6b7280;">
      ${d.yesterdayCount} trades · ${d.yesterdayWins}W / ${d.yesterdayLosses}L · win-rate ${wr}%
    </div>
    <div style="font-size:12px;color:#6b7280;margin-top:4px;">
      Cible jour : $${d.effectiveDailyTarget.toFixed(0)} · atteint ${pctTarget}%
    </div>
  </div>

  ${lessonsBlock}

  <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0;"/>
  <p style="font-size:11px;color:#9ca3af;">Tu peux désactiver ces emails dans Config LISA &gt; Daily Digest.</p>
</body></html>`;
  }

  private async sendViaResend(to: string, subject: string, html: string): Promise<void> {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: this.fromEmail,
        to: [to],
        subject,
        html,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Resend ${res.status}: ${body.slice(0, 200)}`);
    }
  }
}
