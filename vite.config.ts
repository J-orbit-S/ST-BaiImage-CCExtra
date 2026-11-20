import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const root = path.dirname(fileURLToPath(import.meta.url));

const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
  version?: string;
};
const version = String(packageJson.version ?? '0.0.0');

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(root, 'src'),
      // 上游 charTags/globalCharTags 只用到 reactive；用等价 shim 顶上，
      // 这样它们能被一字不改地搬运（原因见 src/shims/vue.ts）。
      vue: path.resolve(root, 'src/shims/vue.ts'),
    },
  },

  define: {
    __CCX_VERSION__: JSON.stringify(version),
  },

  build: {
    outDir: 'dist',
    // 只留 dist/index.js 一个产物：ST 按 manifest.json 的 `js` 加载它。
    emptyOutDir: true,
    target: 'esnext',
    minify: true,
    sourcemap: true,
    rollupOptions: {
      input: path.resolve(root, 'src/index.ts'),
      output: {
        format: 'es',
        entryFileNames: 'index.js',
        // 单文件产物：扩展目录里没有第二个 chunk，部署时不会漏拷
        codeSplitting: false,
      },
    },
  },

  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
