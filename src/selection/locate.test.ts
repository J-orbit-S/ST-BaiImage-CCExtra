import { describe, expect, it } from 'vitest';
import {
  countLines,
  expandToLineBounds,
  locateSelection,
  normalize,
} from '@/selection/locate';
import { buildCapture } from '@/selection/capture';
import { hashText } from '@/selection/hash';

describe('normalize', () => {
  it('strict 口径不丢任何字符，map 为恒等映射', () => {
    const raw = ' a *b*\n';
    const { text, map } = normalize(raw, 'strict');
    expect(text).toBe(raw);
    expect(map).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('normalized 只丢空白，且 map 指回原文下标', () => {
    const raw = '他 笑\n了';
    const { text, map } = normalize(raw, 'normalized');
    expect(text).toBe('他笑了');
    expect(map).toEqual([0, 2, 4]);
  });

  it('aggressive 丢 markdown 标记与装饰符', () => {
    const raw = '**粗** _斜_ • 项目';
    const { text } = normalize(raw, 'aggressive');
    expect(text).toBe('粗斜项目');
  });

  it('aggressive 把各种引号折成同一个字符，保持两侧可比', () => {
    expect(normalize('他说“走”', 'aggressive').text).toBe('他说"走"');
    expect(normalize('他说"走"', 'aggressive').text).toBe('他说"走"');
    expect(normalize('他说「走」', 'aggressive').text).toBe('他说"走"');
  });
});

describe('locateSelection — 命中', () => {
  it('逐字命中时用 strict，返回精确偏移', () => {
    const raw = '雨下得很大，他站在门外。';
    const result = locateSelection({ raw, domText: '他站在门外' });
    expect(result).toMatchObject({ ok: true, method: 'strict', candidates: 1 });
    if (!result.ok) throw new Error('unreachable');
    expect(raw.slice(result.start, result.end)).toBe('他站在门外');
  });

  it('选区带首尾空白也能命中（strict 会 trim）', () => {
    const raw = '雨下得很大，他站在门外。';
    const result = locateSelection({ raw, domText: '  他站在门外\n' });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(raw.slice(result.start, result.end)).toBe('他站在门外');
  });

  it('原文里段内换行、DOM 里是空格 —— normalized 命中', () => {
    const raw = '第一句。\n第二句很长。';
    // 渲染后 <br> 变成空白，选区里自然没有换行符
    const result = locateSelection({ raw, domText: '第一句。 第二句很长。' });
    expect(result).toMatchObject({ ok: true, method: 'normalized' });
    if (!result.ok) throw new Error('unreachable');
    expect(raw.slice(result.start, result.end)).toBe('第一句。\n第二句很长。');
  });

  it('整段被 markdown 包裹时 strict 就能命中（标记在两侧，不打断文本）', () => {
    const raw = '他突然**猛地回头**，看向门口。';
    const result = locateSelection({ raw, domText: '猛地回头' });
    expect(result).toMatchObject({ ok: true, method: 'strict' });
    if (!result.ok) throw new Error('unreachable');
    expect(raw.slice(result.start, result.end)).toBe('猛地回头');
  });

  it('标记插在词中间时 strict 失效，aggressive 命中', () => {
    const raw = '他突**猛**地回头，看向门口。';
    const result = locateSelection({ raw, domText: '猛地回头' });
    expect(result).toMatchObject({ ok: true, method: 'aggressive' });
    if (!result.ok) throw new Error('unreachable');
    // 区间落在原文上，跨越了被渲染掉的 ** 标记
    expect(raw.slice(result.start, result.end)).toBe('猛**地回头');
  });

  it('原文直引号 vs 渲染弯引号 —— aggressive 靠折叠命中', () => {
    const raw = '他低声说："别出声。"';
    const result = locateSelection({ raw, domText: '他低声说：“别出声。”' });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(raw.slice(result.start, result.end)).toBe('他低声说："别出声。"');
  });

  it('列表项渲染成 <li> 后丢失标记 —— aggressive 命中', () => {
    const raw = '- 门是锁着的\n- 窗也关着';
    const result = locateSelection({ raw, domText: '门是锁着的' });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(raw.slice(result.start, result.end)).toBe('门是锁着的');
  });

  it('CJK 与 emoji 混排时偏移按 UTF-16 计算且不串位', () => {
    const raw = '开头😀中间🐉结尾';
    const result = locateSelection({ raw, domText: '中间🐉结尾' });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(raw.slice(result.start, result.end)).toBe('中间🐉结尾');
  });
});

describe('locateSelection — 消歧', () => {
  const raw = '他笑了。\n她也笑了。\n他笑了。';

  it('同一句出现多次时用前文选出正确那处', () => {
    const result = locateSelection({
      raw,
      domText: '他笑了。',
      before: '他笑了。\n她也笑了。',
    });
    expect(result).toMatchObject({ ok: true, candidates: 2 });
    if (!result.ok) throw new Error('unreachable');
    // 必须命中最后那一处（前面还有"她也笑了。"）
    expect(result.start).toBe(raw.lastIndexOf('他笑了。'));
  });

  it('后文也能消歧：命中第一处', () => {
    const result = locateSelection({
      raw,
      domText: '他笑了。',
      after: '她也笑了。\n他笑了。',
    });
    if (!result.ok) throw new Error('unreachable');
    expect(result.start).toBe(0);
  });

  it('前后文都分不清时报 ambiguous，绝不猜', () => {
    const result = locateSelection({ raw, domText: '他笑了。' });
    expect(result).toMatchObject({ ok: false, reason: 'ambiguous', candidates: 2 });
  });

  it('原文里根本没有时报 not-found', () => {
    const result = locateSelection({ raw, domText: '她哭了。' });
    expect(result).toMatchObject({ ok: false, reason: 'not-found' });
  });

  it('空选区报 empty', () => {
    expect(locateSelection({ raw, domText: '   ' })).toMatchObject({
      ok: false,
      reason: 'empty',
    });
  });
});

describe('expandToLineBounds', () => {
  const raw = '第一行\n第二行内容\n第三行';

  it('行内片段扩到整行', () => {
    const start = raw.indexOf('二行');
    const result = expandToLineBounds(raw, start, start + 2);
    expect(result.expanded).toBe(true);
    expect(raw.slice(result.start, result.end)).toBe('第二行内容');
  });

  it('整行选区不产生多余扩张', () => {
    const start = raw.indexOf('第二行');
    const result = expandToLineBounds(raw, start, start + 5);
    expect(result.expanded).toBe(false);
    expect(raw.slice(result.start, result.end)).toBe('第二行内容');
  });

  it('跨行选区覆盖全部涉及行，且不吞换行符', () => {
    const start = raw.indexOf('一行');
    const end = raw.indexOf('内容') + 2;
    const result = expandToLineBounds(raw, start, end);
    expect(raw.slice(result.start, result.end)).toBe('第一行\n第二行内容');
  });

  it('CRLF 不被切断', () => {
    const crlf = '甲行\r\n乙行\r\n丙行';
    const start = crlf.indexOf('乙');
    const result = expandToLineBounds(crlf, start, start + 2);
    expect(crlf.slice(result.start, result.end)).toBe('乙行');
    // 区间两端必须停在 \r 或 \n 上，不能停在 \r 与 \n 之间
    expect(crlf[result.end]).toBe('\r');
  });

  it('末行没有换行符时收缩到文本末尾', () => {
    const result = expandToLineBounds(raw, raw.length - 1, raw.length);
    expect(result.end).toBe(raw.length);
  });

  it('越界入参被夹到合法范围', () => {
    const result = expandToLineBounds(raw, -10, 99999);
    expect(result.start).toBe(0);
    expect(result.end).toBe(raw.length);
  });
});

describe('buildCapture', () => {
  const raw = '第一段\n\n第二段内容\n\n第三段';

  it('扩到整行并打包指纹、行数、方法', () => {
    const start = raw.indexOf('段内');
    const outcome = buildCapture({
      raw,
      messageId: 7,
      swipeId: 2,
      domText: '段内',
      located: { start, end: start + 2, method: 'normalized', candidates: 1 },
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('unreachable');
    expect(outcome.capture.text).toBe('第二段内容');
    expect(outcome.capture.lineCount).toBe(1);
    expect(outcome.capture.expanded).toBe(true);
    expect(outcome.capture.messageId).toBe(7);
    expect(outcome.capture.swipeId).toBe(2);
    expect(outcome.capture.sourceHash).toBe(hashText(raw));
  });

  it('跨多行时 lineCount 如实统计', () => {
    const start = raw.indexOf('第一段');
    const end = raw.indexOf('内容') + 2;
    const outcome = buildCapture({
      raw,
      messageId: 0,
      swipeId: 0,
      domText: 'x',
      located: { start, end, method: 'strict', candidates: 1 },
    });
    if (!outcome.ok) throw new Error('unreachable');
    expect(outcome.capture.lineCount).toBe(3); // 第一段 / 空行 / 第二段内容
  });

  it('落在空行上时判为 empty-selection，而不是产出一个空快照', () => {
    const outcome = buildCapture({
      raw,
      messageId: 0,
      swipeId: 0,
      domText: ' ',
      located: { start: 4, end: 4, method: 'strict', candidates: 1 },
    });
    expect(outcome).toMatchObject({ ok: false, reason: 'empty-selection' });
  });

  it('归一化后太短时判为 too-short（防误触双击选词）', () => {
    const outcome = buildCapture({
      raw: 'a\nbcdef',
      messageId: 0,
      swipeId: 0,
      domText: 'a',
      located: { start: 0, end: 1, method: 'strict', candidates: 1 },
    });
    expect(outcome).toMatchObject({ ok: false, reason: 'too-short' });
  });
});

describe('countLines / hashText', () => {
  it('countLines 兼容 LF 与 CRLF', () => {
    expect(countLines('a')).toBe(1);
    expect(countLines('a\nb')).toBe(2);
    expect(countLines('a\r\nb\r\nc')).toBe(3);
    expect(countLines('')).toBe(0);
  });

  it('hashText 同文本稳定、异文本不同（含长度参与）', () => {
    expect(hashText('abc')).toBe(hashText('abc'));
    expect(hashText('abc')).not.toBe(hashText('abd'));
    expect(hashText('abc')).not.toBe(hashText('abcabc'));
  });
});
