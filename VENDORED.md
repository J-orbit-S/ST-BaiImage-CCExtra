# VENDORED — 上游锚点与逐字复制登记

> 本文件是工程方案的 §7.1 上游锚点 + §7.2 LOCAL PATCHES 登记表。
> **任何 vendored 文件的逻辑都不许改。** 要改先回上游，再重新复制 + 重新对拍。

## 上游锚点（pin）

| 项 | 值 |
|---|---|
| 仓库 | `https://github.com/baibai-git/ST-BaiBai-Image.git` |
| pin commit | `d6c55192325264408d0881b20f4154e01d46a03f` |
| commit 日期 | 2026-11-14 16:58:54 +0800 |
| commit 说明 | Merge pull request #10 from baibai-git/test |
| 上游版本 | 0.3.6（package.json） |
| 本地工作副本 | `C:/Users/Sissy Hu/WorkBuddy/2026-11-20-16-49-50/ST-BaiBai-Image` |
| 锚定日期 | 2026-11-20 |

## 逐字复制清单（整文件 cp，SHA256 相等）

| CCExtra 路径 | 上游路径 | SHA256 | 状态 |
|---|---|---|---|
| `src/autoTag/clean.ts` | `src/autoTag/clean.ts` | 见校验脚本 | M1 MATCH |
| `src/autoTag/protocol.ts` | `src/autoTag/protocol.ts` | 见校验脚本 | M1 MATCH |
| `src/autoTag/rebase.ts` | `src/autoTag/rebase.ts` | 见校验脚本 | M1 MATCH |
| `src/autoTag/slotPlan.ts` | `src/autoTag/slotPlan.ts` | 见校验脚本 | M1 MATCH |
| `src/st/imageTagRegex.ts` | `src/st/imageTagRegex.ts` | 见校验脚本 | M1 MATCH |
| `src/st/context.ts` | `src/st/context.ts` | 见校验脚本 | M1 MATCH（自审后从 stub 改为整文件搬运） |
| `src/backends/size.ts` | `src/backends/size.ts` | 见校验脚本 | M1 MATCH |
| `src/backends/mossLayout.ts` | `src/backends/mossLayout.ts` | 见校验脚本 | M1 MATCH |
| `src/autoTag/clean.test.ts` | 同名 | 见校验脚本 | M1 MATCH |
| `src/autoTag/rebase.test.ts` | 同名 | 见校验脚本 | M1 MATCH |
| `src/autoTag/protocol.test.ts` | 同名 | 见校验脚本 | M1 MATCH |
| `src/autoTag/slotPlan.test.ts` | 同名 | 见校验脚本 | M1 MATCH |
| `src/st/imageTagRegex.test.ts` | 同名 | 见校验脚本 | M1 MATCH |
| `src/st/context.test.ts` | 同名 | 见校验脚本 | M1 MATCH |
| `src/backends/size.test.ts` | 同名 | 见校验脚本 | M1 MATCH |
| `src/backends/mossLayout.test.ts` | 同名 | 见校验脚本 | M1 MATCH |

合计 16 个文件：8 个源码 + 8 个测试。**凡是搬了的源码，必须搬它的同名测试**——测试是「行为没被搬运破坏」的证据。

> 精确 SHA256 由 `npm run verify:upstream -- --upstream <上游路径>` 实时计算，避免本表与文件不同步。

## 逐字抽取（非整文件）

| CCExtra 路径 | 上游路径 | 抽取内容 |
|---|---|---|
| `src/backends/nai.ts` | `src/backends/nai.ts` | `isNai5`(124-126)、`isNai45`(166-168)、`naiSupportsCharacterPrompts`(180-182) 三函数体逐字 |

## Stub（非上游代码，M2 Adapter 阶段补真实实现）

| 文件 | 对应上游 | 提供的最小面 |
|---|---|---|
| `src/state/charTags.ts` | `src/state/charTags.ts` | 行 16–27/40–41/86–92 的类型与常量逐字（含 `CHAR_TAG_FIELDS` 与 `BBI_CHAR_EXTRA_KEY`）；运行时函数待 M2-b |

> 判定原则：**凡是没有内部依赖的薄封装，一律整文件搬运，不留手写 stub**。
> `src/st/context.ts` 原本是手写 stub，自审时发现 `getContext()` 与上游有细微差异（多了 `globalThis` 兜底、少了 try/catch），
> 已改为整文件 cp——stub 与上游只要不是同一份代码，就迟早会在某个分支上表现不同。

