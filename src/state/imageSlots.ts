/**
 * 柏宝绘楼层图片历史（`message.extra.bbiImage`）的**槽位序号迁移**。
 *
 * 为什么需要这一层：
 *   柏宝绘的图片按 `(swipeId, promptHash, slotSeq)` 归属（见其 `floor/storage.ts` 的
 *   `entrySeq` / `historyEntries`），`slotSeq` 就是「生成时这张图属于楼里第几个 tag」。
 *   卡片水合时用「当前 tag 的 hash + 它在楼里的序号」去查历史：
 *     - 查到 → ready（显示那张图，可翻页）
 *     - 查不到、但同序号有别的 hash → stale（显示那张旧图 +「旧提示词」角标）
 *     - 都没有 → pending（待生成）
 *
 *   本插件会把新 tag 插在划线那段之后。如果插入点在既有 tag **之前**，那条既有 tag
 *   的序号就从 N 变成 N+1——历史仍然记在 N 上，于是：
 *     旧卡 → pending（图不见了），新卡 → stale（顶着旧图 +「旧提示词」）。
 *   用户实测反馈的就是这个现象（2026-11-20）。
 *
 * 为什么由我们来迁移：
 *   柏宝绘没有「在楼中间手插 tag」的入口，所以它不需要处理序号平移；而我们的核心用法
 *   恰恰是往任意位置插 tag。除了把 seq 一起挪，没有第二种办法能让「两张图各归各位」
 *   同时成立（把新图插到楼末会丢位置语义；删掉旧 tag 就是替旧图重 roll，用户不要）。
 *
 * 边界（很重要）：
 *   - **只改 `slotSeq` 这一个字段**，其余字段原样保留，不重排、不删条目；
 *   - 结构不认识（extra 没有该键 / 桶不是数组 / 条目不是对象）就**跳过并告警**，
 *     绝不重建。宁可旧卡显示成「待生成」，也不写坏别人的数据；
 *   - 写回用与上游 `mutateStore` 同款的 CAS：引用被并发替换就重读重试，最多 3 轮。
 *
 * 也就是说：分析链路仍然只有「source 换成划线」「rebase 基底用整楼」两处差异；
 * 这里动的是**楼层数据**（柏宝绘自己每次出图也在写这份数据），不是它的代码逻辑。
 */

/** 上游的 extra 键名（`floor/storage.ts` 的 `BBI_IMAGE_EXTRA_KEY`）。改名即视为结构漂移。 */
export const BBI_IMAGE_EXTRA_KEY = 'bbiImage';

interface RawEntry {
  slotSeq?: unknown;
  [key: string]: unknown;
}

type RawStore = Record<string, Record<string, RawEntry[]>>;

export interface SlotMigration {
  store: RawStore;
  /** 实际被改动条目的数量；0 表示无需迁移（store 原样返回）。 */
  changed: number;
  /** 结构不认识时给出原因，调用方据此只记日志、不重试。 */
  skipped?: 'not-object' | 'no-store' | 'bad-bucket';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 纯函数：按 `shifts`（下标=旧序号，值=后移位数）平移指定 swipe 的全部条目。
 *
 * 只动当前 swipe：别的 swipe 的正文没变，它们的 tag 序号也没变。
 * 反例也要挡住——`slotSeq` 指向一个当前已不存在的序号（用户删过 tag）时，`shifts` 越界，
 * 原样保留：那种条目本来就已失配，强行挪只会让排查更乱。
 */
export function shiftSlotSeqInStore(store: RawStore, swipeId: number, shifts: number[]): SlotMigration {
  if (!shifts.some(shift => shift > 0)) return { store, changed: 0 };
  const swipeKey = String(swipeId);
  const buckets = store?.[swipeKey];
  if (buckets === undefined) return { store, changed: 0 };
  if (!isPlainObject(buckets)) return { store, changed: 0, skipped: 'bad-bucket' };

  let changed = 0;
  const nextBuckets: Record<string, RawEntry[]> = {};
  for (const [hash, list] of Object.entries(buckets)) {
    if (!Array.isArray(list)) return { store, changed: 0, skipped: 'bad-bucket' };
    const nextList = list.map(entry => {
      if (!isPlainObject(entry)) return entry;
      const seq = Number.isInteger(entry.slotSeq) ? (entry.slotSeq as number) : 0;
      const delta = seq >= 0 && seq < shifts.length ? shifts[seq] : 0;
      if (!delta) return entry;
      changed += 1;
      return { ...entry, slotSeq: seq + delta };
    });
    nextBuckets[hash] = nextList;
  }
  if (!changed) return { store, changed: 0 };
  return { store: { ...store, [swipeKey]: nextBuckets }, changed };
}

export interface MigrationResult {
  changed: number;
  skipped?: SlotMigration['skipped'] | 'no-extra' | 'no-chat' | 'contention';
}

/**
 * 把位移写回楼层 extra（读-校验-写循环，与上游 mutateStore 同款 CAS）。
 *
 * 调用时机：正文写回**成功之后**。正文没写进去就不该动历史——否则序号被挪、
 * tag 却没多，旧卡反而丢图。
 */
export async function migrateImageSlots(
  context: { saveChat?: () => Promise<void> | void } | null | undefined,
  message: { extra?: unknown } | null | undefined,
  swipeId: number,
  shifts: number[],
): Promise<MigrationResult> {
  if (!shifts.some(shift => shift > 0)) return { changed: 0 };
  if (!message) return { changed: 0, skipped: 'no-chat' };

  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (!isPlainObject(message.extra)) return { changed: 0, skipped: 'no-extra' };
    const extra = message.extra as Record<string, unknown>;
    const store = extra[BBI_IMAGE_EXTRA_KEY];
    if (!isPlainObject(store)) return { changed: 0, skipped: 'no-store' };

    const migrated = shiftSlotSeqInStore(store as RawStore, swipeId, shifts);
    if (migrated.skipped) return { changed: 0, skipped: migrated.skipped };
    if (!migrated.changed) return { changed: 0 };
    // 并发：本次计算期间有人换掉了整个 store 引用，基于最新值重算
    if (extra[BBI_IMAGE_EXTRA_KEY] !== store) continue;

    extra[BBI_IMAGE_EXTRA_KEY] = migrated.store;
    try {
      await context?.saveChat?.();
    } catch (error) {
      // 保存失败不回滚内存：与上游一致（下次 saveChat 会把它一起带上）
      console.warn('[CCX] 槽位序号迁移后保存聊天失败', error);
    }
    return { changed: migrated.changed };
  }
  return { changed: 0, skipped: 'contention' };
}
