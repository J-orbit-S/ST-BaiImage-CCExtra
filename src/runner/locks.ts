/**
 * 每楼一把锁：同一楼连续划线 / 连续确认时，后一次取消前一次。
 *
 * 为什么需要：两批 tag 交错插入时，行号换算虽然各自成立，但落在正文里的顺序会乱，
 * 更糟的是「自动出图点第 N 个槽位」会点到对方的卡上。v0.2.0 里这把锁写在 runSelection 内部，
 * volume 2 拆出「分析」与「写回」两段后，两边都要锁，所以搬到这里。
 */

const running = new Map<string, AbortController>();

function keyOf(chatId: string, floor: number): string {
  return `${chatId}\u0000${floor}`;
}

export interface FloorRun {
  controller: AbortController;
  /** 结束本次运行，释放锁（幂等）。 */
  release: () => void;
}

/**
 * 取得某楼的执行权：先中止同楼在途的那一次，再返回自己的 controller。
 * `outer` 是调用方给的取消信号（例如切聊天），会被转发到本次 controller。
 */
export function beginFloorRun(chatId: string, floor: number, outer?: AbortSignal): FloorRun {
  const key = keyOf(chatId, floor);
  running.get(key)?.abort();

  const controller = new AbortController();
  const forwardAbort = () => controller.abort();
  if (outer?.aborted) controller.abort();
  else outer?.addEventListener('abort', forwardAbort, { once: true });
  running.set(key, controller);

  return {
    controller,
    release: () => {
      outer?.removeEventListener('abort', forwardAbort);
      if (running.get(key) === controller) running.delete(key);
    },
  };
}

/** 中止某楼在途的运行（切聊天 / 重复点击时用）。 */
export function cancelFloorRun(chatId: string, floor: number): void {
  running.get(keyOf(chatId, floor))?.abort();
}

/** 中止全部在途运行（切聊天时清场）。 */
export function cancelAllRuns(): void {
  for (const controller of running.values()) controller.abort();
  running.clear();
}
