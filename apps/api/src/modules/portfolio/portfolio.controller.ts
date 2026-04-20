import { Controller, Get } from '@nestjs/common';

@Controller('portfolios')
export class PortfolioController {
  // Stub Phase 1 — branchement Supabase + authz à venir.
  @Get()
  list() {
    return { ok: true, data: [] };
  }
}
