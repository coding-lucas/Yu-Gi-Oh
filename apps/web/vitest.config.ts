import { defineConfig } from 'vitest/config';
import path from 'node:path';
export default defineConfig({
  test: { include: ['test/**/*.test.ts'] },
  resolve: { alias: { '@athosbet/shared': path.resolve(__dirname, '../../packages/shared/src/index.ts'), '@': path.resolve(__dirname, 'src') } },
});
