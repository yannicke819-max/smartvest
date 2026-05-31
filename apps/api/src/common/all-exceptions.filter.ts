import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';

/**
 * Filtre global : loggue toute exception non-HTTP avec sa cause (ex. erreurs
 * Supabase renvoyées comme BadRequestException). Sans ce filtre, les 400/500
 * affichés côté client n'exposent rien de la cause racine dans les logs
 * Railway — rendant le debug impossible en prod.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('HTTP');

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();

    const status = exception instanceof HttpException
      ? exception.getStatus()
      : HttpStatus.INTERNAL_SERVER_ERROR;

    const body: string | object = exception instanceof HttpException
      ? (exception.getResponse() as string | object)
      : { message: (exception as Error)?.message ?? 'Internal server error' };

    const message = typeof body === 'string'
      ? body
      : ((body as Record<string, unknown>).message ?? JSON.stringify(body));

    // 31/05/2026 — pollution Fly logs : un client qui poll un portfolio mort
    // génère ~7 req/s × ~10 lignes stack trace × 4xx = pollution massive sans
    // valeur (l'erreur est côté client, pas une vraie défaillance serveur).
    // Stack trace + level=error réservés aux 5xx ; 4xx = warn sans stack.
    const isServerError = status >= 500;
    const log = isServerError
      ? this.logger.error.bind(this.logger)
      : this.logger.warn.bind(this.logger);
    log(
      `${req.method} ${req.url} → ${status} — ${String(message)}`,
      isServerError && exception instanceof Error ? exception.stack : undefined,
    );

    res.status(status).json(
      typeof body === 'object'
        ? { ...(body as object), path: req.url, timestamp: new Date().toISOString() }
        : { message: body, statusCode: status, path: req.url, timestamp: new Date().toISOString() },
    );
  }
}
