/**
 * runner/plan.ts 的自测。
 *
 * 这些用例锁的是「后处理与上游一致」这件事的**可观察后果**，不是实现细节：
 * - changes 怎么变成 ops（建档的 JSON 字段 / 整串 / 单字段 / nl）；
 * - 锁定角色为什么必须被丢掉；
 * - nl 丢弃、画幅锁归一、@占位符替换、漏建档告警的名字从哪来；
 * - 写回时「切片行号 → 整楼行号」这一步在正文被改过后还能不能落对位置。
 */

import { describe, expect, it } from 'vitest';
import type { ImagePlan } from '@/autoTag/protocol';
import { emptyCharFields, type CharTagEntry } from '@/state/charTags';
import { buildCapture } from '@/selection/capture';
import { planSelection } from '@/selection/segmentPlan';
import {
  applyPlanPostProcess,
  buildWritebackText,
  describeRebase,
  filterLockedOps,
  planChangeOps,
} from '@/runner/plan';

function entry(name: string, fields: Partial<Record<keyof ReturnType<typeof emptyCharFields>, string>>): CharTagEntry {
  return {
    name,
    fields: { ...emptyCharFields(), ...fields },
    raw: '',
    nl: '',
    source: 'manual',
    desc: '',
    history: [],
  };
}

const profile = { naiCharPrompts: false, nl: true, lockedSize: null, comic: false };

function change(over: Partial<ImagePlan['changes'][number]>): ImagePlan['changes'][number] {
  return {
    name: '小雪',
    field: 'new',
    value: '',
    reason: '',
    position: 'P1',
    sourceLine: 0,
    ...over,
  };
}

describe('planChangeOps（上游 runner.ts:140–181）', () => {
  it('建档：JSON 字段串被拆回 fields，位置一并带上', () => {
    const ops = planChangeOps({
      images: [],
      changes: [
        change({
          value: JSON.stringify({ hair: 'long silver hair', eyes: 'red eyes' }),
          reason: '首次出场',
          sourceLine: 4,
        }),
      ],
    });
    expect(ops).toHaveLength(1);
    expect(ops[0].sourceLine).toBe(4);
    expect(ops[0].op.kind).toBe('new');
    if (ops[0].op.kind !== 'new') throw new Error('unreachable');
    expect(ops[0].op.fields.hair).toBe('long silver hair');
    expect(ops[0].op.fields.eyes).toBe('red eyes');
    expect(ops[0].op.reason).toBe('首次出场');
  });

  it('建档：非 JSON 的整串 tag 原样进 raw', () => {
    const ops = planChangeOps({
      images: [],
      changes: [change({ value: '1girl, long silver hair, red eyes' })],
    });
    expect(ops).toHaveLength(1);
    if (ops[0].op.kind !== 'new') throw new Error('unreachable');
    expect(ops[0].op.raw).toBe('1girl, long silver hair, red eyes');
  });

  it('永久变化：单字段 set，名字与位置都保留', () => {
    const ops = planChangeOps({
      images: [],
      changes: [change({ field: 'hair', value: 'short red hair', sourceLine: 9 })],
    });
    expect(ops[0].op.kind).toBe('set');
    if (ops[0].op.kind !== 'set') throw new Error('unreachable');
    expect(ops[0].op.field).toBe('hair');
    expect(ops[0].op.value).toBe('short red hair');
    expect(ops[0].sourceLine).toBe(9);
  });

  it('nl 变更：value 为空时退回 nl 字段（协议里两条路都写过）', () => {
    const ops = planChangeOps({
      images: [],
      changes: [change({ field: 'nl', value: '', nl: 'A girl with long silver hair.' })],
    });
    expect(ops[0].op.kind).toBe('set');
    if (ops[0].op.kind !== 'set') throw new Error('unreachable');
    expect(ops[0].op.value).toBe('A girl with long silver hair.');
  });

  it('按位置升序：写回顺序必须跟着剧情走', () => {
    const ops = planChangeOps({
      images: [],
      changes: [
        change({ field: 'hair', value: 'short red hair', sourceLine: 12 }),
        change({ name: '小雪', value: JSON.stringify({ hair: 'h', eyes: 'e' }), sourceLine: 2 }),
      ],
    });
    expect(ops.map(op => op.sourceLine)).toEqual([2, 12]);
  });

  it('空名 / 空值 / 不认识的字段一律丢弃，不连累其它 op', () => {
    const ops = planChangeOps({
      images: [],
      changes: [
        change({ name: '   ', value: JSON.stringify({ hair: 'h', eyes: 'e' }) }),
        change({ field: 'hair', value: '   ' }),
        change({ field: 'fandom', value: 'kasumi (blue archive)' }),
      ],
    });
    expect(ops).toHaveLength(1);
    if (ops[0].op.kind !== 'set') throw new Error('unreachable');
    expect(ops[0].op.field).toBe('fandom');
  });
});