## Adapter（唯一允许「不是逐字复制」的层）

Adapter 存在的理由：上游 `settings.ts` 是 `reactive<ImageSettings>` 的内存单例，**任何 UI 改动都会整份回写**
`extensionSettings['baibai_image']`。照搬它 = CCExtra 也持有一份能写柏宝绘配置的对象，
一旦写错就会覆盖用户的方案与接入点（含明文 key）。因此这一层刻意重写，只保留「读」。

| 文件 | 性质 | 说明 |
|---|---|---|
| `src/state/settings.ts` | 手写 Adapter | `settings` 为**只读 Proxy**：每次属性访问当场读 `extensionSettings['baibai_image']`（不缓存 → 柏宝绘改了立刻生效）；`set`/`delete`/`defineProperty` 一律抛错。实现 `activeNaiPlan` / `activeComfyPreset` / `activeComfyPromptSet` / `activeOrientationLock` / `builtinComfyPromptSet`，语义照上游 |
| `src/state/settingsDefaults.ts` | **脚本生成** | 10 份内置提示词常量，由 `npm run extract:defaults` 从上游按常量逐个抽取，禁止手改 |
| `src/state/settings.adapter.test.ts` | 自写测试 | 12 条：只读抛错、实时刷新、方案回落、类型不匹配回落、空设置不崩 |

### 为什么提示词常量必须脚本抽取

这 10 份文本合计 549 行 / 92KB，手抄任意一个字走样，「LLM 分析过程与柏宝绘一模一样」就当场失效，
而且肉眼查不出来。脚本抽取 + `verify:upstream` 反向校验（每个常量必须仍逐字存在于上游）是唯一可靠做法。

> 首版脚本按「连续行区间」抽取，把夹在常量之间的 `UiPrefs`/`ApiChannel` 等接口一起吞了进来（tsc 当场报 8 个错）。
> 已改为**按常量名逐个扫描模板字符串**——这类错误正是「必须能被机器发现」的典型。

## 换行符不变量（2026-11-20 自审新增）

Windows 下全局 `core.autocrlf=true` 会在 `git checkout` 时把 LF 转成 CRLF，**直接破坏 SHA256 一致性**。
已采取两道措施，二者缺一不可：

1. `.gitattributes` 写 `* -text`（禁止任何换行转换）；
2. 仓库本地 `git config core.autocrlf false`；
3. 加 `.gitattributes` 后必须执行 `git add --renormalize .`，否则旧索引条目仍缓存旧的文本属性。

验证方式：删除任一 vendored 文件 → `git checkout -- <file>` → 重新比对 SHA256，必须仍为 MATCH。

## LOCAL PATCHES（本地差异登记）

| 文件 | 差异 | 理由 | 日期 |
|---|---|---|---|
| — | 无 | M1 阶段 vendored 文件零改动 | 2026-11-20 |

## 目录为何与上游同构

vendored 文件里的 import 用的是 `@/autoTag/clean` 这类路径。为保证**逐字复制后 import 一个字都不用改**，
CCExtra 采用与上游相同的 `src/autoTag|st|backends|state` 目录结构，`@` 别名指向 `src`。
任何目录重构都必须同步改 alias 且重新跑 `verify:upstream`，否则字节一致性会被破坏。

## 验收基线（每次改动后必须三项全绿）

| 关口 | 命令 | 当前结果（2026-11-20） |
|---|---|---|
| 类型检查 | `npm run typecheck` | 通过，0 error |
| 上游测试 | `npm test` | **9 文件 / 167 tests 全过**（155 上游 + 12 自写 Adapter） |
| 字节一致 | `BAIBAI_UPSTREAM=<上游路径> npm run verify:upstream` | **16 文件 SHA256 全 MATCH + nai 3 片段 MATCH + 10 份内置提示词逐字 MATCH** |

测试分布：clean 15、protocol 37、rebase 12、imageTagRegex 51、slotPlan 7、size 13、mossLayout 14、context 6（上游共 155）+ settings.adapter 12（自写）。

> 这三项不是形式，是后续排错的分界线：
> **测试挂 = 搬运破坏了行为**；**SHA 不匹配 = 有人改了 vendored 文件或换行被转换**；
> 两者都绿而线上不对 = 问题一定在 Adapter / 业务层（M2 之后）。
