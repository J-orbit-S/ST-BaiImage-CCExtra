/**
 * 槽位序号迁移的测试。
 *
 * 前半组是**机制对照**：用柏宝绘自己的 (hash, slotSeq) 匹配口径，把「为什么必须迁移」
 * 摆成一张可执行的表——别人（包括半年后的我）想简化掉这段逻辑时，先看它为什么会坏。
 * 后半组是迁移函数本身的行为，重点是「不认识的结构一律不碰」。
 */

import { describe, expect, it, vi } from 'vitest';

import { migrateImageSlots, shiftSlotSeqInStore, BBI_IMAGE_EXTRA_KEY } from '@/state/imageSlots';

interface Entry {
  path: string;
  createdAt: number;
  slotSeq?: number;
  prompt?: string;
  /** 让测试的字面量与产品的 RawEntry 结构兼容（真实条目还有别的字段）。 */
  [key: string]: unknown;
}
/** 只关心 slotSeq 的宽松视图：测试字面量与产品 RawStore 都能传进来。 */
type Store = Record<string, Record<string, Array<Record<string, unknown>>>>;

/* —— 机制对照：从上游 floor/storage.ts 逐字抄的匹配口径（仅测试用） —— */

const entrySeq = (entry: Record<string, unknown>) =>
  Number.isInteger(entry.slotSeq) ? (entry.slotSeq as number) : 0;

function historyEntries(store: Store, swipeId: number, hash: string, seq: number): Array<Record<string, unknown>> {
  const list = store?.[String(swipeId)]?.[hash];
  if (!list) return [];
  return list.filter(entry => entrySeq(entry) === seq);
}

function latestStaleEntry(store: Store, swipeId: number, hash: string, seq: number): Record<string, unknown> | null {
  const bucket = store?.[String(swipeId)];
  if (!bucket) return null;
  let latest: Record<string, unknown> | null = null;
  for (const [key, list] of Object.entries(bucket)) {
    if (key === hash || list.length === 0) continue;
    for (let i = list.length - 1; i >= 0; i--) {
      if (entrySeq(list[i]) !== seq) continue;
      const candidate = list[i];
      if (!latest || (candidate.createdAt as number) > (latest.createdAt as number)) latest = candidate;
      break;
    }
  }
  return latest;
}

/** 上游 Card.vue:186 的派生规则。 */
function phaseOf(store: Store, hash: string, seq: number): 'ready' | 'stale' | 'pending' {
  if (historyEntries(store, 0, hash, seq).length) return 'ready';
  return latestStaleEntry(store, 0, hash, seq) ? 'stale' : 'pending';
}

describe('为什么必须迁移 slotSeq（机制对照）', () => {
  // 楼里原来只有 old 一个 tag（序号 0），已出图
  const store: Store = { '0': { H_OLD: [{ path: '/old.png', createdAt: 1, slotSeq: 0 }] } };

  it('插入前：旧卡 ready', () => {
    expect(phaseOf(store, 'H_OLD', 0)).toBe('ready');
  });

  it('不迁移就插在旧 tag 之前：旧卡丢图，新卡顶着旧图标「旧提示词」', () => {
    // 新 tag 占了 0，旧 tag 被挤到 1；历史还记在 0 上
    expect(phaseOf(store, 'H_OLD', 1)).toBe('pending');
    expect(phaseOf(store, 'H_NEW', 0)).toBe('stale');
    expect(latestStaleEntry(store, 0, 'H_NEW', 0)?.path).toBe('/old.png');
  });

  it('迁移之后：两张各归各位，旧图一张不少', () => {
    const migrated = shiftSlotSeqInStore(store, 0, [1]);
    expect(migrated.changed).toBe(1);
    expect(phaseOf(migrated.store, 'H_OLD', 1)).toBe('ready');
    expect(phaseOf(migrated.store, 'H_NEW', 0)).toBe('pending');
  });

  it('插在旧 tag 之后：无需迁移，两张本来就各归各位', () => {
    expect(phaseOf(store, 'H_OLD', 0)).toBe('ready');
    expect(phaseOf(store, 'H_NEW', 1)).toBe('pending');
  });
});

