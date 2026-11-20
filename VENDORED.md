# VENDORED — 上游锚点与逐字复制登记

> 本文件是工程方案的 §7.1 上游锚点 + §7.2 LOCAL PATCHES 登记表。
> **任何 vendored 文件的逻辑都不许改。** 要改先回上游，再重新复制 + 重新对拍。

## 上游锚点（pin）

| 项 | 值 |
|---|---|
| 仓库 | `https://github.com/baibai-git/ST-BaiBai-Image.git` |
| pin commit | `d6c55192325264408d0881b20f4154e01d46a03f` |
| commit 日期 | 2026-11-14 16:58:54 +0800 |
| 上游版本 | 0.3.6（package.json） |
| 本地工作副本 | `C:/Users/Sissy Hu/WorkBuddy/2026-11-20-16-49-50/ST-BaiBai-Image` |
| 锚定日期 | 2026-11-20 |

## 逐字复制清单

**权威清单是 `scripts/verify-upstream.mjs` 里的 `VENDORED` 数组**（本文不重复维护 39 行，避免两处不同步）。
每个 vendored 源码都必须带上游同名测试——测试是「行为没被搬运破坏」的证据。

当前共 **39 个文件**（24 个源码 + 15 个测试），按层分组：

| 层 | 文件 |
|---|---|
| 纯函数 / 文本处理 | `autoTag/clean.ts`、`autoTag/protocol.ts`、`autoTag/rebase.ts`、`autoTag/slotPlan.ts`、`autoTag/excludes.ts`、`st/imageTagRegex.ts`、`st/context.ts`、`backends/size.ts`、`backends/mossLayout.ts`、`generationMeta.ts` |
| 提示词组装（M3 核心） | `autoTag/prompt.ts` |
| 上下文装配 | `autoTag/context.ts`、`autoTag/charAnchors.ts`、`autoTag/bookMemory.ts`、`state/charTags.ts`、`state/globalCharTags.ts` |
| 副 API 调用 | `api/client.ts`、`state/history.ts` |
| 出图后端 | `backends/comfyTemplates.ts`、`backends/comfyui.ts` |
| 逐字抽取（非整文件） | `backends/nai.ts` 的三个判定：`isNai5` / `isNai45` / `naiSupportsCharacterPrompts` |

> 精确 SHA256 由 `npm run verify:upstream`（配 `BAIBAI_UPSTREAM`）实时计算。

## 三处「不是逐字复制」，各自理由

### 1. Adapter：`src/state/settings.ts`（手写）

上游 `settings.ts` 是 `reactive<ImageSettings>` 的内存单例，**任何 UI 改动都会整份回写**
`extensionSettings['baibai_image']`。照搬它 = CCExtra 也持有一份能写柏宝绘配置的对象，
写错一次就覆盖掉用户的方案与接入点（含明文 key）。所以这层刻意重写，只保留「读」：

| 能力 | 实现 |
|---|---|
| 实时读 | 每次属性访问当场读 `extensionSettings['baibai_image']`，**不缓存** → 柏宝绘里改了下一次出图立刻生效 |
| 只读铁律 | `readonlyView()` **递归**代理：顶层与深层（`settings.comfyui.promptSets = ...`）写入一律抛错 |
| 测试草稿 | 仅在测试进程（`VITEST` 环境变量）启用可写副本，与真实配置脱钩；生产永不启用 |
| 解析函数 | `activeNaiPlan` / `activeComfyPreset` / `activeComfyPromptSet` / `comfyPromptSetFor` / `activeOrientationLock` / `builtinComfyPromptSet` / `newComfyPromptSet`，语义照上游 |
| 共享渠道 | `readChannels()` / `getTagGenChannel()` 读 `extensionSettings['baibai_api_channels']`（跨插件共享，只读） |

> 草稿层里补了两项上游「出生状态」默认值：`defaultBackend='comfyui'`、一套默认 NAI 方案。
> 不补的话，上游那批未显式设置后端的用例会走进另一条分支，测的就不是原本要测的东西——
> 这正是 `prompt.test.ts` 首轮 3 条失败的原因。

