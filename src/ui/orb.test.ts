import { describe, expect, it } from 'vitest';

import { decideDock } from '@/ui/orb';

/**
 * 球唯一的数学逻辑。算反的表现是「拖到右边却贴在左边」——不会坏数据，但用起来很别扭，
 * 而且靠肉眼很难复现（必须正好落在 56px 吸附带里）。所以在这儿钉死。
 */
describe('decideDock', () => {
  const W = 1200;
  const SIZE = 44;
  const SNAP = 56;

  it('靠左边缘就贴左', () => {
    expect(decideDock(0, W, SIZE, SNAP)).toBe('left');
    expect(decideDock(SNAP, W, SIZE, SNAP)).toBe('left');
  });

  it('刚好越过吸附带就不贴边（留在原地）', () => {
    expect(decideDock(SNAP + 1, W, SIZE, SNAP)).toBe('none');
  });

  it('靠右边缘就贴右', () => {
    // 右边距 = 1200 - (x + 44) ≤ 56  →  x ≥ 1100
    expect(decideDock(W - SIZE, W, SIZE, SNAP)).toBe('right');
    expect(decideDock(W - SIZE - SNAP, W, SIZE, SNAP)).toBe('right');
    expect(decideDock(W - SIZE - SNAP - 1, W, SIZE, SNAP)).toBe('none');
  });

  it('屏幕中间不吸附（用户明确要求「拖到中间就停在中间」）', () => {
    expect(decideDock(W / 2, W, SIZE, SNAP)).toBe('none');
  });

  it('窄屏两侧都在吸附带里时优先贴左（不左右横跳）', () => {
    // 100px 宽的视口，44px 的球：左边距 10、右边距 46，两边都 ≤ 56
    expect(decideDock(10, 100, SIZE, SNAP)).toBe('left');
  });
});
