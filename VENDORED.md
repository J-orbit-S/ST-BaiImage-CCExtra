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

当前共 **40 个文件**（25 个源码 + 15 个测试），按层分组：

| 层 | 文件 |
|---|---|
| 纯函数 / 文本处理 | `autoTag/clean.ts`、`autoTag/protocol.ts`、`autoTag/rebase.ts`、`autoTag/slotPlan.ts`、`autoTag/excludes.ts`、`st/imageTagRegex.ts`、`st/context.ts`、`backends/size.ts`、`backends/mossLayout.ts`、`generationMeta.ts` |
| 提示词组装（M3 核心） | `autoTag/prompt.ts` |
| 上下文装配 | `autoTag/context.ts`、`autoTag/charAnchors.ts`、`autoTag/bookMemory.ts`、`state/charTags.ts`、`state/globalCharTags.ts` |
| 副 API 调用 | `api/client.ts`、`state/history.ts` |
| 出图后端 | `backends/comfyTemplates.ts`、`backends/comfyui.ts` |
| 写回（CAS） | `st/messageEdit.ts` |
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
| ① 字节级 | 代码有没有被改 | `npm run verify:upstream` | 40 文件 SHA256 + nai 3 片段 + 10 常量逐字 |
| ② 行为级 | 跑出来的消息有没有变 | `npm test` 里的 `consistency/golden.test.ts` | 4 个场景的 messages SHA256 基准（`src/consistency/fixtures/autoTag-messages.json`） |
| ③ 端到端 | 划线这一路有没有接错 | `npm test` 里的 `runner/runSelection.test.ts` | 假宿主 + 真 vendored 代码跑完整链路，断言「目标正文只有划线 / tag 落对行 / extra 格式对」 |

黄金基准覆盖：NAI + 角色提示（默认方案）、NAI 非 4.5（单串 tag 分支）、ComfyUI 关自然语言、用户自定义思维链。
确认变更符合预期后，用 `GOLDEN_UPDATE=1 npx vitest run src/consistency/golden.test.ts` 更新基准，并在 commit message 里写清原因。

## LOCAL PATCHES（本地差异登记）

| 文件 | 差异 | 理由 | 日期 |
|---|---|---|---|
| — | 无 | vendored 文件零改动（差异只在 Adapter / shim / 生成物，见上） | 2026-11-20 |

## 编排层：`src/runner/`（复刻 `runForFloor`，只有两处实质差异）

`runner.ts` 没被整文件搬过来 —— 它绑定自动事件、写 toastr、管 `processed` 去重、还要处理
单槽重写（slot）。CCExtra 走的是「用户划线 + 点按钮」，这些入口全都不适用。
所以按**同样的顺序**重写编排，逻辑段一一对应，并把只有纯函数的部分抽到 `runner/plan.ts` 以便测试。

| 上游 `runForFloor` | CCExtra `runSelection` | 差异 |
|---|---|---|
| 208–243 上下文/开关/排除/剧情楼闸门 | 同段 | 另加「捕获 swipe 与当前不符即拒绝」的 CAS |
| 281–296 `source = 整楼 mes` | `source = planSelection(...).promptText` | ★ 唯一实质差异 ① |
| 304–324 identity 去重 | 只保留「每楼一把锁」+ 会话内重复拦截 | 本插件点击即执行，没有自动流程 |
| 327–352 memory/库/anchors/协议快照 | 同段 | 记忆与库仍按**整楼**取（§5.3） |
| 358–433 重试循环 + validate 内解析 | 同段 | 解析目标换成 `sliceSegments` |
| 437–518 changes→ops、@替换、漫画补外貌 | `runner/plan.ts` | 逐字 |
| 547–585 `applyMessageText` CAS 写回 | 同段 | ★ rebase 基底用整楼现文 ② |
| 586–632 成功/失败反馈 | 同段 | 文案换成「划线出图」 |