### 2. `src/state/settingsDefaults.ts`（脚本生成，禁手改）

10 份内置提示词常量，549 行 / 92KB，由 `npm run extract:defaults` 从上游**按常量名逐个**扫描模板字符串抽取。
手抄任意一个字走样，「分析过程一模一样」当场失效且肉眼查不出来。

> 首版脚本按「连续行区间」抽取，把夹在常量之间的 `UiPrefs`/`ApiChannel` 等接口一起吞了进来（tsc 当场报 8 个错）。
> 已改为逐个扫描——这类错误正是「必须能被机器发现」的典型。

### 3. `src/shims/vue.ts`（等价 shim）

上游 `charTags.ts` / `globalCharTags.ts` / `history.ts` 只用到 `reactive`，且用途是让面板重渲染。
CCExtra 没有 UI，`reactive(x)` 直接返回 `x` 在语义上等价（写完立即读能拿到新值）。
由 `vite.config.ts` 与 `tsconfig.json` 的 `vue` 别名指过去，**上游文件因此一个字都不用改**。

> 边界：若上游将来在这些文件里用 `computed`/`watch`/`ref`，shim 会因缺导出当场编译失败，不会静默出错。

## 换行符不变量（自审新增）

Windows 下全局 `core.autocrlf=true` 会在 `git checkout` 时把 LF 转成 CRLF，**直接破坏 SHA256 一致性**。
三道措施缺一不可：

1. `.gitattributes` 写 `* -text`（禁止任何换行转换）；
2. 仓库本地 `git config core.autocrlf false`；
3. 加 `.gitattributes` 后必须 `git add --renormalize .`，否则旧索引条目仍缓存旧的文本属性。

验证：删除任一 vendored 文件 → `git checkout -- <file>` → 重新比对 SHA256，必须仍为 MATCH。

## 一致性双闸（互补，缺一不可）

| 闸 | 管什么 | 命令 | 机制 |
|---|---|---|---|
| ① 字节级 | 代码有没有被改 | `npm run verify:upstream` | 39 文件 SHA256 + nai 3 片段 + 10 常量逐字 |
| ② 行为级 | 跑出来的消息有没有变 | `npm test` 里的 `consistency/golden.test.ts` | 4 个场景的 messages SHA256 基准（`src/consistency/fixtures/autoTag-messages.json`） |

黄金基准覆盖：NAI + 角色提示（默认方案）、NAI 非 4.5（单串 tag 分支）、ComfyUI 关自然语言、用户自定义思维链。
确认变更符合预期后，用 `GOLDEN_UPDATE=1 npx vitest run src/consistency/golden.test.ts` 更新基准，并在 commit message 里写清原因。

## LOCAL PATCHES（本地差异登记）

| 文件 | 差异 | 理由 | 日期 |
|---|---|---|---|
| — | 无 | vendored 文件零改动（差异只在 Adapter / shim / 生成物，见上） | 2026-11-20 |

## 目录为何与上游同构

vendored 文件里的 import 用的是 `@/autoTag/clean` 这类路径。为保证**逐字复制后 import 一个字都不用改**，
CCExtra 采用与上游相同的 `src/autoTag|st|backends|state|api` 目录结构，`@` 别名指向 `src`。
任何目录重构都必须同步改 alias 且重新跑 `verify:upstream`，否则字节一致性会被破坏。

## 验收基线（每次改动后必须三项全绿）

| 关口 | 命令 | 当前结果（2026-11-20） |
|---|---|---|
| 类型检查 | `npm run typecheck` | 通过，0 error |
| 测试 | `npm test` | **24 文件 / 402 tests 全过**（334 上游 + 12 Adapter 自测 + 4 黄金哨兵 + 52 划线模块） |
| 字节一致 | `BAIBAI_UPSTREAM=<上游路径> npm run verify:upstream` | **39 文件 SHA256 + nai 3 片段 + 10 常量全部 MATCH** |

