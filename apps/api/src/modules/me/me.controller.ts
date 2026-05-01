import { Controller, Delete, Get, Headers, HttpCode, HttpStatus, Res } from '@nestjs/common';
import type { Response } from 'express';
import { MeService } from './me.service';

@Controller('me')
export class MeController {
  constructor(private readonly me: MeService) {}

  /**
   * GET /me/export
   * RGPD — exports all user data as a downloadable JSON file.
   * Auth: live JWT validation (Bearer token, server-side verification).
   */
  @Get('export')
  async export(
    @Headers() headers: Record<string, string>,
    @Res() res: Response,
  ): Promise<void> {
    const { userId } = await this.me.validateToken(headers['authorization']);
    const data = await this.me.exportUserData(userId);
    const json = JSON.stringify(data, null, 2);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename="smartvest-export.json"');
    res.setHeader('Content-Length', Buffer.byteLength(json, 'utf8'));
    res.send(json);
  }

  /**
   * DELETE /me
   * RGPD — permanently deletes the authenticated user account and all data.
   * Rate-limited: 3 attempts per 60 seconds per user.
   * Auth: live JWT validation (Bearer token, server-side verification).
   */
  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteAccount(
    @Headers() headers: Record<string, string>,
  ): Promise<void> {
    const { userId, email } = await this.me.validateToken(headers['authorization']);
    this.me.checkDeleteRateLimit(userId);

    const rawIp = headers['x-forwarded-for']?.split(',')[0]?.trim()
      ?? headers['x-real-ip'];

    await this.me.deleteAccount(userId, email, rawIp);
  }
}
