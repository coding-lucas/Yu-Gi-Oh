import { PipeTransform } from '@nestjs/common';
import { ZodSchema } from 'zod';
import { err } from './errors';

export class ZodPipe<T> implements PipeTransform {
  constructor(private readonly schema: ZodSchema<T, any, any>) {}
  transform(value: unknown): T {
    const r = this.schema.safeParse(value);
    if (!r.success) throw err.badRequest('VALIDATION_FAILED', r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
    return r.data;
  }
}
