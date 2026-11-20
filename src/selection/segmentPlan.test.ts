import { describe, expect, it } from 'vitest';
import { injectImageTags, type ImageInsertion } from '@/autoTag/protocol';
import type { SelectionCapture } from '@/selection/capture';
import { hashText } from '@/selection/hash';
import { countLines, expandToLineBounds } from '@/selection/locate';
import { lineIndexAt, maskImageTags, computeSlotShifts, planSelection, resolveWriteback, toAbsoluteImages } from '@/selection/segmentPlan';

/** 造一份捕获快照：直接给原文区间，跳过 DOM，但保留「扩到整行」这一步（与真实捕获一致）。 */
function captureOf(mes: string, start: number, end: number): SelectionCapture {
  const bounds = expandToLineBounds(mes, start, end);
  return {
    messageId: 3,
    swipeId: 0,
    sourceHash: hashText(mes),
    range: { start: bounds.start, end: bounds.end },
    text: mes.slice(bounds.start, bounds.end),
    domText: mes.slice(start, end),
    method: 'strict',
    candidates: 1,
    expanded: bounds.expanded,
    lineCount: countLines(mes.slice(bounds.start, bounds.end)),
  };
}

function imageAt(sourceLine: number): ImageInsertion {
  return {
    position: 'P1',
    sourceLine,
    tag: '1girl, solo',
    nl: '',
    negative: '',
    characters: [],
    size: 'portrait',
  };
}

describe('lineIndexAt', () => {
  it('LF 行号', () => {
    const text = 'a\nb\nc';
    expect(lineIndexAt(text, 0)).toBe(0);
    expect(lineIndexAt(text, 2)).toBe(1);
    expect(lineIndexAt(text, 4)).toBe(2);
  });

  it('CRLF 只算一行', () => {
    const text = 'a\r\nb\r\nc';
    expect(lineIndexAt(text, 0)).toBe(0);
    expect(lineIndexAt(text, 3)).toBe(1);
    expect(lineIndexAt(text, 6)).toBe(2);
  });
});

describe('planSelection', () => {
  const mes = '第一段。\n\n第二段内容。\n\n第三段。';

  it('单行切片换算成整楼绝对行号', () => {
    const start = mes.indexOf('第二段');
    const outcome = planSelection(captureOf(mes, start, start + 5), mes, []);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('unreachable');
    expect(outcome.plan.absoluteSegments).toHaveLength(1);
    expect(outcome.plan.absoluteSegments[0].sourceLine).toBe(2);
    // 切片视角的行号从 0 起
    expect(outcome.plan.sliceSegments[0].sourceLine).toBe(0);
    expect(outcome.plan.divergent).toBe(false);
    expect(outcome.plan.promptText).toContain('第二段内容。');
  });

  it('多行切片逐段换算，顺序与相对位置都不乱', () => {
    const start = mes.indexOf('第一段');
    const end = mes.indexOf('第三段') + 4;
    const outcome = planSelection(captureOf(mes, start, end), mes, []);
    if (!outcome.ok) throw new Error('unreachable');
    expect(outcome.plan.sliceSegments.map(s => s.sourceLine)).toEqual([0, 2, 4]);
    expect(outcome.plan.absoluteSegments.map(s => s.sourceLine)).toEqual([0, 2, 4]);
  });

  it('正文已被改过时判 stale，绝不用过期快照', () => {
    const cap = captureOf(mes, 0, 4);
    const outcome = planSelection(cap, `${mes}\n新增一行`, []);
    expect(outcome).toMatchObject({ ok: false, reason: 'stale' });
  });

  it('切片落在噪声块里、与整楼清洗不一致时报 line-mismatch 而不是硬算', () => {
    // 整楼包在 <think> 里，整楼清洗后一行不剩；切片单独清洗却会保留文字
    const wrapped = '<think>\n内心独白\n</think>';
    const start = wrapped.indexOf('内心独白');
    const outcome = planSelection(captureOf(wrapped, start, start + 4), wrapped, []);
    expect(outcome).toMatchObject({ ok: false, reason: 'line-mismatch' });
  });
});

