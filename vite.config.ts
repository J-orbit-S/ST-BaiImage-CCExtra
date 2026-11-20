import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(root, 'src'),
      // 上游 charTags/globalCharTags 只用到 reactive；用等价 shim 顶上，
      // 这样它们能被一字不改地搬运（原因见 src/shims/vue.ts）。
      vue: path.resolve(root, 'src/shims/vue.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
