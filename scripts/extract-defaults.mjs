/**
 * 从上游 settings.ts 逐字抽取内置提示词常量，生成 src/state/settingsDefaults.ts。
 *
 * 为什么要脚本抽取而不是手抄：这 10 份提示词合计约 700 行，手抄一个字不一样
 * 就会让「LLM 分析过程与柏宝绘一模一样」当场失效，而且肉眼查不出来。
 * 抽取后由 verify-upstream.mjs 用「子串必须逐字存在」反向校验。
 *
 * 用法：node scripts/extract-defaults.mjs --upstream <上游仓库根目录>
 */
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const idx = args.indexOf('--upstream');
const upstreamRoot = idx >= 0 ? args[idx + 1] : process.env.BAIBAI_UPSTREAM;
if (!upstreamRoot) {
  console.error('用法: node scripts/extract-defaults.mjs --upstream <上游仓库根目录>');
  process.exit(2);
}

const upstreamFile = path.resolve(upstreamRoot, 'src/state/settings.ts');
const source = fs.readFileSync(upstreamFile, 'utf8');

/**
 * 逐个常量抽取：从 `export const NAME = \`` 起，扫到第一个**未转义**的反引号，
 * 再吃掉紧跟的分号，即为该常量完整定义。
 * 不能用「连续区间」抽取——上游这些常量之间夹着 UiPrefs / ApiChannel 等接口定义，
 * 连续切会把它们一起吞进来（首版就是这么错的）。
 */
function extractConst(name) {
  const marker = `export const ${name} = `;
  const start = source.indexOf(marker);
  if (start < 0) {
    console.error(`抽取失败：上游找不到 ${name}。上游结构可能已变，请人工确认后更新本脚本。`);
    process.exit(1);
  }
  const open = source.indexOf('`', start);
  if (open < 0 || open - start > marker.length + 2) {
    console.error(`抽取失败：${name} 不是以模板字符串定义（预期紧跟反引号）。`);
    process.exit(1);
  }
  let i = open + 1;
  while (i < source.length) {
    if (source[i] === '\\') {
      i += 2;
      continue;
    }
    if (source[i] === '`') break;
    i += 1;
  }
  if (i >= source.length) {
    console.error(`抽取失败：${name} 的模板字符串没有闭合。`);
    process.exit(1);
  }
  let end = i + 1;
  if (source[end] === ';') end += 1;
  return source.slice(start, end);
}

const NAMES = [
  'DEFAULT_JAILBREAK_PROMPT',
  'DEFAULT_COMFY_SPEC',
  'DEFAULT_COMFY_NL_SPEC',
  'DEFAULT_NAI_SPEC',
  'DEFAULT_COMFY_THINKING',
  'DEFAULT_NAI_THINKING',
  'DEFAULT_NAI_V5_THINKING',
  'DEFAULT_NAI_V5_SPEC',
  'DEFAULT_COMFY_COMIC_SPEC',
  'DEFAULT_COMFY_COMIC_THINKING',
];

const blocks = NAMES.map(name => `/** 逐字抽取自上游 ${name}（勿改）。 */\n${extractConst(name)}`);
const body = blocks.join('\n\n');

const header = `// ⚠ 本文件由 scripts/extract-defaults.mjs 从上游自动生成，请勿手改。
// 来源：ST-BaiBai-Image src/state/settings.ts（锚点见 VENDORED.md）
// 内容：10 份内置提示词常量，逐个逐字抽取，未做任何改写。
// 校验：npm run verify:upstream 会检查每个常量是否仍逐字存在于上游。
`;

const out = `${header}\n${body}\n`;
const outPath = path.resolve(process.cwd(), 'src/state/settingsDefaults.ts');
fs.writeFileSync(outPath, out, 'utf8');

console.log(`已生成 src/state/settingsDefaults.ts`);
console.log(`  抽取常量 ${NAMES.length} 个`);
console.log(`  行数 ${out.split('\n').length}，字节 ${Buffer.byteLength(out, 'utf8')}`);
