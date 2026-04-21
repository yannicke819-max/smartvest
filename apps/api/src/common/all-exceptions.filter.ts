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

    this.logger.error(
      `${req.method} ${req.url} → ${status} — ${String(message)}`,
      exception instanceof Error ? exception.stack : undefined,
    );

    res.status(status).json(
      typeof body === 'object'
        ? { ...(body as object), path: req.url, timestamp: new Date().toISOString() }
        : { message: body, statusCode: status, path: req.url, timestamp: new Date().toISOString() },
    );
  }
}
