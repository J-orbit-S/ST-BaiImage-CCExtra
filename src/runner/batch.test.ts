import { describe, expect, it } from 'vitest';

import { MAX_BATCH, countBatchCalls, planBatches } from '@/runner/batch';

/**
 * 一键全生成的分组层。跨楼合在一次调用里会让 12 楼的段读到 13 楼的前文，
 * 所以「按 (floor, swipeId) 分组」是口径正确性的要求，不是性能优化。
 * 这里只测纯函数：分组、切块、调用次数。
 */

function item(id: string, floor: number, swipeId = 0) {
  return { imageId: id, floor, swipeId };
}

describe('planBatches', () => {
  it('同楼同 swipe 归成一组；不同楼分开', () => {
    const groups = planBatches([item('a', 3), item('b', 3), item('c', 4)]);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ floor: 3, swipeId: 0, ids: ['a', 'b'] });
    expect(groups[1]).toMatchObject({ floor: 4, ids: ['c'] });
  });

  it('同楼不同 swipe 也分开（swipe 正文互不相干）', () => {
    const groups = planBatches([item('a', 3, 0), item('b', 3, 1)]);
    expect(groups).toHaveLength(2);
    expect(groups.map(group => group.swipeId)).toEqual([0, 1]);
  });

  it('超过 MAX_BATCH 按块切（单次响应太长协议会不稳）', () => {
    const many = Array.from({ length: MAX_BATCH + 3 }, (_, index) => item(`id-${index}`, 7));
    const groups = planBatches(many);
    expect(groups).toHaveLength(2);
    expect(groups[0].ids).toHaveLength(MAX_BATCH);
    expect(groups[1].ids).toHaveLength(3);
  });

  it('组按楼层升序（面板按钮上的「N 次调用」与执行顺序一致）', () => {
    const groups = planBatches([item('late', 9), item('early', 2), item('mid', 5)]);
    expect(groups.map(group => group.floor)).toEqual([2, 5, 9]);
  });

  it('countBatchCalls：3 段同楼 = 1 次；7 段同楼 = 2 次；跨楼至少 2 次', () => {
    expect(countBatchCalls([item('a', 1), item('b', 1), item('c', 1)])).toBe(1);
    expect(
      countBatchCalls(Array.from({ length: MAX_BATCH + 1 }, (_, index) => item(`id-${index}`, 1))),
    ).toBe(2);
    expect(countBatchCalls([item('a', 1), item('b', 2)])).toBe(2);
  });

  it('空列表：0 次调用、没有分组', () => {
    expect(planBatches([])).toEqual([]);
    expect(countBatchCalls([])).toBe(0);
  });
});
