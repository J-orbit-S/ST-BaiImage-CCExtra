# ST-BaiImage-CCExtra · 分析链路协议级复刻工程方案

> 本文是 **工程蓝图 + 排错索引**，不是概览。  
> 目标：CCExtra 的「文本 → tag」LLM 分析过程与柏宝绘 **逐字一致**，而输入从「整楼正文」换成「划线文本」。  
> 所有字段名、键名、函数签名、常量来源均来自对 `ST-BaiBai-Image` 源码的逐行核对；标注了源码文件与行号，可直接对照。

---

## 0. 这份文档怎么用

| 你是……            | 先看                               |
| --------------- | -------------------------------- |
| 要动手搭建的人         | §2 架构 → §3 文件映射表 → §4 时序 → §5 契约 |
| 要对拍「是否和柏宝绘一样」的人 | §6 提示词清单 → §7 一致性工程              |
| 线上出问题、要定位的人     | **§9 排错索引**（故障现象 → 环节 → 日志点）     |
| AI / 后续接手的人     | 文末 §12 YAML 机器摘要                 |

一条最重要的心智模型先放这里：

> 柏宝绘出一张图分两段——**A 段：喂给 LLM 分析写出 tag**；**B 段：拿 tag 出图落盘**。  
> 本方案只复刻 **A 段**，而且要做到和柏宝绘的 A 段**字节级一致**。  
> 划线的替换发生在 A 段最前端的一个变量上：`source`。其余全部照抄。

---

## 1. 目标定义：什么叫「一模一样」

必须把「一样」钉死到可验证的粒度，否则永远扯不清。本方案定义三层一致性，从硬到软：

| 层级              | 定义                                                   | 验证手段                 | 本方案是否做到 |
| --------------- | ---------------------------------------------------- | -------------------- | ------- |
| **L1 请求字节一致**   | 发给副 API / 主 API 的 `messages` 数组，与柏宝绘对同一输入产生的**逐字相同** | 黄金样例 SHA256 对拍（§7.3） | ✅ 硬目标   |
| **L2 协议解析一致**   | 对同一份 LLM 返回文本，解析出的 `ImagePlan` 完全相同                  | 黄金样例结构化比对            | ✅ 硬目标   |
| **L3 落盘/副作用一致** | tag 序列化原文、changes 库更新、rebase 落点规则与柏宝绘一致              | 序列化 hash + rebase 用例 | ✅ 硬目标   |

**唯一允许不同的输入**：喂给 LLM 的「目标正文」——整楼 `message.mes` → 划线文本。  
**明确不追求相同的部分**：B 段出图由谁触发（本方案复用柏宝绘的 `generate()`，见 §8）、UI、图库展示。

> 判定句式：把划线文本当成「一整楼」塞进柏宝绘，柏宝绘会发出的那条 LLM 请求 → CCExtra 必须发出**同一条**。

---

## 2. 核心架构：Vendored Core + Adapter + Selection Source

复刻「一模一样」只有一条可靠路径：**逐字搬运上游源码**，而不是照着思路重写。重写必然在协议文本、正则、回落顺序上漂移。因此架构分三块：

