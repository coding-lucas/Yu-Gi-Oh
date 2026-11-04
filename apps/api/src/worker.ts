import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { JobsService } from './jobs/jobs.service';
import { config } from './config';

/** Dedicated BullMQ worker process (horizontal scaling of sync / pricing / settlement). */
async function main() {
  if (!config().REDIS_URL) throw new Error('worker requires REDIS_URL');
  process.env.SCHEDULER_ENABLED = 'false';
  const app = await NestFactory.createApplicationContext(AppModule);
  app.get(JobsService).startWorker();
  app.enableShutdownHooks();
  console.log('AthosBet worker started');
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