describe('filterLockedOps', () => {
  it('全局锁定的角色不接受 AI changes', () => {
    const ops = planChangeOps({
      images: [],
      changes: [
        change({ name: '小雪', field: 'hair', value: 'short red hair' }),
        change({ name: '阿离', field: 'hair', value: 'long black hair' }),
      ],
    });
    const kept = filterLockedOps(ops, new Set(['小雪']));
    expect(kept).toHaveLength(1);
    expect(kept[0].op.name).toBe('阿离');
  });

  it('锁定名单为空时原样返回（不复制、不排序）', () => {
    const ops = planChangeOps({ images: [], changes: [change({ field: 'hair', value: 'x' })] });
    expect(filterLockedOps(ops, new Set())).toBe(ops);
  });
});

describe('applyPlanPostProcess（上游 runner.ts:446–518）', () => {
  const library = [entry('小雪', { sex: '1girl', hair: 'long silver hair', eyes: 'red eyes' })];

  function image(over: Partial<ImagePlan['images'][number]>): ImagePlan['images'][number] {
    return {
      position: 'P1',
      sourceLine: 0,
      tag: '1girl, classroom',
      nl: '',
      negative: '',
      characters: [],
      size: 'portrait',
      ...over,
    };
  }

  it('@占位符换成库里的固定外貌；库里没有的名字被剥掉并回报', () => {
    const plan: ImagePlan = { images: [image({ tag: '@小雪, waving, @路人甲' })], changes: [] };
    const unknown = applyPlanPostProcess(plan, {
      profile,
      anchors: { text: 'x', entries: library },
      effectiveOps: [],
      lockedNames: new Set(),
    });
    expect(plan.images[0].tag).toBe('1girl, long silver hair, red eyes, waving');
    expect([...unknown]).toEqual(['路人甲']);
  });

  it('协议不含 nl 时，模型照写的 nl 一律清空（含 characters[].nl）', () => {
    const plan: ImagePlan = {
      images: [
        image({
          tag: '1girl',
          nl: 'A girl stands in a classroom.',
          characters: [{ name: '小雪', tag: 'girl, waving', nl: 'She waves.' }],
        }),
      ],
      changes: [],
    };
    applyPlanPostProcess(plan, {
      profile: { ...profile, nl: false },
      anchors: { text: null, entries: [] },
      effectiveOps: [],
      lockedNames: new Set(),
    });
    expect(plan.images[0].nl).toBe('');
    expect(plan.images[0].characters[0].nl).toBe('');
    // tag 不受影响
    expect(plan.images[0].characters[0].tag).toBe('girl, waving');
  });

  it('渠道锁了画幅时，每张图统一改记锁定值', () => {
    const plan: ImagePlan = { images: [image({ size: 'portrait' }), image({ size: 'landscape' })], changes: [] };
    applyPlanPostProcess(plan, {
      profile: { ...profile, lockedSize: 'landscape' },
      anchors: { text: null, entries: [] },
      effectiveOps: [],
      lockedNames: new Set(),
    });
    expect(plan.images.map(item => item.size)).toEqual(['landscape', 'landscape']);
  });

  it('永久变化按位置门控：变化之前的图用旧档，之后用新档', () => {
    const ops = planChangeOps({
      images: [],
      changes: [change({ name: '小雪', field: 'hair', value: 'short red hair', sourceLine: 5 })],
    });
    const plan: ImagePlan = {
      images: [image({ tag: '@小雪', sourceLine: 2 }), image({ tag: '@小雪', sourceLine: 8 })],
      changes: [],
    };
    applyPlanPostProcess(plan, { profile, anchors: { text: 'x', entries: library }, effectiveOps: ops, lockedNames: new Set() });
    expect(plan.images[0].tag).toContain('long silver hair');
    expect(plan.images[1].tag).toContain('short red hair');
  });
});

