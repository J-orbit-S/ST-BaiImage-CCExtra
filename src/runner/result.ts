/**
 * 一次划线运行的统一结果形状，以及「跳过 / 失败」两个带诊断的构造器。
 *
 * 单独成文件只为一件事：`analysis.ts` 与 `commit.ts` 都要用它，而它们互相不该 import。
 * 语义与 v0.2.0 完全一致（`reason` 是稳定码，`message` 是给人看的一句话），
 * 只多了一个 `pending`：确认式模式下「已生成候选、还没写正文」既不是成功也不是失败。
 */

import { diagnostic } from './diagnostic';

export type RunStatus = 'saved' | 'no-image' | 'aborted' | 'skipped' | 'failed' | 'pending';

export interface RunResult {
  status: RunStatus;
  /** 跳过/失败的原因码（稳定、可 grep；文案会变，码不会）。 */
  reason?: string;
  /** 本次实际写入的 tag 数。 */
  images: number;
  /** 本次应用的 changes 条数。 */
  changes: number;
  /** 给用户/日志的一句人话。 */
  message: string;
}

export interface RunOptions {
  /** 外部取消（例如用户切了聊天）。 */
  signal?: AbortSignal;
}

export function result(status: RunStatus, message: string, extra: Partial<RunResult> = {}): RunResult {
  return { status, message, images: 0, changes: 0, ...extra };
}

/** 放弃本次运行并交代原因：诊断日志记全量，用户侧给一句人话。 */
export function skip(floor: number, reason: string, message: string, payload: Record<string, unknown> = {}): RunResult {
  diagnostic('runSelection:skip', { floor, reason, ...payload });
  return result('skipped', message, { reason });
}

export function failure(
  floor: number,
  reason: string,
  message: string,
  payload: Record<string, unknown> = {},
): RunResult {
  diagnostic('runSelection:fail', { floor, reason, ...payload });
  return result('failed', message, { reason });
}