```
┌─────────────────────────────────────────────────────────────┐
│ CCExtra                                                      │
│                                                               │
│  ┌────────────┐   ┌──────────────────────────────────────┐   │
│  │ Selection  │   │ Vendored Core (逐字复制，禁改逻辑)   │   │
│  │ Source     │──▶│ clean → prompt → client → protocol   │   │
│  │ (唯一新增) │   │        → rebase → imageTagRegex      │   │
│  └────────────┘   └───────────────┬──────────────────────┘   │
│         │                          │ 通过 Adapter 取宿主数据 │
│         │                          ▼                          │
│  ┌──────▼──────────────────────────────────────────────────┐  │
│  │ Adapter（薄适配层，唯一允许写「本地逻辑」的地方）       │  │
│  │  · settings   ← 读 extensionSettings 的柏宝绘键        │  │
│  │  · context    ← ST 全局 getContext()                    │  │
│  │  · charTags   ← 读 extra[bbiCharChanges] + 全局库       │  │
│  │  · bookMemory ← 读 globalThis.STBaiBaiBook              │  │
│  └──────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

三个设计铁律：

1. **Vendored Core 里的分析函数一律逐字复制**，文件头标注来源 commit 与「禁改逻辑」；任何本地改动必须写进文件尾 `LOCAL PATCHES` 段并给出理由。
2. **Adapter 是唯一隔离层**：把「柏宝绘模块内的 `settings` 单例 / ST 全局 / 存储」替换成等价读取。**上游函数的参数与返回形状不变**，这样上游逻辑一行都不用改。
3. **Selection Source 是唯一新增业务逻辑**：取划线 → 行对齐 → 变成 `source` 交给 Core；这是唯一允许「不一样」的地方。

---

## 3. 逐文件映射与改动清单（核心表）

> 路径基于 `ST-BaiBai-Image/src/`。「处理」列：`逐字`=整文件复制；`适配`=复制后仅替换数据来源；`新增`=CCExtra 自建。

### 3.1 Vendored Core（L1/L2/L3 一致性的载体）

| 上游文件                     | 处理 | 关键导出                                                                                                        | 本地改动点（仅限）                                                                                    |
| ------------------------ | -- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `autoTag/prompt.ts`      | 逐字 | `buildAutoTagMessages`, `autoTagProfile`, `expandNlSections`, `AutoTagProfile`                              | `settings`/`active*()` 改从 Adapter 导入；协议文本 `fixedContract`/`comicContract`/各 `*Rule` **一字不动** |
| `autoTag/clean.ts`       | 逐字 | `prepareTargetText`, `cleanHistoryText`, `TargetSegment`, `PreparedTargetText`                              | 无（纯函数，直接搬）                                                                                   |
| `autoTag/protocol.ts`    | 逐字 | `parseImagePlan`, `parseComicPlan`, `injectImageTags`, `ImagePlan`, `ImageInsertion`                        | 无（纯函数，直接搬）                                                                                   |
| `autoTag/rebase.ts`      | 逐字 | `rebaseImagePositions`, `RebaseReport`                                                                      | 无（纯函数，直接搬）                                                                                   |
| `autoTag/charAnchors.ts` | 逐字 | `resolveCharAnchors`, `applyPositionedCharRefs`, `entriesAtPosition`, `formatEntryForPrompt`                | 依赖的 `charTags` 类型改从 Adapter 导入                                                               |
| `autoTag/slotPlan.ts`    | 逐字 | `buildSlotTaskNote`                                                                                         | 无                                                                                            |
| `st/imageTagRegex.ts`    | 逐字 | `serializeImageTag`, `parseImageTagContent`, `parseImageTags`, `stripImageTags`, `FORBIDDEN_SUBTAG`         | 仅保留与 tag 序列化相关的导出；`ensureImageTagRegexRegistered` 不搬（那是显示侧，CCExtra 不动）                       |
| `api/client.ts`          | 适配 | `requestCompletion`, `requestViaMainApi`, `buildRequestBody`, `extractContent`, `readSseContent`, `ChatMsg` | `getContext()` 走 Adapter；请求历史埋点 `state/history` 可先做成 no-op（见 §8）                             |
| `backends/size.ts`       | 逐字 | `normalizeOrientation`, `Orientation`                                                                       | 无                                                                                            |
| `backends/nai.ts`（判定子集）  | 逐字 | `isNai5`, `isNai45`, `naiSupportsCharacterPrompts`                                                          | 只搬这三个纯判定函数，别搬出图逻辑                                                                            |

### 3.2 Adapter（薄适配层）

| 上游来源                                                                  | CCExtra 要提供                                                                    | 读取位置（精确）                                                                               |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| `state/settings.ts` 的 `settings` 单例                                   | `adapter.settings`（同形状对象，请求时**现读现组**）                                          | `extensionSettings['baibai_image']`（私有设置根键，行 1158）                                     |
| `getTagGenChannel()`                                                  | `adapter.getTagGenChannel()`                                                   | 指派 ID：`baibai_image.assignments.tagGen`；渠道列表：`baibai_api_channels.channels`（共享，行 2370） |
| `settings.excludes.customStripTags`                                   | `adapter.stripTags()`                                                          | `extensionSettings['baibai_exclude_settings'].customStripTags`（共享，行 2471）              |
| `activeNaiPlan()` / `activeComfyPreset()` / `activeOrientationLock()` | 同名函数                                                                           | `baibai_image.nai.*` / `.comfyui.*`，口径见 §5.4                                           |
| `state/charTags.ts`                                                   | `adapter.charTagsBeforeFloor`, `lockedCharTagNames`, `makeCharTagFloorDelta` 等 | 每楼 `message.extra['bbiCharChanges']`（行 92）+ 全局库 `baibai_image_char_global`（行 28）       |
| `autoTag/bookMemory.ts`                                               | `adapter.readBookMemory`                                                       | `globalThis.STBaiBaiBook`（apiVersion 1，`getContextAtFloor`/`getSnapshot`）              |
| `autoTag/context.ts`                                                  | `adapter.fetchWorldInfo`, `fetchCharCard`, `fetchUserPersona`                  | ST 全局：`getCheckWorldInfo`, `getContext`, `substituteParams`, `getEjsTemplate`          |
| `st/messageEdit.ts`                                                   | `adapter.applyMessageText`                                                     | ST 全局 `getContext().saveChat()` + 事件 `MESSAGE_EDITED`/`MESSAGE_UPDATED`                |

### 3.3 新增（CCExtra 独有）

| 文件                      | 职责                                                                 |
| ----------------------- | ------------------------------------------------------------------ |
| `selection/capture.ts`  | 从 ST 编辑区取划线文本 + 楼层号 + swipe；行对齐；产出 `SelectionSource`               |
| `runner.ts`             | 复刻 `runForFloor` 的编排，但 `source` 来自 `SelectionSource`；去自动触发/去重/事件绑定 |
| `consistency/golden.ts` | 黄金样例生成与 hash 对拍（§7.3）                                              |
| `consistency/drift.ts`  | 上游锚点漂移检测（§7.4）                                                     |

---

## 4. 一条划线如何走完全链路（时序）

```
用户划线 → capture.ts
  ① 取 selection 文本（逐字），记录 floor / swipe / 起止行
  ② 行对齐：左右扩到完整物理行边界（见 §5.2 铁律）
  ③ 得到 source = 对齐后的划线原文
        │
        ▼
