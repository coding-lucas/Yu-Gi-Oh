import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { Response } from 'express';

/** Uniform error body `{ code, message?, details? }` and no leaking of internal errors. */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly log = new Logger('Errors');
  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse() as any;
      const code = typeof body === 'object' && body?.code ? body.code : status === 429 ? 'RATE_LIMITED' : status === 404 ? 'NOT_FOUND' : `HTTP_${status}`;
      res.status(status).json({ code, details: body?.details, message: typeof body === 'object' ? body?.message : body });
      return;
    }
    const e = exception as any;
    if (e?.code === 'check_violation' || e?.code === '23514') {
      this.log.error(`integrity violation: ${e.message}`);
      res.status(409).json({ code: 'INTEGRITY_VIOLATION' });
      return;
    }
    this.log.error(e?.stack ?? String(e));
    res.status(500).json({ code: 'INTERNAL_ERROR' });
  }
}