> 排错分界线：**测试挂 = 行为变了**（先看黄金基准是否该更新）；**SHA 不匹配 = 代码被改或换行被转换**；
> 两者都绿而线上不对 = 问题在 Adapter 之外（划选取词、UI、出图链路）。

## 自有代码：`src/selection/`（非 vendored，唯一允许写业务逻辑的地方）

划线出图与「整楼出图」的唯一区别是**输入文本**。上游一切照旧，所以这一层只做「DOM 选区 → 原文区间」，
不复制分析逻辑、不碰出图。四个文件，边界清楚：

| 文件 | 职责 | 是否碰 DOM |
|---|---|---|
| `locate.ts` | 三级归一化匹配 + 上下文消歧 + 扩到物理行 | 否（纯函数） |
| `hash.ts` | 正文指纹（FNV-1a + 长度），CAS 的「C」 | 否 |
| `capture.ts` | 取 Range、认 `mesid`、拒跨楼、打包快照 | 是（薄） |
| `segmentPlan.ts` | 切片行号 ⇄ 整楼行号、写回前重定位 | 否（纯函数） |

### 不变量（改这几条之前先想清楚会毁掉什么）

1. **定位宁可失败，绝不猜。** 多命中且上下文分不清时报 `ambiguous` 并中止。
   猜错的后果是 tag 插到别的段落、图画错场景，用户几乎无法察觉。
2. **区间必须扩到完整物理行。** 分析链路按物理行切段（`clean.ts` 的 `prepareTargetText`），
   只选半行会让模型看到半句话；且 `rebase` 的锚是整行文本。
3. **跨楼不合并。** 首尾 `mesid` 不同一律拒绝，由调用方拆成多次分析。
4. **切片文本以原文为准，不以 DOM 文本为准。** `capture.text` 永远是 `mes.slice(range)`，
   `domText` 只用于诊断。渲染会吃掉 markdown、折叠空白，DOM 文本不是真源。
5. **切片行号不能直接当整楼行号用。** 必须经 `planSelection` 平移。底层原因：`rebase` 的对齐锚是
   「整行文本相等」，一楼里出现两行相同文本时它会锚到第一处——`segmentPlan.test.ts` 里有一条
   对照用例专门钉住这个坑。
6. **捕获后正文被改过就不许直接写。** `planSelection` 先校验指纹，不符判 `stale`；
   `resolveWriteback` 在指纹不符时回落到 `rebase`（与柏宝绘既有口径一致）。

### 为什么 `segmentPlan.ts` 存在（最容易看不懂的一层）

分析链路被告知的插入行是**切片内**的行号（它只看到切片），但 `injectImageTags` 要的是**整楼**行号。
换算不能靠 `rebase` 完成，因为 rebase 只看文本不看位置。所以：

```
capture.range.start ──lineIndexAt──▶ 切片起始绝对行
                                      ＋ segment.sourceLine = 绝对行
```

`sliceSegments`（LLM 视角）与 `absoluteSegments`（写回视角）**同下标一一对应**，中间只差一个行号偏移。
两条路共用同一份清洗结果，避免「给模型看的」和「写回时对齐的」口径漂移。

### 排错入口（划线相关现象 → 先看什么）

| 现象 | 先查 | 命令/字段 |
|---|---|---|
| 提示「无法在原文中定位」 | 选区是否只落在渲染插入的内容上（按钮/分隔线） | `captureSelection` 返回 `not-found` |
| 提示「出现了多次」 | 楼层里有重复句，让用户多划上下文 | 返回 `ambiguous` + `candidates` |
| 划完提示跨楼 | 用户拖动跨了两个 `.mes` | 返回 `cross-message` + `detail` |
| tag 插到了句子中间 | 扩行是否生效 | `capture.expanded` / `lineCount` |
| tag 插到了错的那一段 | 是否走了 `direct` 而非按文本锚定；重复行场景 | `describeCapture()` 的 `method/candidates` |
| 分析用的文字不是选的文字 | `capture.text` 与 `domText` 的差异 | `describeCapture()` 一行摘要 |

