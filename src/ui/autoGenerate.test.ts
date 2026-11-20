/**
 * 自动出图的自测。
 *
 * 这里锁的是两件「错了很难发现」的事：
 * 1. **不能点错按钮**——卡片上还有个同名类名的「按当前方案重新生成本楼」，
 *    点了会把整楼 tag 删掉重写，等于把用户刚划的那次覆盖掉。
 * 2. **点不到时不许静默**——用户得知道「tag 已写好，点一下卡片就行」，
 *    否则他会以为插件坏了。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/ui/notify', () => ({ notify: vi.fn() }));

import { notify } from '@/ui/notify';
import { autoGenerateSlots, pickGenerateButton, setAutoGenerate } from '@/ui/autoGenerate';

type FakeButton = { textContent: string; click: ReturnType<typeof vi.fn> };

function button(text: string): FakeButton {
  return { textContent: text, click: vi.fn() };
}

function shadowWith(target: FakeButton | null): ShadowRoot {
  return { querySelector: () => target } as unknown as ShadowRoot;
}

describe('pickGenerateButton', () => {
  it('挑出「生成图片」', () => {
    const target = button('生成图片');
    expect(pickGenerateButton({ querySelector: () => target } as unknown as ShadowRoot)).toBe(target);
  });

  it('失败重试态也是同一个按钮', () => {
    const target = button('重试');
    expect(pickGenerateButton({ querySelector: () => target } as unknown as ShadowRoot)).toBe(target);
  });

  it('「按当前方案重新生成本楼」绝不点——它会重跑整楼分析', () => {
    const target = button('按当前方案重新生成本楼');
    expect(pickGenerateButton({ querySelector: () => target } as unknown as ShadowRoot)).toBeNull();
  });

  it('卡片还没有按钮时返回 null，不抛错', () => {
    expect(pickGenerateButton({ querySelector: () => null } as unknown as ShadowRoot)).toBeNull();
    expect(pickGenerateButton(null)).toBeNull();
  });
});

describe('autoGenerateSlots', () => {
  const originalDocument = globalThis.document;

  beforeEach(() => {
    setAutoGenerate(true);
    vi.mocked(notify).mockClear();
  });

  afterEach(() => {
    vi.stubGlobal('document', originalDocument);
  });

  function installDom(buttons: Array<FakeButton | null>, tagCount: number): void {
    const anchors = Array.from({ length: tagCount }, (_, index) => {
      const root = shadowWith(buttons[index] ?? null);
      return { shadowRoot: root } as unknown as HTMLElement;
    });
    const message = {
      querySelectorAll: () => anchors,
      scrollIntoView: () => {},
    } as unknown as HTMLElement;
    vi.stubGlobal('document', {
      querySelector: () => message,
    });
  }

  it('每个目标槽位各点一次', async () => {
    const first = button('生成图片');
    const second = button('生成图片');
    installDom([first, second], 2);

    const outcome = await autoGenerateSlots({ floor: 3, seqs: [0, 1], totalTags: 2 });
    expect(outcome).toEqual({ clicked: 2, reason: undefined });
    expect(first.click).toHaveBeenCalledTimes(1);
    expect(second.click).toHaveBeenCalledTimes(1);
  });

  it('只点新槽位，不去碰已有的卡片', async () => {
    const old = button('生成图片');
    const fresh = button('生成图片');
    installDom([old, fresh], 2);

    await autoGenerateSlots({ floor: 3, seqs: [1], totalTags: 2 });
    expect(old.click).not.toHaveBeenCalled();
    expect(fresh.click).toHaveBeenCalledTimes(1);
  });

  it('只找到「重新生成本楼」时点不动，并给出人话提示', async () => {
    const regen = button('按当前方案重新生成本楼');
    installDom([regen], 1);

    const outcome = await autoGenerateSlots({ floor: 3, seqs: [0], totalTags: 1 });
    expect(outcome.clicked).toBe(0);
    expect(outcome.reason).toBe('floor-regen-only');
    expect(regen.click).not.toHaveBeenCalled();
    expect(vi.mocked(notify)).toHaveBeenCalledWith('warning', expect.stringContaining('不匹配'));
  });

  it('已出的图卡（没有生成按钮）不提示、不报错', async () => {
    installDom([null], 1);
    const outcome = await autoGenerateSlots({ floor: 3, seqs: [0], totalTags: 1 });
    expect(outcome.clicked).toBe(0);
    expect(vi.mocked(notify)).toHaveBeenCalledWith('info', expect.stringContaining('生成图片'));
  });

  /**
   * v0.2.2 的回归：这里**不许**再判「自动出图关着就不点」。
   *
   * 那个判断曾经同时存在于这里和 `writeAndPublish`，数据源还不同（偏好 vs 入参）。
   * 「自动出图关 + 需确认开」时调用方说去出图、这里说开关关着不干，静默失效；
   * 而全自动模式下两个判断恰好一致，于是 bug 藏了一整版。
   * 守卫只有一处（`writeAndPublish` 的 input.autoGenerate），本函数照单执行。
   */
  it('偏好里的自动出图关着，也照调用方的要求点（守卫只有一处）', async () => {
    setAutoGenerate(false);
    const target = button('生成图片');
    installDom([target], 1);

    const outcome = await autoGenerateSlots({ floor: 3, seqs: [0], totalTags: 1 });
    expect(outcome.clicked).toBe(1);
    expect(target.click).toHaveBeenCalledTimes(1);
    setAutoGenerate(true);
  });

  it('没有目标槽位时什么都不做', async () => {
    const target = button('生成图片');
    installDom([target], 1);
    expect(await autoGenerateSlots({ floor: 3, seqs: [], totalTags: 1 })).toEqual({
      clicked: 0,
      reason: 'no-seqs',
    });
  });
});
