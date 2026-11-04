import { HttpException, HttpStatus } from '@nestjs/common';

/** Domain error with a stable machine-readable code (translated on the client). */
export class DomainError extends HttpException {
  constructor(public readonly code: string, status: HttpStatus = HttpStatus.BAD_REQUEST, public readonly details?: unknown) {
    super({ code, details }, status);
  }
}
export const err = {
  badRequest: (code: string, details?: unknown) => new DomainError(code, HttpStatus.BAD_REQUEST, details),
  unauthorized: (code = 'UNAUTHORIZED') => new DomainError(code, HttpStatus.UNAUTHORIZED),
  forbidden: (code = 'FORBIDDEN', details?: unknown) => new DomainError(code, HttpStatus.FORBIDDEN, details),
  notFound: (code = 'NOT_FOUND') => new DomainError(code, HttpStatus.NOT_FOUND),
  conflict: (code: string, details?: unknown) => new DomainError(code, HttpStatus.CONFLICT, details),
  unprocessable: (code: string, details?: unknown) => new DomainError(code, HttpStatus.UNPROCESSABLE_ENTITY, details),
};
