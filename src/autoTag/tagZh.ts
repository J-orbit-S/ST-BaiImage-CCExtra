/**
 * Base tag 的中文对照：让同一次副 API 调用顺手多交一份「人话」。
 *
 * 为什么要有它：候选卡片的全部意义是「先看后插」，而看英文 danbooru 串判断
 * 「这个画面对不对」门槛很高。加了中文对照之后，确认/编辑都变成读中文的事。
 *
 * 三条纪律（都写进了类型与断言里）：
 * 1. **只给人看**：`tagZh` 绝不进 `ImageInsertion.tag`、不进正文、不进 `extra`。
 *    写回链路完全不认识它，所以「中文进了正文」这种事在结构上不可能发生。
 * 2. **只翻 Base**：角色分项（`characters[]`）不翻。卡片上唯一可编辑的就是 Base，
 *    给不可编辑的东西做对照，收益小于它带来的输出长度。
 * 3. **挂在 version 上**：挂在候选外层的话，重 Roll 之后中文会停在上一版
 *    —— 显示一个错的对照比没有对照更糟。
 *
 * 为什么解析放在我们自己这边而不是改协议：`autoTag/protocol.ts` 是 vendored 文件
 * （见 VENDORED.md），一个字节都不许动。而 `requestCompletion` 的 `validate` 回调
 * 会把**原始响应文本**交回来，所以我们完全可以自己再解析一遍取额外字段。
 */

/** 追加到 taskNote 的输出要求。只翻 Base，且刻意要求「tag 先写、tagZh 后写」。 */
export const TAG_ZH_TASK_NOTE = [
  '【本轮输出补充】插画方案下，每张图的 JSON 对象里在 "tag" 之后额外给一个 "tagZh"：',
  '把该图的 Base tag（就是 "tag" 那个字段）用简体中文逐项直译，用中文逗号「，」分隔，',
  '项数与英文一一对应，不增加、不删减、不加解释、不写成一句描述性的句子。',
  'characters 里的角色分项不需要翻译。"tag" 本身保持原样，一个字都不要改。',
].join('\n');

/** 从原始响应里剥出那一个 JSON 对象（模型可能包 <thinking> 或 ``` 代码块）。 */
function extractJsonObject(raw: string): string | null {
  const withoutThinking = String(raw ?? '').replace(/<think(?:ing)?\b[\s\S]*?<\/think(?:ing)?>/gi, '');
  const withoutFence = withoutThinking.replace(/```[a-zA-Z]*\n?/g, '');
  const start = withoutFence.indexOf('{');
  const end = withoutFence.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  return withoutFence.slice(start, end + 1);
}

/**
 * 按 images 的下标取出 `tagZh`。缺失 / 脏值 / 整段解析不了，一律给空串
 * —— 这是「锦上添花」的字段，任何异常都不该让一次成功的分析变成失败。
 */
export function extractTagZh(raw: string): string[] {
  const json = extractJsonObject(raw);
  if (!json) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  const images = (parsed as { images?: unknown } | null)?.images;
  if (!Array.isArray(images)) return [];
  return images.map(item => {
    const value = (item as { tagZh?: unknown } | null)?.tagZh;
    return typeof value === 'string' ? value.trim() : '';
  });
}
