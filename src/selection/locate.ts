/**
 * 划线定位核心：把「DOM 里看到的选中文字」映射回「消息原文 mes 的字符区间」。
 *
 * 为什么需要这一层而**不能直接用选区文字**：
 * 柏宝绘的分析链路吃的是 `message.mes`（原文），而用户划选的是 ST 渲染后的 DOM 文本。
 * 两者并不逐字相同——渲染过程会吃掉 markdown 标记（`**粗**` → `粗`）、把 `<hr>` 变成空、
 * 把列表符号换成装饰符、合并/新增空白。直接拿 DOM 文字去原文里 indexOf，命不中是常态。
 *
 * 但这层**必须做到零猜测**：定位错了，tag 会插到别的段落，图就画错场景，且用户很难发现。
 * 所以策略是分级从严到宽，任一级只要不唯一就继续放宽，全都不唯一就报 ambiguous 让调用方
 * 中止——宁可不出图，也不插错位置。
 *
 * 三级口径：
 *   strict      —— 原文里逐字找（选区没跨任何 markdown 时命中）
 *   normalized  —— 忽略全部空白（段落折行、渲染追加的空格）
 *   aggressive  —— 再忽略 markdown 控制符与列表装饰符，并把各家引号/破折号折叠成同一字符
 *
 * 归一化时同步维护 `map`（归一化后第 i 个字符 → 原文第几个字符），这样命中位置能原样还原
 * 成原文偏移，而不是还原成归一化文本里的偏移（那是最经典的 off-by-N 陷阱）。
 *
 * 多命中时用「选区前后文」打分：原文里候选位置之前的文本与 DOM 里选区之前的文本，
 * 公共后缀越长越可信；候选之后的文本与选区之后的文本，公共前缀越长越可信。
 * 最高分并列 = 真的分不清 = ambiguous。
 */

export type MatchMethod = 'strict' | 'normalized' | 'aggressive';

/** 从严到宽依次尝试，顺序不可调整（宽口径会吞掉窄口径能区分的差异）。 */
const MODES: readonly MatchMethod[] = ['strict', 'normalized', 'aggressive'];

/** markdown / 排版控制符：渲染后不留在 textContent 里，归一化时两侧一起丢，保持对称。 */
const MARKUP_CHARS = new Set(Array.from('*_~`#>|[]()\\'));

/** 列表与分隔装饰符：渲染器会把 `- item` 变成 `<li>`，textContent 里可能多出这类字符。 */
const DECORATION_CHARS = new Set(Array.from('•◦▪‣·※―—–'));

/** 引号折叠表：同一「意思」的字符在原文与 DOM 里可能是不同码位，折成同一个才能比。 */
const FOLD: Record<string, string> = {
  '\u201c': '"',
  '\u201d': '"',
  '\u201e': '"',
  '\u201f': '"',
  '\u300c': '"',
  '\u300d': '"',
  '\u300e': '"',
  '\u300f': '"',
  '\u2018': "'",
  '\u2019': "'",
  '\u201a': "'",
  '\u201b': "'",
};

export interface Normalized {
  /** 归一化后的文本。 */
  text: string;
  /** 归一化文本第 i 个字符在原文中的下标；长度与 text 相等。 */
  map: number[];
}

/**
 * 按指定口径归一化。
 * strict 仍走同一套循环（不丢任何字符），这样三种口径共用一份「命中 → 原文偏移」的还原逻辑，
 * 少一条分支就少一类只在某一级才出现的 bug。
 */
export function normalize(raw: string, mode: MatchMethod): Normalized {
  if (mode === 'strict') {
    const map: number[] = new Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) map[i] = i;
    return { text: raw, map };
  }

  const chars: string[] = [];
  const map: number[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (/\s/.test(ch)) continue;
    if (mode === 'aggressive') {
      if (MARKUP_CHARS.has(ch) || DECORATION_CHARS.has(ch)) continue;
      const folded = FOLD[ch];
      if (folded !== undefined) {
        chars.push(folded);
        map.push(i);
        continue;
      }
    }
    chars.push(ch);
    map.push(i);
  }
  return { text: chars.join(''), map };
}

/** 所有出现位置（含重叠位置起步的下一位置，避免 needle="aa" 在 "aaa" 里漏一处）。 */
function findAll(haystack: string, needle: string): number[] {
  const hits: number[] = [];
  if (!needle) return hits;
  let at = haystack.indexOf(needle);
  while (at >= 0) {
    hits.push(at);
    at = haystack.indexOf(needle, at + 1);
  }
  return hits;
}

