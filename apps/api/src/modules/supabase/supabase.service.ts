import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

@Injectable()
export class SupabaseService implements OnModuleInit {
  private readonly logger = new Logger(SupabaseService.name);
  private client: SupabaseClient | null = null;

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    // Accept both SUPABASE_URL (Railway/standard) and NEXT_PUBLIC_SUPABASE_URL (shared .env)
    const url = this.config.get<string>('SUPABASE_URL')
      ?? this.config.get<string>('NEXT_PUBLIC_SUPABASE_URL');
    const serviceKey = this.config.get<string>('SUPABASE_SERVICE_ROLE_KEY');
    if (!url || !serviceKey) {
      this.logger.warn('Supabase non configuré (URL ou service role manquant).');
      return;
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