runner.ts（复刻 runForFloor，去掉自动事件绑定）
  ④  context = getContext()          [Adapter]
  ⑤  preparedTarget = prepareTargetText(source, stripTags)   [Core 逐字]
        · segments = [{id:'P1', sourceLine, text}, ...]
        · promptText = 每行 text + ' ⟦P1⟧' 拼接
  ⑥  profile = autoTagProfile()      [Core 逐字，请求开始快照一次]
  ⑦  memory  = adapter.readBookMemory(floor, 划线文本 or 整楼mes, name1)
  ⑧  anchors = resolveCharAnchors(charTagsBeforeFloor(floor), lockedNames)  [Core+Adapter]
  ⑨  messages = await buildAutoTagMessages(
        ctx, floor, autoTagSettings, memory, preparedTarget,
        anchors.text, taskNote='', profile)                  [Core 逐字]  ★L1 校验点
        │
        ▼
 ⑩  重试循环（retryCount+1 次）：
       validate = raw => {
         plan = profile.comic ? parseComicPlan(raw, preparedTarget.segments)
                              : parseImagePlan(raw, preparedTarget.segments, min, max)
         if (profile.naiCharPrompts && profile.nl && 建档缺 nl) throw
       }
       channel ? requestCompletion(channel, messages, {signal, source, validate})
               : requestViaMainApi(messages, {...})           [Core 适配]  ★L1 请求点
        │
        ▼
 ⑪  plan = { images[], changes[] }                            [Core 逐字解析]  ★L2 校验点
 ⑫  后处理（逐字照抄 runner 行 435–518）：
       · planChangeOps → changes 转库操作；过滤锁定名
       · 逐 image：nl/lockedSize 归一；applyPositionedCharRefs 做 @角色 → 固定外貌串替换
       · unknownNames → 告警
        │
        ▼
 ⑬  写回（唯一因「划线」而变化的落点逻辑）：
       rebased = rebaseImagePositions(
         currentText = 整楼现文,        ← 注意：不是划线文本
         plannedSegments = preparedTarget.segments,   ← 划线内 segments
         plan.images, stripTags)                       [Core 逐字]  ★L3 校验点
       nextText = injectImageTags(整楼现文, rebased.images)    [Core 逐字]
       await applyMessageText(floor, () => nextText, chatId, swipeId, message,
              { key:'bbiCharChanges', value: makeCharTagFloorDelta(floorOps, swipeId) })
        │
        ▼
 ⑭  触发出图：调柏宝绘公开 generate()（见 §8），或交给用户手动点卡片
```

**关键差异只有两处**（其余全是逐字照抄）：第 ④–⑤ 步的 `source` 来源；第 ⑬ 步 rebase 的 `currentText` 用整楼现文、`plannedSegments` 用划线 segments。其余每一步都是上游函数的原样调用。

---

## 5. 数据契约

### 5.1 划线对象 `SelectionSource`

```ts
interface SelectionSource {
  floor: number;          // 目标楼层（ST 的 mes 索引）
  swipeId: number;        // 当前 swipe，写回 CAS 要用
  chatId: string;         // getContext().getCurrentChatId()
  rawText: string;        // 用户划中的原文（逐字，未清洗）
  source: string;         // 行对齐后的划线原文 → 交给 prepareTargetText
  startLine: number;      // 对齐后首行在整楼正文中的物理行号（诊断用）
  endLine: number;        // 对齐后末行物理行号（诊断用）
  textHash: string;       // 同 runner 的 textHash（FNV-1a，见 §5.5）
}
```

### 5.2 `sourceLine` 语义转换（全方案最关键、最易出 bug 的一节）

这是「划线」与「整楼」唯一真正不同的地方，必须理解透，否则 tag 会插错行。

**柏宝绘整楼模式**：`source = 整楼 mes` → `segments[i].sourceLine` 是**整楼正文的物理行号** → rebase 的 `plannedSegments` 和 `currentText` 同源，行号直接可比。

**CCExtra 划线模式**：`source = 划线文本` → `segments[i].sourceLine` 是**划线文本内部的行号（0-based）**，不是整楼行号！

因此 rebase 必须这样对齐：

```
plannedSegments : 划线内部 segments（sourceLine = 划线内行号，text = 划线叙事行）
currentText     : 整楼现文
newSegments     : prepareTargetText(整楼现文).segments（sourceLine = 整楼物理行号）

rebase 用 segment.text 做 LCS 锚定：
   划线叙事行  ──文本相等──▶  整楼里的同一行
   返回 images[].sourceLine = 整楼物理行号
   injectImageTags(整楼现文, images) 插回正确位置
