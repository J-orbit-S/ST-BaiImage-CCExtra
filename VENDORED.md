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
| `src/backends/size.ts` | `src/backends/size.ts` | 见校验脚本 | M1 MATCH |
| `src/backends/mossLayout.ts` | `src/backends/mossLayout.ts` | 见校验脚本 | M1 MATCH |
| `src/autoTag/clean.test.ts` | 同名 | 见校验脚本 | M1 MATCH |
| `src/autoTag/rebase.test.ts` | 同名 | 见校验脚本 | M1 MATCH |
| `src/autoTag/protocol.test.ts` | 同名 | 见校验脚本 | M1 MATCH |
| `src/st/imageTagRegex.test.ts` | 同名 | 见校验脚本 | M1 MATCH |

> 精确 SHA256 由 `npm run verify:upstream -- --upstream <上游路径>` 实时计算，避免本表与文件不同步。

## 逐字抽取（非整文件）

| CCExtra 路径 | 上游路径 | 抽取内容 |
|---|---|---|
| `src/backends/nai.ts` | `src/backends/nai.ts` | `isNai5`(124-126)、`isNai45`(166-168)、`naiSupportsCharacterPrompts`(180-182) 三函数体逐字 |

## Stub（非上游代码，M2 Adapter 阶段补真实实现）

| 文件 | 对应上游 | 提供的最小面 |
|---|---|---|
| `src/st/context.ts` | `src/st/context.ts` | `STMessage`/`STContext` 类型 + `getContext()`（读 `window.SillyTavern.getContext()`，与上游测试 mock 同口径）、`getCheckWorldInfo`/`getEjsTemplate` 空实现 |
| `src/state/charTags.ts` | `src/state/charTags.ts` | 行 16–27/40–41/86–92 的类型与常量逐字；运行时函数待 M2 |
| `src/state/settings.ts` | `src/state/settings.ts` | `ComfyKind` 类型（行 63） |

## LOCAL PATCHES（本地差异登记）

| 文件 | 差异 | 理由 | 日期 |
|---|---|---|---|
| — | 无 | M1 阶段 vendored 文件零改动 | 2026-11-20 |

## 目录为何与上游同构

vendored 文件里的 import 用的是 `@/autoTag/clean` 这类路径。为保证**逐字复制后 import 一个字都不用改**，
CCExtra 采用与上游相同的 `src/autoTag|st|backends|state` 目录结构，`@` 别名指向 `src`。
任何目录重构都必须同步改 alias 且重新跑 `verify:upstream`，否则字节一致性会被破坏。
