/**
 * 划线出图的编排层 —— 本插件唯一「有副作用」的地方。
 *
 * volume 2 起它只做**分流**，两条腿各自在别处：
 *
 *   划线 → `analysis.ts`（A 段：闸门 / 上下文 / 副 API / 解析 / 后处理）
 *            ├─ 全自动（自动出图开）        → `commit.ts` 直接写回并出图   ← v0.2.0 原样
 *            ├─ 全手动（都关）              → `commit.ts` 只写回，自己点卡片
 *            └─ 确认式（需确认开）          → `state/candidates.ts` 候选池，等你点头
 *
 * 分辨三条路只看偏好，不看别的：
 *   `confirmTag` 在状态层被 `autoGenerate` 压着（见 state/prefs.ts），
 *   所以「自动出图开 + 需确认开」这种会打架的组合根本构造不出来。
 *
 * 与上游的差异仍然只有两处（见 VENDORED.md 红线）：
 *   ① 喂给 LLM 的目标正文来自划线切片；
 *   ② 写回时 rebase 的 currentText 用整楼现文、plannedSegments 用切片绝对行号。
 */

import { injectImageTags, type ImageInsertion } from '@/autoTag/protocol';
import type { SelectionCapture } from '@/selection/capture';
import { addAnalysis } from '@/state/candidates';
import { readPrefs } from '@/state/prefs';
import { notify } from '@/ui/notify';
import { analyzeSelection, describeCaptureFailure } from './analysis';
import { commitAnalysis } from './commit';
import { diagnostic } from './diagnostic';
import { cancelAllRuns, cancelFloorRun } from './locks';
import { result, type RunOptions, type RunResult, type RunStatus } from './result';
import { getContext } from '@/st/context';

export type { RunOptions, RunResult, RunStatus };
export { describeCaptureFailure };

/**
 * 跑一次划线：分析 → 按偏好决定「直接写回」还是「放进候选池等确认」。
 *
 * 调用方（UI）负责先把 `captureSelection()` 的失败讲给用户听；本函数只处理成功捕获之后的一切。
 */
export async function runSelection(capture: SelectionCapture, opts: RunOptions = {}): Promise<RunResult> {
  const outcome = await analyzeSelection(capture, { signal: opts.signal });
  if (!outcome.ok) return outcome.result;

  const analysis = outcome.analysis;
  const prefs = readPrefs();
  // 防御性再判一次：正常路径下 confirmTag 已被 autoGenerate 压成 false
  const needsConfirm = prefs.confirmTag && !prefs.autoGenerate && analysis.images.length > 0;

  if (needsConfirm) {
    const added = addAnalysis({
      chatId: analysis.chatId,
      floor: analysis.floor,
      swipeId: analysis.swipeId,
      segments: [analysis.segment],
      images: analysis.images,
      changes: analysis.changes,
      tagZh: analysis.tagZh,
    });
    diagnostic('runSelection:pending', { floor: analysis.floor, added });
    notify('info', `已生成 ${added} 个候选画面：在面板里确认后才会写进正文`);
    return result('pending', '候选已生成，等待确认', { images: added });
  }

  return commitAnalysis(analysis, { autoGenerate: prefs.autoGenerate, signal: opts.signal });
}

/** 中止某楼在途的划线分析（切聊天 / 重复点击时用）。 */
export function cancelSelectionRun(floor: number): void {
  const chatId = getContext()?.getCurrentChatId?.() ?? '';
  cancelFloorRun(chatId, floor);
}

/** 中止全部在途分析（切聊天时清场）。 */
export function cancelAllSelectionRuns(): void {
  cancelAllRuns();
}

/** 仅供调试：把一段正文按整楼口径注入 tag（不做请求）。用于排查写回坐标。 */
export function previewInject(currentText: string, images: ImageInsertion[]): string {
  return injectImageTags(currentText, images);
}
