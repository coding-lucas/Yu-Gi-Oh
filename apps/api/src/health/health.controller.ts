import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { sql } from 'drizzle-orm';
import { Public } from '../common/auth';
import { DbService } from '../db/db.service';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly dbs: DbService) {}

  @Public()
  @Get()
  async health() {
    const t = Date.now();
    await this.dbs.db.execute(sql`SELECT 1`);
    return { status: 'ok', db: { latencyMs: Date.now() - t }, time: new Date().toISOString(), version: process.env.npm_package_version ?? '0.1.0' };
  }
}