describe('toAbsoluteImages', () => {
  const mes = '甲行。\n乙行。\n丙行。';

  it('按切片行号换回整楼行号', () => {
    const start = mes.indexOf('乙行');
    const outcome = planSelection(captureOf(mes, start, start + 3), mes, []);
    if (!outcome.ok) throw new Error('unreachable');
    const images = toAbsoluteImages(outcome.plan, [imageAt(0)]);
    expect(images?.[0].sourceLine).toBe(1);
  });

  it('模型给出的行号对不上任何切片段时整批返回 null', () => {
    const start = mes.indexOf('乙行');
    const outcome = planSelection(captureOf(mes, start, start + 3), mes, []);
    if (!outcome.ok) throw new Error('unreachable');
    expect(toAbsoluteImages(outcome.plan, [imageAt(99)])).toBeNull();
  });
});

describe('resolveWriteback — 重复行不错位（本层存在的理由）', () => {
  // 一楼里有两行完全一样：rebase 单靠文本会把两处混为一谈
  const mes = '他笑了。\n她也笑了。\n他笑了。';

  it('划中第二处「他笑了。」时，tag 必须落在第二处', () => {
    const secondAt = mes.lastIndexOf('他笑了。');
    const cap = captureOf(mes, secondAt, secondAt + 4);
    const planned = planSelection(cap, mes, []);
    if (!planned.ok) throw new Error('unreachable');
    expect(planned.plan.absoluteSegments[0].sourceLine).toBe(2);

    const resolved = resolveWriteback(planned.plan, mes, [imageAt(0)], []);
    expect(resolved).toMatchObject({ ok: true, mode: 'direct' });
    if (!resolved.ok) throw new Error('unreachable');
    expect(resolved.images[0].sourceLine).toBe(2);

    const injected = injectImageTags(mes, resolved.images);
    const lines = injected.split('\n');
    expect(lines[0]).toBe('他笑了。'); // 第一处不该被动
    expect(lines[2]).toBe('他笑了。'); // 原文不动，tag 另起一行追加在其后
    expect(lines[3]).toContain('1girl, solo');
  });

  it('对照：只按切片行号注入会插到第一处（证明换算层不可省）', () => {
    // 直接把切片行号当整楼行号用 —— 这正是"跳过换算层"会踩的坑
    const wrong = injectImageTags(mes, [imageAt(0)]);
    const lines = wrong.split('\n');
    expect(lines[1]).toContain('1girl, solo'); // 插在了第一处之后
    expect(lines[3]).toBe('他笑了。'); // 真正该插的第三行没被标到
  });
});

describe('resolveWriteback — 正文被改过时回落 rebase', () => {
  const mes = '第一段。\n\n第二段内容。\n\n第三段。';

  it('无关段落被改写时，靠文本锚定仍落在原行', () => {
    const start = mes.indexOf('第二段');
    const cap = captureOf(mes, start, start + 5);
    const planned = planSelection(cap, mes, []);
    if (!planned.ok) throw new Error('unreachable');

    // 第三个插件把第一段重写了（与画面无关）
    const changed = mes.replace('第一段。', '第一段被彻底改写成了别的样子。');
    const resolved = resolveWriteback(planned.plan, changed, [imageAt(0)], []);
    expect(resolved).toMatchObject({ ok: true, mode: 'rebased' });
    if (!resolved.ok) throw new Error('unreachable');

    const lines = injectImageTags(changed, resolved.images).split('\n');
    expect(lines[2]).toBe('第二段内容。');
    expect(lines[3]).toContain('1girl, solo');
    expect(resolved.report?.anchored).toBe(1);
  });

  it('正文被清空到没有叙事行时拒绝写回，而不是瞎插', () => {
    const start = mes.indexOf('第二段');
    const cap = captureOf(mes, start, start + 5);
    const planned = planSelection(cap, mes, []);
    if (!planned.ok) throw new Error('unreachable');
    const resolved = resolveWriteback(planned.plan, '   \n\n  ', [imageAt(0)], []);
    expect(resolved).toMatchObject({ ok: false, reason: 'rebase-failed' });
  });
});