**为什么只有这两处**：划线的语义就是「把送给 LLM 的那一层楼换成划线」，其余全部照抄。
只要出现第三处差异，就要在 review 里被拦下——那意味着「分析过程和柏宝绘一模一样」不再成立。

### B 段（出图）为什么不自己调公开接口

柏宝绘的公开 `generate()` 返回 dataUrl 并可选落盘图库，**但不写楼层 extra**
（`PublicGenerateResult` 里没有 slot 概念，图不会挂到任何卡片上）。
如果 CCExtra 自己调它，结果会是「图库里有图、楼层卡片还是待生成」，比不做更糟。

因此 B 段的选择是：**CCExtra 只负责把 tag 写对，出图交给柏宝绘的卡片**（点一下「生成图片」）。
这样画师串、vibe、负面词、并发闸门、落盘、stale 判定全部走柏宝绘原逻辑，零漂移。
自动出图（柏宝绘的 `autoGenerate` 标记）是它进程内的内存 Map，第三方无法置位——
这条也不去碰，宁可少一步自动化，也不引入一个只能靠 DOM 点击维持的脆弱链路。

### 写回后为什么还要动「楼层图片历史」（v0.1.1，数据层，不是代码差异）

柏宝绘的图片归属是 `extra.bbiImage[swipeId][promptHash][]`，每条记录带 `slotSeq` = 生成时它在
楼里是第几个 tag（`floor/storage.ts` 的 `entrySeq` / `historyEntries`）。卡片水合时按
`(promptHash, 该 tag 现在的序号)` 去查：

| 查到 | 查不到但同序号有别的 hash | 都没有 |
|---|---|---|
| ready（显示那张图） | stale（顶着别人的图 +「旧提示词」角标） | pending（待生成） |

本插件会把新 tag 插在划线之后。**若插入点在既有 tag 之前**，那条既有 tag 的序号从 N 变 N+1，
历史还记在 N 上 → 旧卡退回 pending（图被顶掉）、新卡认领旧图并标「旧提示词」。
柏宝绘没有「在楼中间手插 tag」的入口，所以它不需要处理这件事；我们的核心用法恰恰需要。

因此 `src/state/imageSlots.ts` 在**正文写成功之后**把受影响的 `slotSeq` 一起后移：

- 只改 `slotSeq` 一个字段，其余字段与条目集合原样保留；
- 结构不认识（没有 `bbiImage` / 桶不是数组 / 条目不是对象）→ **跳过并记日志**，绝不重建；
- 写回用与上游 `mutateStore` 同款 CAS（引用比对 + `saveChat`，最多 3 轮）；
- 正文没写成功就不迁移——否则序号被挪、tag 却没多，旧卡反而丢图。

**这不构成「第三处分析链路差异」**：分析用的 source 与 rebase 基底仍是那两处；
这里动的是楼层数据（柏宝绘自己每次出图也在写同一份），不改它任何一行代码。



vendored 文件里的 import 用的是 `@/autoTag/clean` 这类路径。为保证**逐字复制后 import 一个字都不用改**，
CCExtra 采用与上游相同的 `src/autoTag|st|backends|state|api` 目录结构，`@` 别名指向 `src`。
任何目录重构都必须同步改 alias 且重新跑 `verify:upstream`，否则字节一致性会被破坏。

## 验收基线（每次改动后必须三项全绿）

| 关口 | 命令 | 当前结果（2026-11-20） |
|---|---|---|
| 类型检查 | `npm run typecheck` | 通过，0 error |
| 测试 | `npm test` | **27 文件 / 451 tests 全过**（334 上游 + 12 Adapter + 4 黄金哨兵 + 58 划线取词/坐标 + 15 槽位迁移 + 28 编排/写回） |
| 字节一致 | `BAIBAI_UPSTREAM=<上游路径> npm run verify:upstream` | **40 文件 SHA256 + nai 3 片段 + 10 常量全部 MATCH** |
| 可构建 | `npm run build` | `dist/index.js` 单文件产物，34 modules |

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