describe('shiftSlotSeqInStore', () => {
  const store: Store = {
    '0': {
      H_A: [{ path: '/a.png', createdAt: 1, slotSeq: 0 }],
      H_B: [{ path: '/b.png', createdAt: 2, slotSeq: 1 }],
    },
  };

  it('全 0 位移：原样返回，不产生新对象', () => {
    const result = shiftSlotSeqInStore(store, 0, [0, 0]);
    expect(result.changed).toBe(0);
    expect(result.store).toBe(store);
  });

  it('只移当前 swipe，别的 swipe 一个字不动', () => {
    const withOther: Store = { ...store, '1': { H_A: [{ path: '/x.png', createdAt: 3, slotSeq: 0 }] } };
    const result = shiftSlotSeqInStore(withOther, 0, [1]);
    expect(result.store['1']).toBe(withOther['1']);
    expect(result.store['0'].H_A[0].slotSeq).toBe(1);
    // 不原地改：原 store 保持旧值（CAS 靠引用比对）
    expect(withOther['0'].H_A[0].slotSeq).toBe(0);
  });

  it('旧数据没有 slotSeq 视为 0，照样能移', () => {
    const legacy: Store = { '0': { H: [{ path: '/a.png', createdAt: 1 }] } };
    expect(shiftSlotSeqInStore(legacy, 0, [2]).store['0'].H[0].slotSeq).toBe(2);
  });

  it('序号越界（tag 已被用户删掉）的条目原样保留', () => {
    const stale: Store = { '0': { H: [{ path: '/a.png', createdAt: 1, slotSeq: 7 }] } };
    const result = shiftSlotSeqInStore(stale, 0, [1]);
    expect(result.changed).toBe(0);
    expect(result.store['0'].H[0].slotSeq).toBe(7);
  });

  it('条目里除 slotSeq 之外的字段全部原样保留', () => {
    const rich: Store = {
      '0': { H: [{ path: '/a.png', createdAt: 1, slotSeq: 0, prompt: '<bbi_image>x</bbi_image>' } as Entry] },
    };
    const result = shiftSlotSeqInStore(rich, 0, [1]);
    expect(result.store['0'].H[0]).toMatchObject({
      path: '/a.png',
      prompt: '<bbi_image>x</bbi_image>',
      slotSeq: 1,
    });
  });

  it('结构不认识就整份放弃（宁可旧卡待生成，也不写坏别人的数据）', () => {
    expect(shiftSlotSeqInStore({ '0': { H: 'not-array' as unknown as Entry[] } }, 0, [1])).toMatchObject({
      changed: 0,
      skipped: 'bad-bucket',
    });
    const untouched: Store = { '0': {} };
    expect(shiftSlotSeqInStore(untouched, 0, [1]).store).toBe(untouched);
  });
});

describe('migrateImageSlots', () => {
  it('没有位移时不写、不存', async () => {
    const saveChat = vi.fn();
    const message = { extra: { [BBI_IMAGE_EXTRA_KEY]: { '0': { H: [{ slotSeq: 0 }] } } } };
    const result = await migrateImageSlots({ saveChat }, message, 0, [0]);
    expect(result.changed).toBe(0);
    expect(saveChat).not.toHaveBeenCalled();
  });

  it('迁移成功后写回 extra 并保存聊天', async () => {
    const saveChat = vi.fn(async () => {});
    const message = { extra: { [BBI_IMAGE_EXTRA_KEY]: { '0': { H: [{ path: '/a.png', slotSeq: 0 }] } } } };
    const result = await migrateImageSlots({ saveChat }, message, 0, [1]);
    expect(result.changed).toBe(1);
    expect(saveChat).toHaveBeenCalledTimes(1);
    const store = message.extra[BBI_IMAGE_EXTRA_KEY] as unknown as Store;
    expect(store['0'].H[0].slotSeq).toBe(1);
  });

  it('extra 没有 bbiImage：跳过，不凭空创建', async () => {
    const message = { extra: {} };
    const result = await migrateImageSlots({ saveChat: vi.fn() }, message, 0, [1]);
    expect(result).toMatchObject({ changed: 0, skipped: 'no-store' });
    expect(message.extra).toEqual({});
  });

  it('消息没有 extra：跳过', async () => {
    const result = await migrateImageSlots({ saveChat: vi.fn() }, {}, 0, [1]);
    expect(result).toMatchObject({ changed: 0, skipped: 'no-extra' });
  });

  it('保存失败不影响内存写入（与上游一致，下次 saveChat 会带上）', async () => {
    const message = { extra: { [BBI_IMAGE_EXTRA_KEY]: { '0': { H: [{ slotSeq: 0 }] } } } };
    const result = await migrateImageSlots(
      {
        saveChat: async () => {
          throw new Error('disk full');
        },
      },
      message,
      0,
      [1],
    );
    expect(result.changed).toBe(1);
    expect((message.extra[BBI_IMAGE_EXTRA_KEY] as unknown as Store)['0'].H[0].slotSeq).toBe(1);
  });
});