/**
 * 2026-11-20 用户实测反馈：楼里已有 `<bbi_image>` 时划线出图，模型会「识别到」旧 tag，
 * 把它的提示词当成正文抄进新 tag；同时因为新 tag 插在旧 tag 之前，旧图的槽位序号被挤动，
 * 卡片显示成「旧提示词」、旧图被新卡顶掉。
 *
 * 这一组钉住的是前一半：旧 tag 必须**不进模型、也不打乱坐标**。
 * 后一半（槽位迁移）在 state/imageSlots.test.ts 与 runSelection.test.ts。
 */
describe('既有生图 tag：涂白不删行（行号是一切坐标的基准）', () => {
  const OLD = '<bbi_image>1girl, doorway<size>portrait</size></bbi_image>';
  const mes = ['第一段。', OLD, '她推开门，灯闪了一下。', '“你回来了。”'].join('\n');

  it('maskImageTags 只涂白：长度、换行、行数一个都不变', () => {
    const masked = maskImageTags(mes);
    expect(masked.length).toBe(mes.length);
    expect(masked.split('\n')).toHaveLength(mes.split('\n').length);
    expect(masked).not.toContain('bbi_image');
    expect(masked).not.toContain('1girl');
    // 行文本只剩正文
    expect(masked.split('\n')[0]).toBe('第一段。');
    expect(masked.split('\n')[1].trim()).toBe('');
    expect(masked.split('\n')[2]).toBe('她推开门，灯闪了一下。');
  });

  it('落单的半截标签也涂掉（AI 只写了一半时不能留给模型看）', () => {
    expect(maskImageTags('前文</bbi_image>后文')).not.toContain('bbi_image');
    expect(maskImageTags('前文</bbi_image>后文')).toHaveLength('前文</bbi_image>后文'.length);
  });

  it('切片含旧 tag 时，目标文本里没有它，也不会生成指向那一行的位置 ID', () => {
    const start = mes.indexOf('第一段');
    // 只选到 tag 那一行的行尾（再往下一格就会被「扩到整行」带上下一段）
    const end = mes.indexOf('她推开门') - 1;
    const outcome = planSelection(captureOf(mes, start, end), mes, []);
    if (!outcome.ok) throw new Error('unreachable');

    expect(outcome.plan.promptText).not.toContain('bbi_image');
    expect(outcome.plan.promptText).not.toContain('1girl');
    // 只剩正文那一行一个段，tag 行被过滤掉
    expect(outcome.plan.sliceSegments).toHaveLength(1);
    expect(outcome.plan.promptText).toContain('第一段。');
    // 行号照旧（0 = 整楼第一行），没有被涂白/过滤挤动
    expect(outcome.plan.absoluteSegments[0].sourceLine).toBe(0);
    // 含 tag 不再被误判成「切片与整楼清洗口径分歧」
    expect(outcome.plan.divergent).toBe(false);
  });

  it('切片不含 tag 时行为不变（tag 在楼下，模型看不见也照旧）', () => {
    const start = mes.indexOf('她推开门');
    const outcome = planSelection(captureOf(mes, start, start + 5), mes, []);
    if (!outcome.ok) throw new Error('unreachable');
    expect(outcome.plan.promptText).not.toContain('bbi_image');
    expect(outcome.plan.absoluteSegments[0].sourceLine).toBe(2);
  });

  it('computeSlotShifts：插入点在既有 tag 之前才需要后移', () => {
    // mes 的 tag 在第 1 行
    expect(computeSlotShifts(mes, [0])).toEqual([1]); // 插在上方 → 旧 tag 后移 1
    expect(computeSlotShifts(mes, [2])).toEqual([0]); // 插在下方 → 不动
    expect(computeSlotShifts(mes, [1])).toEqual([0]); // 与 tag 同行 → 追加在其后，不动
    expect(computeSlotShifts(mes, [0, 0])).toEqual([2]); // 上方插两个 → 后移 2
  });

  it('computeSlotShifts：多条既有 tag 各自算自己的位移', () => {
    const two = ['甲。', OLD, '乙。', OLD, '丙。'].join('\n');
    // tag 在第 1、3 行；插入点第 2 行 → 第一条后移 0，第二条后移 1
    expect(computeSlotShifts(two, [2])).toEqual([0, 1]);
    expect(computeSlotShifts(two, [0])).toEqual([1, 1]);
  });
});
