import { Injectable } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { DEMO_CURRENCY } from '@athosbet/shared';
import { DbService } from '../db/db.service';
import { ledgerAccounts, ledgerEntries, ledgerTransactions } from '../db/schema';
import { LedgerService } from '../ledger/ledger.service';

@Injectable()
export class WalletService {
  constructor(private readonly dbs: DbService, private readonly ledger: LedgerService) {}

  async summary(userId: string) {
    const balance = await this.ledger.balanceOf(userId, DEMO_CURRENCY, 'SANDBOX');
    return { currency: DEMO_CURRENCY, mode: 'SANDBOX', balance: balance.toString(), realMoney: false };
  }

  async statement(userId: string, limit = 100) {
    const rows = await this.dbs.db.select({ e: ledgerEntries, t: ledgerTransactions })
      .from(ledgerEntries)
      .innerJoin(ledgerAccounts, eq(ledgerAccounts.id, ledgerEntries.accountId))
      .innerJoin(ledgerTransactions, eq(ledgerTransactions.id, ledgerEntries.transactionId))
      .where(and(eq(ledgerAccounts.userId, userId), eq(ledgerAccounts.mode, 'SANDBOX')))
      .orderBy(desc(ledgerEntries.id)).limit(Math.min(limit, 500));
    return rows.map(({ e, t }) => ({
      id: e.id, at: e.createdAt, type: t.type, amount: e.amount.toString(), balanceAfter: e.balanceAfter.toString(),
      referenceType: t.referenceType, referenceId: t.referenceId, metadata: t.metadata,
    }));
  }
}
