/**
 * 用户可见反馈（toastr）。
 *
 * toastr 由 ST 挂在 window 上，是**全局依赖**，不是我们打包进来的东西：
 * - 构建时不能 import 它（上游用 vite external + globals 映射处理，我们同样外置）；
 * - Node 侧（测试、构建期）它根本不存在，所以这里必须能降级成 console。
 *
 * 标题统一「划线出图」，与柏宝绘的「柏宝绘」区分开——用户一眼知道这条提示来自谁。
 */
export type NoticeKind = 'info' | 'success' | 'warning' | 'error';

const TITLE = '划线出图';

interface ToastrLike {
  info?: (message: string, title?: string) => void;
  success?: (message: string, title?: string) => void;
  warning?: (message: string, title?: string) => void;
  error?: (message: string, title?: string) => void;
}

function toastrOf(): ToastrLike | null {
  const host = globalThis as { toastr?: ToastrLike };
  return host.toastr ?? null;
}

export function notify(kind: NoticeKind, message: string): void {
  const toastr = toastrOf();
  const fn = toastr?.[kind];
  if (typeof fn === 'function') {
    try {
      fn(message, TITLE);
      return;
    } catch {
      /* 宿主 toastr 异常时退回控制台，绝不因为一句提示把主流程打断 */
    }
  }
  const line = `[CCX] ${message}`;
  if (kind === 'warning' || kind === 'error') console.warn(line);
  else console.info(line);
}
