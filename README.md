# ST-BaiImage-CCExtra · 柏宝绘伴生插件

**在正文里划一段 → 点「划线出图」→ tag 就插在那一段后面。** 分析过程与柏宝绘**逐字一致**，只是把送给 LLM 的「一整层楼」换成了你划的那几行。

- 不修改柏宝绘任何一行代码，只读它的设置与角色库；
- 没有自己的设置面板：破限词、规范、思维链、方案、接入点、副 API 全在柏宝绘里改，本插件每次请求现读；
- 出图（B 段）交给柏宝绘的卡片，画师串 / 负面词 / 并发 / 图库全部走它的原逻辑。

```
划线 ──▶ 行对齐 ──▶ 柏宝绘的 clean→prompt→副API→protocol→rebase ──▶ 写回正文 ──▶ 柏宝绘卡片出图
         (本插件)      (逐字搬运的上游代码，只有输入是划线)          (CAS 写回)
```

## 安装

1. 先装并配置好 [柏宝绘](https://github.com/baibai-git/ST-BaiBai-Image)（0.3.6 为锚点版本）。
2. 把本仓库整个目录放进扩展目录，二者按你的安装方式选一个：
   - `SillyTavern/public/scripts/extensions/third-party/ST-BaiImage-CCExtra/`（本机就是这个）
   - `SillyTavern/data/<user>/extensions/third-party/ST-BaiImage-CCExtra/`

   仓库里已带构建产物 `dist/index.js`，**不需要自己编译**。
3. 刷新 SillyTavern。控制台出现 `[CCX] ST-BaiImage-CCExtra 0.1.0 已加载` 即成功。

> 改了源码才需要构建：`npm run setup && npm run build`（Node 18+）。

## 使用

1. 在**AI 剧情楼**的正文里划一段（可以跨行，不能跨楼）。
2. 选区右下角浮出「划线出图」，点它。
3. 等 1～2 秒，正文里多出 `<bbi_image>…</bbi_image>`，柏宝绘的卡片随之出现；点卡片上的「生成图片」。

想调整效果：去柏宝绘里换方案 / 改提示词 / 换副 API，**下一次划线立刻生效**（配置不缓存）。

## 边界（做什么、不做什么）

| 事项 | 本插件 |
|---|---|
| 读柏宝绘设置（方案、提示词、副 API、画幅锁、剔除标签） | ✅ 只读，每次请求现读 |
| 读角色库 / 柏宝书角色状态 / 世界书 / 角色卡 / 人设 | ✅ 与柏宝绘同口径（按整楼取，不因划线缩小） |
| 写 tag 与 `extra.bbiCharChanges` | ✅ 格式与柏宝绘逐字相同 |
| 写柏宝绘的设置 | ❌ 结构上禁止：只读 Proxy，任何写入抛错 |
| 自己的设置面板 / 配置存储 | ❌ 一个 key 都不写 |
| 自动出图 | ❌ 由柏宝绘卡片负责（原因见 `VENDORED.md`） |
| 跨楼划线 | ❌ 明确拒绝，请分次划 |

## 一致性怎么保证（三道闸）

| 闸 | 管什么 | 命令 |
|---|---|---|
| 字节级 | vendored 代码有没有被改 | `BAIBAI_UPSTREAM=<柏宝绘路径> npm run verify:upstream`（40 文件 SHA256 + 3 片段 + 10 常量） |
| 行为级 | 发给 LLM 的 messages 有没有变 | `npm test` 里的 `consistency/golden.test.ts`（4 场景 messages SHA256） |
| 端到端 | 划线这一路有没有接错 | `npm test` 里的 `runner/runSelection.test.ts`（假宿主 + 真上游代码） |

柏宝绘升级后：先跑 ①，红灯说明上游协议变了，先对拍再同步；① 绿而线上不对，问题在划选取词或写回坐标。

## 已知限制

1. **重复划线会被拦一次**：同一段文字连续点两次，第二次提示「已经出过图了」。想重出先在卡片里删掉那几张。
2. **划线与原文必须逐字一致**：如果你划完之后别的插件改了正文，会提示「请重新划线」（指纹不符）。
3. **一行一个 tag**：同一行多次划线会各插一批，卡片按顺序排列。
4. **漫画方案**下划线出的是「这一段的漫画页」，页数仍由模型按内容决定。
5. 出图仍要点卡片——柏宝绘的自动出图标记是它进程内的内存 Map，第三方无法置位（不碰它是刻意的）。

## 同一楼出多张图会怎样（v0.1.1 起）

楼里**已经有 tag 和图片**时再划线，行为是「加一张」，不是「重做一遍」：

- 旧 tag 不进分析：模型看不到它的提示词，**不会替你重 roll 那张图**；
- 旧 tag 的原文一个字不改，旧图仍在原卡片上；
- 新 tag 落在你划线那段之后；如果它插在旧 tag **上面**，插件会把旧图的历史槽位序号一起后移，
  让旧卡继续认领自己的图（否则柏宝绘会按「同序号不同提示词」把它显示成「旧提示词」并让新卡顶走旧图）。

想重出旧图，仍然用柏宝绘卡片自己的「重新生成」。

## 开发

```bash
npm run setup            # 本机 npm 解析 vitest peer 有 bug，必须带 --legacy-peer-deps
npm run typecheck
npm test                 # 27 文件 / 451 tests
npm run build            # → dist/index.js（单文件）
npm run sync:st          # 构建产物同步到 SillyTavern 扩展目录
```

### 两个路径，一个真源

| 路径 | 角色 |
|---|---|
| `G:\插件\ST-BaiImage-CCExtra` | **开发真源**（git 仓库），只在这里改 |
| `G:\SillyTavern\public\scripts\extensions\third-party\ST-BaiImage-CCExtra` | **安装副本**，SillyTavern 实际加载的，不要手改 |

改完一次代码的固定动作：

```bash
npm run typecheck && npm test && npm run build && npm run sync:st
git add -A && git commit -m "..." && git push
```

> 安装副本是 `git clone`，所以「只更新不开发」时直接 `git -C <副本> pull` 也可以；
> `sync:st` 用于「改了源码但还没提交」的快速试车。目标目录不是默认位置时：
> `ST_EXT_DIR="/d/SillyTavern/public/scripts/extensions/third-party" npm run sync:st`。

```
src/
├── autoTag/ st/ backends/ api/ state/   # vendored：逐字复制柏宝绘，禁改逻辑
├── state/settings.ts                    # Adapter：只读 Proxy
├── consistency/                         # 黄金哈希哨兵
├── selection/                           # 自有：划线取词与坐标换算
├── runner/                              # 自有：编排 + 后处理（复刻 runForFloor）
└── ui/                                  # 自有：划线浮出按钮
```

- 逐字复制登记、LOCAL PATCHES、不变量、排错表 → **`VENDORED.md`**
- 全链路工程方案（含字段级契约、故障树、里程碑） → **`docs/ENGINEERING.md`**
- **从需求到落地的全流程复盘 + 变更日志 + 改动守则 → `docs/RETROSPECTIVE.md`**

## 排错

控制台过滤 `[CCX]`：

| 日志 | 含义 |
|---|---|
| `runSelection:enter` | 点了按钮，带上选区字数/行数/匹配方式 |
| `runSelection:start` | 取词成功，`segmentCount` = 送给模型的行数，应为划线行数 |
| `runSelection:skip reason=…` | 被闸门拦下（`stale` / `swipe-changed` / `already-processed` / …） |
| `runSelection:saved` | 写入成功，带 images / changes / rebase 摘要 |
| `runSelection:slotShift` | 新 tag 插在旧 tag 上面，旧图历史槽位后移了几条（`skipped=no-store` 表示这楼还没有图，无需迁移） |
| `writeback:abort reason=…` | 落点失效（`position-lost` / `rebase-failed`），正文未改 |

## 许可与致谢

本插件是 [柏宝绘（ST-BaiBai-Image）](https://github.com/baibai-git/ST-BaiBai-Image) 的伴生工具，核心分析链路的代码版权归原作者柏柏所有，按「拿取并复用」的方式逐字搬运，未作任何逻辑修改。
