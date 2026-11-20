#!/usr/bin/env node
/**
 * 把构建产物同步到 SillyTavern 的扩展目录。
 *
 * 为什么要脚本而不是手拷：
 *   1. 手拷容易漏（改完 src 忘了 build，或只拷 index.js 忘了 manifest.json）；
 *   2. SillyTavern 加载的是 dist/index.js，直接拷 src/ 过去等于没改；
 *   3. 目标路径可能因 ST 安装位置不同而变，用环境变量覆盖比改代码好。
 *
 * 用法：
 *   npm run build && npm run sync:st
 *   ST_EXT_DIR="/d/SillyTavern/public/scripts/extensions/third-party" npm run sync:st
 *
 * 目标目录约定：<ST_EXT_DIR>/ST-BaiImage-CCExtra/
 *   ST_EXT_DIR 默认 G:/SillyTavern/public/scripts/extensions/third-party
 */

import { existsSync, mkdirSync, copyFileSync, statSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const extRoot =
  process.env.ST_EXT_DIR ?? 'G:/SillyTavern/public/scripts/extensions/third-party';
const target = join(extRoot, 'ST-BaiImage-CCExtra');

/** 只同步 ST 真正会用到的东西 + 给人看的文档。src/ 与测试不同步——那边不需要，也不该有第二份可改的源码。 */
const FILES = [
  'manifest.json',
  'dist/index.js',
  'README.md',
  'VENDORED.md',
  'docs/ENGINEERING.md',
  'docs/RETROSPECTIVE.md',
];

function fail(message) {
  console.error(`[sync:st] ${message}`);
  process.exit(1);
}

if (!existsSync(extRoot)) {
  fail(
    `找不到 SillyTavern 扩展目录：${extRoot}\n` +
      `  用 ST_EXT_DIR 指定，例如：\n` +
      `  ST_EXT_DIR="/d/SillyTavern/public/scripts/extensions/third-party" npm run sync:st`,
  );
}

if (!existsSync(join(root, 'dist/index.js'))) {
  fail('dist/index.js 不存在，先跑 npm run build');
}

mkdirSync(join(target, 'dist'), { recursive: true });
mkdirSync(join(target, 'docs'), { recursive: true });

const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
const builtAt = statSync(join(root, 'dist/index.js'));

for (const rel of FILES) {
  const from = join(root, rel);
  if (!existsSync(from)) fail(`源文件缺失：${rel}`);
  copyFileSync(from, join(target, rel));
}

const sizeKb = Math.round(builtAt.size / 1024);
console.log(`[sync:st] 已同步 ${manifest.display_name} v${manifest.version}（${sizeKb} KB）`);
console.log(`[sync:st] 目标：${target}`);
console.log('[sync:st] 回到 SillyTavern 刷新页面（Ctrl+F5）生效；控制台应出现 [CCX] 已加载');
