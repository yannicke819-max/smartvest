import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

@Injectable()
export class SupabaseService {
  private readonly logger = new Logger(SupabaseService.name);
  private client: SupabaseClient | null = null;

  constructor(private readonly config: ConfigService) {
    // Init synchrone dans le constructeur pour que les autres services qui
    // appellent getClient() dans LEUR constructeur (ex. LisaService) trouvent
    // le client déjà prêt — onModuleInit() tourne trop tard dans le cycle
    // de vie NestJS (après tous les constructeurs).

    // Accept both SUPABASE_URL (Railway/standard) and NEXT_PUBLIC_SUPABASE_URL (shared .env)
    const url = this.config.get<string>('SUPABASE_URL')
      ?? this.config.get<string>('NEXT_PUBLIC_SUPABASE_URL');
    const serviceKey = this.config.get<string>('SUPABASE_SERVICE_ROLE_KEY');
    if (!url || !serviceKey) {
      this.logger.warn('Supabase non configuré (URL ou service role manquant).');
      return;
    }

    // Diagnostic : décoder le payload JWT pour vérifier le `role`. Un
    // permission denied avec BYPASSRLS théorique trahit une clé anon utilisée
    // à la place de service_role. On n'expose PAS la clé, juste son `role`.
    try {
      const parts = serviceKey.split('.');
      if (parts.length === 3) {
        const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/').padEnd(
          parts[1].length + (4 - (parts[1].length % 4)) % 4, '=',
        );
        const payload = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
        const hostPrefix = url.replace(/^https?:\/\//, '').split('.')[0];
        this.logger.log(`Supabase host=${hostPrefix} role=${payload?.role ?? 'UNKNOWN'} iss=${payload?.iss ?? '?'}`);
        if (payload?.role !== 'service_role') {
          this.logger.error(
            `⚠️  SUPABASE_SERVICE_ROLE_KEY contient un JWT avec role="${payload?.role}" — attendu "service_role". ` +
            `Les requêtes vont échouer en "permission denied". Corriger la variable Railway.`,
          );
        }
      }
    } catch {
      this.logger.warn('Impossible de décoder le JWT de SUPABASE_SERVICE_ROLE_KEY.');
    }

    this.client = createClient(url, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  getClient(): SupabaseClient {
    if (!this.client) {
      throw new Error('Supabase client non initialisé — vérifier les variables d\'environnement.');
    }
    return this.client;
  }

  isReady(): boolean {
    return this.client !== null;
  }
}
