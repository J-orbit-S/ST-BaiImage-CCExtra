/**
 * 「这段划线已经写过 tag」的会话内记忆。
 *
 * 为什么要有：本插件是点击即执行，没有柏宝绘那种「已有 tag 就跳过」的自动闸门。
 * 同一段文字连点两次就会插两批 tag（用户多半只是想确认一下有没有生效）。
 *
 * 判据刻意做得**可解释**：只有当本楼 tag 数仍 ≥ 上次写完的数量时才算「已经写过了」——
 * 用户删掉那几张卡片（tag 数变少）就自然放行，不需要任何额外操作。
 *
 * 为什么单独成文件：v0.2.0 只在写回一处用它；volume 2 拆段后，「分析」要在发请求**之前**
 * 查它（省一次 API），「写回」要在成功后写它。两边各存一份就会各漏一半。
 */

import { hashText } from '@/selection/hash';

const written = new Map<string, number>();

/** 一次划线的身份：聊天 + 楼层 + swipe + 划线原文。 */
export function makeIdentity(chatId: string, floor: number, swipeId: number, text: string): string {
  return `${chatId}\u0000${floor}\u0000${swipeId}\u0000${hashText(text)}`;
}

/** 上次写完时本楼的 tag 总数；没记过 = undefined。 */
export function processedTagCount(identity: string): number | undefined {
  return written.get(identity);
}

export function markProcessed(identity: string, tagCount: number): void {
  written.set(identity, tagCount);
}

/** 仅供测试：清掉这张表（模块级状态，用例之间会互相污染）。 */
export function forgetProcessed(): void {
  written.clear();
}