describe('describeRebase', () => {
  it('全部原位命中时返回空串（不必写日志）', () => {
    expect(describeRebase({ anchored: 2, remapped: 0, drifted: 0 })).toBe('');
  });

  it('有偏位时给出可读摘要', () => {
    expect(describeRebase({ anchored: 1, remapped: 1, drifted: 2 })).toBe(
      '原位 1 · 跟随改写句 1 · 顺延到上一段 2',
    );
  });
});

describe('buildWritebackText：切片行号 → 整楼行号', () => {
  const mes = ['走廊很安静。', '她推开门，灯闪了一下。', '“你回来了。”', ''].join('\n');

  function makePlan() {
    const start = mes.indexOf('她推开门');
    const outcome = buildCapture({
      raw: mes,
      messageId: 3,
      swipeId: 0,
      domText: '她推开门',
      located: { start, end: start + '她推开门'.length, method: 'strict', candidates: 1 },
    });
    if (!outcome.ok) throw new Error('capture failed');
    const planned = planSelection(outcome.capture, mes, []);
    if (!planned.ok) throw new Error('plan failed');
    return planned.plan;
  }

  it('正文未变：tag 紧跟划线那一行之后，其余行一字不动', () => {
    const plan = makePlan();
    const built = buildWritebackText(
      plan,
      mes,
      [
        {
          position: 'P1',
          sourceLine: plan.sliceSegments[0].sourceLine,
          tag: '1girl, doorway, dim light',
          nl: '',
          negative: '',
          characters: [],
          size: 'portrait',
        },
      ],
      [],
    );
    expect(built.ok).toBe(true);
    if (!built.ok) throw new Error('unreachable');
    expect(built.mode).toBe('direct');
    expect(built.text).toContain('<bbi_image>');
    expect(built.text.indexOf('<bbi_image>')).toBeGreaterThan(built.text.indexOf('灯闪了一下'));
    expect(built.text.indexOf('<bbi_image>')).toBeLessThan(built.text.indexOf('你回来了'));
    // 原正文必须一字不少地还在
    for (const line of mes.split('\n')) expect(built.text).toContain(line);
  });

  it('正文被前置了新行：位置跟着那一段走，不会插到楼层开头', () => {
    const plan = makePlan();
    const shifted = `（别处追加的一行）\n${mes}`;
    const built = buildWritebackText(
      plan,
      shifted,
      [
        {
          position: 'P1',
          sourceLine: plan.sliceSegments[0].sourceLine,
          tag: '1girl, doorway',
          nl: '',
          negative: '',
          characters: [],
          size: 'portrait',
        },
      ],
      [],
    );
    expect(built.ok).toBe(true);
    if (!built.ok) throw new Error('unreachable');
    expect(built.text.indexOf('<bbi_image>')).toBeGreaterThan(built.text.indexOf('灯闪了一下'));
    expect(built.text.indexOf('<bbi_image>')).toBeLessThan(built.text.indexOf('你回来了'));
  });

  it('模型给的行号不在切片里：整批拒绝，绝不瞎猜落点', () => {
    const plan = makePlan();
    const built = buildWritebackText(
      plan,
      mes,
      [
        {
          position: 'P9',
          sourceLine: 99,
          tag: '1girl',
          nl: '',
          negative: '',
          characters: [],
          size: 'portrait',
        },
      ],
      [],
    );
    expect(built.ok).toBe(false);
    if (built.ok) throw new Error('unreachable');
    expect(built.reason).toBe('position-lost');
  });
});