function commonSuffix(a: string, b: string, cap: number): number {
  let n = 0;
  while (n < cap && n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n += 1;
  return n;
}

function commonPrefix(a: string, b: string, cap: number): number {
  let n = 0;
  while (n < cap && n < a.length && n < b.length && a[n] === b[n]) n += 1;
  return n;
}

export interface LocateInput {
  /** 消息原文（message.mes）。 */
  raw: string;
  /** 用户选中的文字（DOM 侧 range.toString()）。 */
  domText: string;
  /** 选区之前、同一渲染容器内的文本（用于消歧）。 */
  before?: string;
  /** 选区之后、同一渲染容器内的文本（用于消歧）。 */
  after?: string;
  /** 消歧时最多比多少字符的上下文。默认 200。 */
  contextChars?: number;
}

export type LocateResult =
  | {
      ok: true;
      /** 原文偏移（未扩行，仍可能是行中点）。 */
      start: number;
      end: number;
      method: MatchMethod;
      /** 该口径下原文里共有几处命中（>1 说明是靠上下文选出来的）。 */
      candidates: number;
    }
  | {
      ok: false;
      reason: 'empty' | 'not-found' | 'ambiguous';
      /** 诊断用：最多见过几处候选。 */
      candidates: number;
    };

/**
 * 在原文中定位选区。返回的是**未扩行**的精确区间；扩行交给 expandToLineBounds。
 * 不在这里合并两者，是因为诊断时需要知道「用户到底选中了行内哪一段」。
 */
export function locateSelection(input: LocateInput): LocateResult {
  const raw = String(input.raw ?? '');
  const domText = String(input.domText ?? '');
  const cap = input.contextChars ?? 200;
  const beforeRaw = String(input.before ?? '');
  const afterRaw = String(input.after ?? '');

  if (!raw || !domText.trim()) return { ok: false, reason: 'empty', candidates: 0 };

  let ambiguous = false;
  let maxCandidates = 0;

  for (const mode of MODES) {
    // strict 例外：选区首尾常带渲染空白，先 trim；其余口径丢空白，trim 与否等价。
    const needleSource = mode === 'strict' ? domText.trim() : domText;
    const hay = normalize(raw, mode);
    const needle = normalize(needleSource, mode).text;
    if (!needle) continue;

    const hits = findAll(hay.text, needle);
    if (!hits.length) continue;
    maxCandidates = Math.max(maxCandidates, hits.length);

    const toRange = (at: number): { start: number; end: number } => ({
      start: hay.map[at],
      // 末字符在原文里的下标 + 1。归一化把多个原文位置折到同一字符时，取最后一个，
      // 这样区间能覆盖被折掉的原字符（引号、标记），不会把它们甩到区间外。
      end: hay.map[at + needle.length - 1] + 1,
    });

    if (hits.length === 1) {
      const { start, end } = toRange(hits[0]);
      return { ok: true, start, end, method: mode, candidates: 1 };
    }

    // 多命中：上下文打分
    const beforeText = normalize(beforeRaw, mode).text;
    const afterText = normalize(afterRaw, mode).text;
    const scored = hits.map(at => ({
      at,
      score:
        commonSuffix(beforeText, hay.text.slice(0, at), cap) +
        commonPrefix(afterText, hay.text.slice(at + needle.length), cap),
    }));
    scored.sort((a, b) => b.score - a.score);

    const best = scored[0];
    const runnerUp = scored[1];
    if (best.score > 0 && best.score > (runnerUp?.score ?? -1)) {
      const { start, end } = toRange(best.at);
      return { ok: true, start, end, method: mode, candidates: hits.length };
    }
    // 分不清：记下 ambiguous，继续放宽——更宽的口径有时反而因为合并了差异而唯一。
    ambiguous = true;
  }

  return { ok: false, reason: ambiguous ? 'ambiguous' : 'not-found', candidates: maxCandidates };
}

/**
 * 把区间扩到完整物理行。
 *
 * 为什么必须扩：分析链路按「物理行」切段（clean.ts 的 prepareTargetText），
 * 只选半行的结果会让模型看到半句话，且写回时 tag 可能落在句子中间。
 * 语义上「划半行 = 想画这一行」。
 *
 * 换行符本身不并进区间（`\r\n` 保持原样归属），区间只覆盖行内容。
 */
export function expandToLineBounds(
  raw: string,
  start: number,
  end: number,
): { start: number; end: number; expanded: boolean } {
  const clampedStart = Math.max(0, Math.min(start, raw.length));
  const clampedEnd = Math.max(clampedStart, Math.min(end, raw.length));
  let from = clampedStart;
  let to = clampedEnd;
  while (from > 0 && raw[from - 1] !== '\n' && raw[from - 1] !== '\r') from -= 1;
  while (to < raw.length && raw[to] !== '\n' && raw[to] !== '\r') to += 1;
  return { start: from, end: to, expanded: from !== clampedStart || to !== clampedEnd };
}

/** 区间跨了几个物理行（用于 UI 提示「将分析 3 行」）。 */
export function countLines(text: string): number {
  if (!text) return 0;
  const newlines = text.match(/\r\n|\n|\r/g);
  return (newlines?.length ?? 0) + 1;
}
