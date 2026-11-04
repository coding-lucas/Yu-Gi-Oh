import { defineConfig } from 'vitest/config';
import path from 'node:path';
export default defineConfig({
  resolve: { alias: { '@athosbet/shared': path.resolve(__dirname, '../shared/src/index.ts') } },
});