```

**三条铁律（违反必错）**：

1. **划线必须是整楼正文的逐字连续子串**。rebase 的 LCS 靠 `segment.text` 字符串相等锚定；划线里只要有一个字被改写（翻译/润色/简繁），该行锚不上，会走 `remapped`（按空隙比例）或 `drifted`（顺延上一段），落点就可能偏。→ 划线取 ST 编辑器的原始 selection，不要经过任何规范化。
2. **划线必须行对齐**。若划线从半行开始/在半行结束，首/末行的 `retainedLineText` 与整楼完整行的 `text` 不等，LCS 锚不上这两行。→ capture 阶段把左边界扩到行首、右边界扩到行尾（含换行为止）。
3. **跨楼必须拆开处理**。段尾位置 ID `⟦Pn⟧` 和 `sourceLine` 都是**楼层内**语义。一次划线若跨多楼，按楼切成多个 `SelectionSource`，每楼独立跑 ④–⑬，绝不拼成一个 `source`。

### 5.3 上下文与记忆来源（决定 L1 是否真的「一样」）

这些函数的入参若与柏宝绘不一致，`messages` 就会不同。逐条钉死：

| 数据                | 柏宝绘口径（runner/prompt 源码）                                                                                            | CCExtra 必须                                                            |
| ----------------- | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| 上下文楼 `previous`   | `recentFloors(ctx, targetFloor, contextMessages)`：目标楼及之前最近的 N 个 AI 故事楼及其间 user 楼，`cleanHistoryText` 清洗，**目标楼计入数量** | 原样保留，用真实 `floor`，**不要因为划线而裁剪上下文**——这正是「只换一层楼内容，仅此而已」                  |
| 世界书扫描             | `fetchWorldInfo(chat, scanFloors=recentFloors(...), name1, name2)`，刷宏 + EJS                                        | 原样                                                                    |
| 角色卡 / 人设          | `fetchCharCard(ctx)` / `fetchUserPersona(ctx)`                                                                     | 原样                                                                    |
| 角色参考 `memory`     | `readBookMemory(floor, context.chat[floor].mes, name1)` —— 在场判定用**整楼 mes**                                         | **建议继续用整楼 mes**（角色在场是楼层级事实，不应随划线缩小）；若要改用划线，记为 `LOCAL PATCH` 并接受与柏宝绘分叉 |
| 角色固定外貌库 `library` | `resolveCharAnchors(...).text`                                                                                     | 原样（楼层级库，不随划线变）                                                        |
| 破限词/规范/思维链        | 请求时现读 `baibai_image.autoTag.prompts`，留空回落内置默认                                                                      | 现读，不缓存（见 §6）                                                          |


> 一句话：**除了「目标正文」那一段，喂给 LLM 的所有上下文都按整楼/整聊天的真实状态取，和柏宝绘对同一楼分析时完全一致。**

### 5.4 配置读取清单（Adapter 的精确口径）

| 字段                                       | 读取路径                                                                                                          | 回落 / 分支                                                                      |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `defaultBackend`                         | `baibai_image.defaultBackend`                                                                                 | `nai` / `comfyui` / `webui`                                                  |
| `autoTag.*`                              | `baibai_image.autoTag`                                                                                        | `minImages`/`maxImages`/`retryCount`/`contextMessages`/`prompts`             |
| `prompts.jailbreak`                      | `baibai_image.autoTag.prompts.jailbreak`                                                                      | 空 → `DEFAULT_JAILBREAK_PROMPT`                                               |
| `prompts.naiV5Spec` / `.naiSpec`         | 同上                                                                                                            | 空 → `DEFAULT_NAI_V5_SPEC` / `DEFAULT_NAI_SPEC`                               |
| `prompts.naiV5Thinking` / `.naiThinking` | 同上                                                                                                            | 空 → `DEFAULT_NAI_V5_THINKING` / `DEFAULT_NAI_THINKING`                       |
| ComfyUI 规范/思维链                           | `activeComfyPromptSet()`：`baibai_image.comfyui`                                                               | 空 → `builtinComfyPromptSet(kind)`；`{{nl}}` 宏按开关展开（§6.2）                      |
| `naiCharPrompts`                         | `backend==='nai' && naiSupportsCharacterPrompts(activeNaiPlan().model)`                                       | `isNai45 ‖ isNai5`；4.5 = model 含 `nai-diffusion-4-5`，5 = 含 `nai-diffusion-5` |
| `nl`                                     | ComfyUI：`preset.kind==='illustration' && preset.naturalLanguage`；NAI：`naiCharPrompts && plan.naturalLanguage` | 漫画方案不看 nl 开关                                                                 |
| `lockedSize`                             | `activeOrientationLock()`：`auto`→`null`，否则 `portrait`/`landscape`                                             | NAI 取渠道级，ComfyUI 取当前工作流                                                      |
| `comic`                                  | `backend==='comfyui' && activeComfyPreset().kind==='comic'`                                                   | NAI 恒 false                                                                  |
| `stripTags`                              | `baibai_exclude_settings.customStripTags`（共享）                                                                 | 空数组                                                                          |
| `tagGen` 渠道                              | `baibai_image.assignments.tagGen` → 在 `baibai_api_channels.channels` 找 id                                     | 找不到/空 → 跟随主 API（`generateRaw`）                                               |

> **现读原则**：以上全部在**每次划线请求开始时**读一次并快照成 `profile`；不缓存、不跨请求复用。这样用户在柏宝绘里把提示词 A 改成 B、把方案 A 换成 B，CCExtra 下一次划线立刻一致。

### 5.5 去重与并发（复刻 runner 行 98–105、304–324、321–324）

- `textHash`：FNV-1a 变体，`hash=2166136261; for ch: hash^=code; hash=imul(hash,16777619); return (hash>>>0).toString(36)` —— 逐字搬。
- `identity = chatId + '\0' + floor + '\0' + swipeId + '\0' + textHash(source)` —— 划线模式下 `source` 变了，identity 自然不同，同一楼不同划线可分别分析。
- 每楼一把 `AbortController`：CCExtra 可能需要「每楼每划线」一把锁，避免同一楼连续划线互相覆盖。记为 `LOCAL PATCH`。

---

## 6. 三份提示词与内置常量（逐字复制清单）

L1 一致性的最大敌人是「以为一样、其实差一个字」。以下文本必须**逐字复制**到 `vendored/builtinPrompts.ts`，不可重写、不可格式化。

| 常量                            | 上游位置               | 用途 / 回落                                |
| ----------------------------- | ------------------ | -------------------------------------- |
| `DEFAULT_JAILBREAK_PROMPT`    | `settings.ts:536`  | 破限词；`prompts.jailbreak` 空时回落，置顶 system |
| `DEFAULT_NAI_SPEC`            | `settings.ts:709`  | NAI 4 及以下 tag 规范                       |
| `DEFAULT_NAI_THINKING`        | `settings.ts:869`  | NAI 4 及以下思维链                           |
| `DEFAULT_NAI_V5_SPEC`         | `settings.ts:1047` | NAI 4.5/V5 规范（Char Prompts 口径）         |
| `DEFAULT_NAI_V5_THINKING`     | `settings.ts:946`  | NAI 4.5/V5 思维链                         |
| `DEFAULT_COMFY_THINKING`      | `settings.ts:790`  | ComfyUI 思维链；webui 也回落它                 |
| `DEFAULT_COMFY_NL_SPEC`       | `settings.ts:691`  | ComfyUI 自然语言规范                         |
| `builtinComfyPromptSet(kind)` | `settings.ts:1295` | ComfyUI 内置规范+思维链集                      |

### 6.1 硬编码任务协议（`prompt.ts` 内，必须逐字）

`fixedContract`（行 322–335）、`comicContract`（行 364–384），以及它们依赖的局部变量：  
`outputShape`(252)、`sampleImage`(226–249)、`naiCharacterRuleTail`(254)、`contentRule`(256–262)、`negativeRule`(263–265)、`imageCountRule`(271–274)、`sizeRule`(279–284)、`libraryReferenceRule`(286–288)、`newCharacterNlRule`(290–294)、`profileRules`(296–303)、`newCharacterRule`(304–305)、`multiCharacterBindingRule`(306–308)、`permanentChangeRules`(309)、`lockedAndTemporaryRules`(310–312)、`characterRule`(313–320)、`comicSizeRule`(358–363)。

> 这些字符串里有中文标点、`⟦⟧` 特殊括号、英文规则、`characters[]` 字段分工——**任何一个字符变化都会改变模型行为**。用工具按行复制，不要手打。

### 6.2 两个易漏的展开逻辑

1. `expandNlSections(text, nlOn)`（行 80–84）：`{{#nl}}…{{/nl}}` 开保留 / `{{^nl}}…{{/nl}}` 关保留；**嵌套不支持、失配原样留**。规范与思维链都要先过它。
2. ComfyUI 规范 `{{nl}}` 宏（行 94–105）：规范含宏则替换成 `DEFAULT_COMFY_NL_SPEC`（关时置空）；不含宏但开启 nl 则**追加**到末尾；最后 `replace(/\n{3,}/g, '\n\n').trim()`。

### 6.3 system 消息顺序（L1 对拍必看）

`buildAutoTagMessages` 行 388–407 的 push 顺序，逐条不可换：

```
1  jailbreak           (system)   ← 永远第一条
2  buildCharCardSystem (system)   ← 有则带
3  buildPersonaSystem  (system)   ← 有则带
4  buildWorldInfoSystem(system)   ← 有则带
5  backendPromptSpec   (system)   ← 有则带
6  fixedContract | comicContract (system)
7  backendThinkingPrompt (system) ← 协议之后
8  user = memoryText + '\n\n' + libraryBlock + '\n\n' + taskBlock
        + (previous ? previous + '\n\n' : '')
        + '--- 目标正文｜' + roleLabel + ' ---\n' + preparedTarget.promptText
```

|                            |   |       |   |                          |   |       |   |                                 |
| -------------------------- | - | ----- | - | ------------------------ | - | ----- | - | ------------------------------- |
| 注意 `roleLabel`：\`user（name |   | name1 |   | 'User'）`/`assistant（name |   | name2 |   | 'Assistant'）\`（行 154–158），全角括号。 |

---

## 7. 一致性保障工程（让「一模一样」可持续）

柏宝绘是别人的项目、会升级。复刻若不设防，升级即漂移。以下三件套是工程文件里**必须常驻**的机制。

### 7.1 上游锚点（pin）

- 记录克隆时的 commit hash、克隆日期、关键文件 SHA256，写入 `VENDORED.md`。
- 每次柏宝绘发版，先跑 §7.4 漂移检测，再决定是否同步 vendored 文件。

### 7.2 逐字复制 + LOCAL PATCHES 标注

每个 vendored 文件头：

```
// VENDORED FROM ST-BaiBai-Image @ <commit>
// SOURCE: src/autoTag/prompt.ts
// DO NOT EDIT LOGIC — 逻辑改动必须回到上游并重新复制。
// LOCAL PATCHES: (1) import 路径改为 @/adapter/settings  [2026-11-20]
```

文件尾列出所有本地差异。排错时第一件事就是看这份 patch 列表有没有越过「只换数据来源」的边界。

### 7.3 黄金样例 / hash 对拍（L1 的判定器）

建立 `fixtures/`，每个 case 一个 JSON：`{chat, targetFloor, selectionSource, settingsSnapshot, memory, library, expectedMessagesSha256, expectedPlanSha256}`。

流程：

1. 用固定输入在 CCExtra 跑 `buildAutoTagMessages`，把 `messages` 序列化为稳定 JSON（键排序、无随机字段）→ `sha256` → 与 `expectedMessagesSha256` 比。
2. 同一输入在柏宝绘侧跑一次（用其自身测试夹具或临时插桩打印 `messages`）→ 算出上游 hash → 与 CCExtra 的 hash 比。**两边相等才算「分析过程一模一样」。**
3. 覆盖矩阵至少：NAI 4.5/V5（nl 开/关 × 锁竖/锁横 × 有库/无库）、NAI 4、`ComfyUI 插画`（nl 开/关 × 简单/自定义工作流 × negative 有/无）、`ComfyUI 漫画`、划线在首段/中段/末段/跨楼拆分。

> 这条是整套方案的「体检报告」。柏宝绘升级后，重跑对拍；只要 hash 不等，就说明协议漂移，先修一致性再谈新功能。

### 7.4 漂移检测

`consistency/drift.ts`：对 §3.1 里每个 `逐字` 文件，重新拉取上游 @pin commit，比对除 `LOCAL PATCHES` 允许范围外的差异；输出 diff 摘要。接入构建脚本，CI 红灯即停。

---

## 8. 与柏宝绘的边界（能拿什么、不碰什么）

| 事项                           | 做法                                                                           | 理由                                                           |
| ---------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 方案 / 接入点 / 画师串 / 提示词 / 副 API | **只读**柏宝绘配置（§5.4），不写、不新增 UI 口子                                               | 用户要求「一切在柏宝绘里完成」                                              |
| 明文 API Key                   | 分析阶段**不读**出图接入点的 key；副 API key 只在内存用于发请求，不落日志/正文                             | 防泄漏；与柏宝绘公开接口不返回 key 的口径一致                                    |
| 切方案到 B 再切回 A                 | 走前人项目的 UI 点击 + 引用计数方案（已定），不写设置                                               | 外部写设置会被柏宝绘启动时单例覆盖                                            |
| 出图（B 段）                      | tag 写回正文后，调柏宝绘公开 `generate()`（或点卡片手动出）                                       | 复用画师串拼接、并发闸门、落盘图库，保证出图口径不漂                                   |
| tag 与 changes 序列化            | 必须与柏宝绘同格式：`<bbi_image>…<size>…</size></bbi_image>`、`extra['bbiCharChanges']` | `generate()` 与图库靠这个格式解析；`promptHash` 吃正文原文，格式漂移会导致「全变 stale」 |
| 请求历史埋点                       | 先接 no-op；若要与柏宝绘历史同源，再接 `state/history` 的 `beginLlm/finishLlm/failLlm`        | 埋点不影响主流程，可以后补                                                |

> 落盘 tag 格式的两个硬性口径（来自 `imageTagRegex.ts`）：插画 tag 的 tag 部分保持裸文本、nl/negative/characters 空则整段不写、**size 恒写出**；插画**不写** `<type>`（写了会换 `promptHash` 桶）；漫画才写 `<type>comic</type><layout>…</layout><size>…</size>`。

---

## 9. 排错索引（本文的核心用途）

### 9.1 先看日志（所有环节的统一探针）

上游 runner 有诊断前缀 `[BBI][AutoTagDebug]` + event 名。CCExtra 的 vendored 编排**保留同样的 event 名**，但换成自己的前缀（如 `[CCX][AutoTagDebug]`），便于两边对拍。关键 event：

`runForFloor:enter` / `:skip`（带 reason）/ `:start`（带 sourceLength、segmentCount、identity）/ `runForFloor:skip reason=already-processed` / tag 失败 `第 N 楼第 x/y 次生成 tag 失败`。

### 9.2 故障树

| 现象                    | 最可能环节                                                                                        | 立刻检查                                                                                         |
| --------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 两遍请求 `messages` 不一致   | §6 提示词/协议文本被改，或 §5.3 上下文口径分叉                                                                 | 跑 §7.3 黄金对拍，diff 第一条 system 与 user 段                                                         |
| 模型不输出 JSON / 总重试耗尽    | `fixedContract` 被改动；`profile` 快照错；`{{nl}}`/`{{#nl}}` 展开错                                     | 核对 §6.1/§6.2；看 `:start` 的 segmentCount 是否=划线叙事行数                                             |
| tag 插错行 / 插到别的楼       | 违反 §5.2 铁律：划线非逐字连续、未行对齐、跨楼未拆                                                                 | 打印 `preparedTarget.segments` 与 rebase 的 `report{anchored,remapped,drifted}`；drifted>0 即锚定失败  |
| 「本楼没有值得插图的画面」但划线里明显有戏 | source 传错（传成空/整楼旧文）；段尾 ID 没进 promptText                                                      | 看 `:start` 的 sourceLength、检查 `promptText` 是否含 `⟦P1⟧`                                         |
| 建档总被丢弃                | `parseNewFields` 要求 hair+eyes 必填（protocol.ts 行 293）；NAI V5+nl 还要求 new 带 nl（runner 行 382–389） | 看 LLM 输出的 changes 字段；看是否有 `NAI 4.5/V5 建档必须附带 nl` 报错                                          |
| 角色外貌没进 tag            | `applyPositionedCharRefs` 没匹配到 @；或角色未建档进 `unknownNames`                                      | 看 `角色「X」没有建档` 警告；核对 `anchors.text` 是否含该角色                                                    |
| tag 写回失败 / 被放弃        | CAS 身份检查：`chat-changed`/`floor-changed`/`swipe-changed`/`build-failed`（messageEdit.ts）       | 核对 `chatId`/`swipeId` 是否正确传入；`build-failed` 看是否整楼已有 tag 痕迹                                   |
| 「什么都没改却全变 stale」      | tag 序列化格式漂移（`<type>`/size/空段写错）                                                              | 比对 `serializeImageTag` 输出与柏宝绘逐字；查 `promptHash` 输入                                            |
| 副 API 401/超时/空内容      | 渠道读错或 URL 规范化                                                                                | 核对 `baibai_api_channels` 与 `assignments.tagGen`；`normalizeUrl` 逻辑（client.ts 42–48）；超时默认 180s |
| 换方案后风格变了              | 配置被缓存、没现读；或 `profile` 没在请求开始快照                                                               | 确认 §5.4 现读原则；确认 `profile` 在 prompt 与验收间共用同一份                                                 |
| 升级柏宝绘后突然不一致           | 上游协议漂移                                                                                       | 跑 §7.4 漂移检测 + §7.3 对拍，定位到具体文件                                                                |

### 9.3 三个「一眼定位」的断言

加在 CI 或开发模式，红灯即停：

1. `messages[0].role === 'system' && messages[0].content === jailbreakResolved`（破限词永远置顶）。
2. `preparedTarget.segments.length > 0 && promptText.includes('⟦P1⟧')`（目标正文带段尾 ID）。
3. `rebased.images.every(img => img.sourceLine < 整楼现文分行数)`（落点不越界）。

---

## 10. 实施里程碑（建议顺序）

| 阶段                  | 交付                                                                 | 通过标准                               |
| ------------------- | ------------------------------------------------------------------ | ---------------------------------- |
| M0 锚定               | 克隆柏宝绘 @pin；写 `VENDORED.md`；建 fixtures 骨架                           | 关键文件 SHA256 记录齐全                   |
| M1 纯函数搬运            | clean / protocol / rebase / imageTagRegex / size / nai判定 逐字复制 + 单测 | 上游单测原样跑通                           |
| M2 Adapter          | settings/channels/stripTags/charTags/bookMemory/context 读取层        | 每个字段能与柏宝绘界面对上值                     |
| M3 提示词层             | prompt.ts + builtinPrompts 逐字复制 + 展开逻辑                             | 黄金对拍 `messages` hash 相等（**L1 达标**） |
| M4 解析层              | protocol 解析 + changes 后处理 + @替换                                    | 黄金对拍 `plan` 相等（**L2 达标**）          |
| M5 Selection Source | capture.ts（行对齐、跨楼拆分）+ runner 编排                                    | 划线首/中/末/跨楼四例落点正确（**L3 达标**）        |
| M6 落盘与出图            | applyMessageText + tag 序列化 + 接 `generate()`                        | 卡片能识别、出图与柏宝绘一致、图库可查                |
| M7 一致性常驻            | 漂移检测 + CI 对拍 + 排错探针                                                | 升级柏宝绘后能自动报警                        |

> M3 是分水岭：**先做到「把整楼当划线喂进去，发出的请求与柏宝绘完全相同」，再谈划线本身**。这样任何不一致都能归咎于「划线适配」而不是「复刻 itself」。

---

## 11. 红线清单（写了就出问题）

1. ❌ 不要重写协议文本 / 内置常量——只能逐字复制。
2. ❌ 不要在 CCExtra 里改提示词 / 新增方案的 UI 口子。
3. ❌ 不要缓存配置——每次请求现读现快照。
4. ❌ 划线不做行对齐 / 跨楼不拆 → tag 插错行。
5. ❌ rebase 的 `currentText` 传成划线文本（必须整楼现文）。
6. ❌ 把 changes 写进柏宝绘私有设置的内存单例——外部写会被启动时覆盖；只走 `extra`/全局库的标准口径。
7. ❌ 读出的明文 key 落日志或写进正文。
8. ❌ 插画 tag 写 `<type>`、漏写 `<size>`——会让 `promptHash` 全变 stale。
9. ❌ 改 vendored 文件的逻辑而不更新 `LOCAL PATCHES` 与上游锚点。

---

## 12. YAML 机器摘要（供 AI 直接消费）

```yaml
project: ST-BaiImage-CCExtra
goal: 逐字复刻柏宝绘 LLM 分析链路，仅将输入由整楼正文替换为划线文本
upstream:
  repo: baibai-git/ST-BaiBai-Image
  pin_commit: "d6c55192325264408d0881b20f4154e01d46a03f"
  key_files:
    - src/autoTag/prompt.ts
    - src/autoTag/clean.ts
    - src/autoTag/protocol.ts
    - src/autoTag/rebase.ts
    - src/api/client.ts
    - src/st/imageTagRegex.ts
consistency_levels:
  L1_request_bytes: golden_sha256_equal
  L2_parse_result: structured_equal
  L3_persistence: serialize_hash_equal
architecture:
  vendored_core: [clean, prompt, protocol, rebase, client, imageTagRegex, charAnchors, slotPlan, size, nai_predicates]
  adapter: [settings, channels, stripTags, charTags, bookMemory, context]
  new_logic: [selection_capture, runner_orchestration, consistency_tools]
only_differences:
  - source: 整楼 message.mes -> 划线文本(逐字连续子串, 行对齐, 不跨楼)
  - rebase_current_text: 整楼现文; planned_segments 来自划线
invariants:
  - jailbreak 置顶第一条 system
  - promptText 每段带 U+27E6/U+27E7 段尾 ID '⟦Pn⟧'
  - profile 请求开始快照一次, prompt 与验收共用
  - 配置每次请求现读 extensionSettings
  - 插画 tag 不写 <type>, size 恒写出
  - changes 写 extra[bbiCharChanges] 与全局库 baibai_image_char_global
storage_keys:
  private: baibai_image
  channels: baibai_api_channels
  excludes: baibai_exclude_settings
  char_global: baibai_image_char_global
  char_floor_extra: bbiCharChanges
verification:
  golden_matrix: [nai45_nl_on_off, nai45_lock, nai4, comfy_illustration, comfy_comic]
  drift_check: per_vendored_file_sha256
troubleshooting_prefix: "[CCX][AutoTagDebug]"
```

---

## 13. 落地实况（2026-11-20，M0–M7 全通）

本节是**方案与代码的对账表**。以后怀疑「文档说的和代码做的不一样」时，只信这一节。

### 13.1 里程碑

| 阶段 | 交付 | 状态 | 验收证据 |
|---|---|---|---|
| M0 锚定 | 上游 pin `d6c5519` / v0.3.6，`VENDORED.md` | ✅ | `verify:upstream` |
| M1 纯函数搬运 | clean / protocol / rebase / slotPlan / imageTagRegex / size / mossLayout / nai 判定 | ✅ | 上游单测原样跑通 |
| M2 Adapter | 只读设置 Proxy、共享渠道、charTags 重放、上下文/锚点/柏宝书 | ✅ | `state/settings.adapter.test.ts` |
| M3 提示词层 | `prompt.ts` 逐字 + 10 份内置常量脚本抽取 | ✅ | 黄金 messages SHA256 |
| M4 解析层 | protocol 解析 + changes 后处理 + @替换 | ✅ | 黄金 plan + `runner/plan.test.ts` |
| M5 Selection Source | `selection/`（定位 / 捕获 / 切片⇄整楼换算） | ✅ | 52 条划线用例 |
| M6 落盘 | `st/messageEdit.ts` 逐字 + `runner/runSelection.ts` 写回 | ✅ | `runner/runSelection.test.ts`（端到端） |
| M7 一致性常驻 | 三道闸 + 诊断前缀 | ✅ | 三闸全绿 |

### 13.2 方案 §3 的文件映射 → 真实路径

| 方案里的名字 | 真实文件 |
|---|---|
| `runner.ts`（复刻 runForFloor） | `src/runner/runSelection.ts` |
| 后处理（planChangeOps / @替换 / 漫画补外貌） | `src/runner/plan.ts` |
| `capture.ts` | `src/selection/capture.ts` + `locate.ts` + `hash.ts` |
| `sourceLine` 换算 | `src/selection/segmentPlan.ts` |
| `settings` Adapter | `src/state/settings.ts`（含 `isCurrentChatExcluded`，与上游同口径） |
| `builtinPrompts` | `src/state/settingsDefaults.ts`（脚本生成，禁手改） |
| `applyMessageText` | `src/st/messageEdit.ts`（逐字） |
| 漂移检测 | `scripts/verify-upstream.mjs` |
| 黄金样例 | `src/consistency/golden.test.ts` + `fixtures/` |
| 调试入口 | `src/ui/trigger.ts`，`globalThis.CCExtra.{capture,run,cancelAll}` |

### 13.3 与方案的四处偏差（都是刻意，不是漏）

1. **没有 `processed` 去重集合。** 方案 §5.5 复刻了上游的 identity 去重，但上游的 `processed`
   服务于「自动流程不重复跑」；本插件只在用户点击时执行，去重反而会把「用户真心想再跑一次」拦掉。
   取而代之的是**更弱、更可解释**的一条：同一 identity 写过 tag 且本楼 tag 数没减少时提示「已经出过图了」。
2. **B 段不调公开 `generate()`。** 公开接口返回 dataUrl、可选落图库，但**不写楼层 extra**——
   自己调的结果是「图库有图、卡片待生成」。改由柏宝绘卡片出图，画师串/并发/落盘/`promptHash`
   全部走它原逻辑（详见 `VENDORED.md`「B 段为什么不自己调公开接口」）。
3. **不做单槽重写（`slot`）。** 那是「改一张图的提示词」，与划线无关；需要时用柏宝绘自己的入口。
4. **`messageEdit.ts` 整文件搬运**（方案原本只列了「applyMessageText」）。它有 `document` 依赖但没有
   任何内部模块依赖，整文件搬比抽片段更安全——与 `st/context.ts` 同一条教训：
   **无内部依赖的薄封装，一律整文件搬运**。

### 13.4 三闸实测结果

```
npm run typecheck                 0 error
npm test                         26 文件 / 425 tests 全过
verify:upstream                  40 文件 SHA256 + 3 片段 + 10 常量全 MATCH
npm run build                    dist/index.js 单文件（175 KB / gzip 69 KB）
```

### 13.5 新增故障树条目

| 现象 | 环节 | 先查 |
|---|---|---|
| 点了按钮毫无反应 | 按钮没浮出（不是没执行） | `trigger:no-capture` / `trigger:skip reason=not-ai-story-message` |
| 提示「正文在你划线之后被改过了」 | 捕获指纹与当前不符 | `runSelection:skip reason=stale`，看 `captureHash` |
| 提示「已经出过图了」 | 会话内重复拦截 | `already-processed` 的 `tagCountNow` / `tagCountAfterWrite` |
| 图插到了句子中间 | 扩行失效 | `runSelection:enter` 的 `expanded` / `lines` |
| 图插到了别的段落 | 绝对行号换算错 | `runSelection:start` 的 `absoluteStartLine` 与 `describeCapture()` 对照 |
| 正文没变但卡片显示「待重新生成」 | tag 序列化漂移 | 看 `injectImageTags` 产物是否 `插画不写 <type>`、`size 恒写` |

### 13.6 相邻文档

| 文档 | 用途 |
|---|---|
| `docs/RETROSPECTIVE.md` | 从需求到落地的全流程复盘：五问五答、架构取舍的否决理由、13 个坑、变更日志、改动守则（含两个路径的同步流程） |
| `VENDORED.md` | 逐字复制登记、LOCAL PATCHES、划线模块不变量、排错入口 |
| `README.md` | 安装与使用 |

本文是「协议契约」，`RETROSPECTIVE.md` 是「决策档案」。**改动流程与版本日志只维护在后者**，避免两处不同步。
