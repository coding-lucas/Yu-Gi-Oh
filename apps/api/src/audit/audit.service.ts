import { Injectable } from '@nestjs/common';
import { desc, eq, and, SQL } from 'drizzle-orm';
import { Database, DbService } from '../db/db.service';
import { auditLogs } from '../db/schema';

export interface AuditInput {
  actorId?: string | null;
  actorRole?: string | null;
  action: string;
  entityType?: string;
  entityId?: string;
  before?: unknown;
  after?: unknown;
  ip?: string | null;
}

const json = (v: unknown) => (v === undefined ? null : JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x))));

@Injectable()
export class AuditService {
  constructor(private readonly dbs: DbService) {}

  async log(a: AuditInput, tx?: Database) {
    await (tx ?? this.dbs.db).insert(auditLogs).values({
      actorId: a.actorId ?? null,
      actorRole: a.actorRole ?? null,
      action: a.action,
      entityType: a.entityType,
      entityId: a.entityId,
      before: json(a.before),
      after: json(a.after),
      ip: a.ip ?? null,
    });
  }

  async list(filter: { entityType?: string; entityId?: string; action?: string; limit?: number }) {
    const where: SQL[] = [];
    if (filter.entityType) where.push(eq(auditLogs.entityType, filter.entityType));
    if (filter.entityId) where.push(eq(auditLogs.entityId, filter.entityId));
    if (filter.action) where.push(eq(auditLogs.action, filter.action));
    return this.dbs.db.select().from(auditLogs).where(where.length ? and(...where) : undefined).orderBy(desc(auditLogs.id)).limit(Math.min(filter.limit ?? 100, 500));
  }
}
