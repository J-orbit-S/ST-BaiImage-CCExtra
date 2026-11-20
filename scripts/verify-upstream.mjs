/**
 * 上游漂移检测（工程方案 §7.4）
 * 逐文件比对 CCExtra vendored 文件与上游 ST-BaiBai-Image 的 SHA256。
 * 上游路径由 --upstream <path> 指定，默认读 VENDORED.md 里记录的锚点目录提示。
 *
 * 用法：npm run verify:upstream -- --upstream "C:/.../ST-BaiBai-Image"
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const args = process.argv.slice(2);
const upstreamIdx = args.indexOf('--upstream');
// 支持 --upstream <path>，或环境变量 BAIBAI_UPSTREAM（便于 npm run verify:upstream 直接用）。
const upstreamRoot = upstreamIdx >= 0 ? args[upstreamIdx + 1] : process.env.BAIBAI_UPSTREAM;
if (!upstreamRoot) {
  console.error('用法: node scripts/verify-upstream.mjs --upstream <上游仓库根目录>');
  console.error('  或: BAIBAI_UPSTREAM=<上游仓库根目录> node scripts/verify-upstream.mjs');
  process.exit(2);
}
const upstreamSrc = path.resolve(upstreamRoot, 'src');
const localSrc = path.resolve(process.cwd(), 'src');

// 逐字复制清单：CCExtra 路径 -> 上游路径。stub 不在此列。
const VENDORED = [
  ['autoTag/clean.ts', 'autoTag/clean.ts'],
  ['autoTag/protocol.ts', 'autoTag/protocol.ts'],
  ['autoTag/rebase.ts', 'autoTag/rebase.ts'],
  ['autoTag/slotPlan.ts', 'autoTag/slotPlan.ts'],
  ['st/imageTagRegex.ts', 'st/imageTagRegex.ts'],
  ['st/context.ts', 'st/context.ts'],
  ['backends/size.ts', 'backends/size.ts'],
  ['backends/mossLayout.ts', 'backends/mossLayout.ts'],
  ['autoTag/clean.test.ts', 'autoTag/clean.test.ts'],
  ['autoTag/slotPlan.test.ts', 'autoTag/slotPlan.test.ts'],
  ['backends/size.test.ts', 'backends/size.test.ts'],
  ['backends/mossLayout.test.ts', 'backends/mossLayout.test.ts'],
  ['st/context.test.ts', 'st/context.test.ts'],
  ['autoTag/rebase.test.ts', 'autoTag/rebase.test.ts'],
  ['autoTag/protocol.test.ts', 'autoTag/protocol.test.ts'],
  ['st/imageTagRegex.test.ts', 'st/imageTagRegex.test.ts'],
];

const naiExtract = [
  // nai.ts 是「逐字抽取函数体」，非整文件复制，只核对被抽片段的源码串是否仍逐字存在。
  ['backends/nai.ts', 'backends/nai.ts', [
    "return model.includes('nai-diffusion-5');",
    "return model.includes('nai-diffusion-4-5');",
    'return isNai45(model) || isNai5(model);',
  ]],
];

const sha = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

let bad = 0;
console.log('=== Vendored 逐字文件 SHA256 比对 ===');
for (const [local, remote] of VENDORED) {
  const a = path.join(upstreamSrc, remote);
  const b = path.join(localSrc, local);
  if (!fs.existsSync(a) || !fs.existsSync(b)) {
    console.log(`MISSING  ${local}`); bad++; continue;
  }
  const ok = sha(a) === sha(b);
  console.log(`${ok ? 'MATCH  ' : 'DIFF!  '}${local}`);
  if (!ok) bad++;
}

console.log('=== nai.ts 抽取片段核对 ===');
for (const [local, remote, snippets] of naiExtract) {
  const up = fs.readFileSync(path.join(upstreamSrc, remote), 'utf8');
  const lo = fs.readFileSync(path.join(localSrc, local), 'utf8');
  for (const s of snippets) {
    const inUp = up.includes(s);
    const inLo = lo.includes(s);
    console.log(`${inUp && inLo ? 'MATCH  ' : 'DIFF!  '}${local} :: ${s}`);
    if (!inUp || !inLo) bad++;
  }
}

// 内置提示词常量：settingsDefaults.ts 是脚本生成的，必须每个常量都能在上游逐字找到。
const defaultsFile = path.join(localSrc, 'state/settingsDefaults.ts');
if (fs.existsSync(defaultsFile)) {
  console.log('=== 内置提示词常量逐字核对（settingsDefaults.ts）===');
  const ours = fs.readFileSync(defaultsFile, 'utf8');
  const upstreamSettings = fs.readFileSync(path.join(upstreamSrc, 'state/settings.ts'), 'utf8');
  const names = [...ours.matchAll(/^export const (DEFAULT_[A-Z0-9_]+) = `/gm)].map(m => m[1]);
  if (names.length !== 10) {
    console.log(`DIFF!  预期 10 个 DEFAULT_ 常量，实际 ${names.length} 个`);
    bad++;
  }
  for (const name of names) {
    const block = extractTemplateConst(ours, name);
    const ok = block !== null && upstreamSettings.includes(block);
    console.log(`${ok ? 'MATCH  ' : 'DIFF!  '}${name}`);
    if (!ok) bad++;
  }
}

/** 从源码里切出 `export const NAME = \`...\`;` 的完整片段；切不出来返回 null。 */
function extractTemplateConst(text, name) {
  const marker = `export const ${name} = `;
  const start = text.indexOf(marker);
  if (start < 0) return null;
  const open = text.indexOf('`', start);
  if (open < 0) return null;
  let i = open + 1;
  while (i < text.length) {
    if (text[i] === '\\') {
      i += 2;
      continue;
    }
    if (text[i] === '`') break;
    i += 1;
  }
  if (i >= text.length) return null;
  let end = i + 1;
  if (text[end] === ';') end += 1;
  return text.slice(start, end);
}

if (bad) {
  console.error(`\n失败：${bad} 处不一致。若上游已升级，请先跑黄金对拍确认协议是否变化，再决定同步。`);
  process.exit(1);
}
console.log('\n全部一致。');
