# ST-BaiImage-CCExtra

柏宝绘（ST-BaiBai-Image）的伴生插件。目标：复刻柏宝绘的「文本 → tag」LLM 分析链路，做到与上游**协议级逐字一致**，唯一差异是输入从「整楼正文」换成「划线文本」。

工程总方案见工作区：`ST-BaiImage-CCExtra-分析链路协议级复刻-工程方案.md`。

## 当前进度：M1（纯函数逐字搬运）

- ✅ M0 项目骨架 + 上游锚点（`d6c5519`）
- ✅ M1 逐字复制：`clean / protocol / rebase / slotPlan / imageTagRegex / size / mossLayout` + nai 三判定
- ✅ 上游四个测试文件原样搬入
- ✅ `verify:upstream` 漂移检测脚本

## 目录约定

```
src/
├── autoTag/     # 逐字复制（clean/protocol/rebase/slotPlan + tests）
├── st/          # imageTagRegex 逐字；context 为 stub
├── backends/    # size/mossLayout 逐字；nai 为逐字抽取三判定
├── state/       # charTags/settings 为 stub（M1 最小面）
└── (后续 M3+) prompt.ts / api/client.ts / runner.ts / adapter/
```

`@` 别名 → `src/`，与上游同构，保证 vendored 文件 import 路径不改。

## 命令

```bash
npm install --cache ./.npm-cache   # 该机全局 npm 缓存损坏，用独立缓存
npm run typecheck                  # 类型检查
npm test                           # 跑上游四个测试文件
npm run verify:upstream -- --upstream "C:/.../ST-BaiBai-Image"   # 漂移检测
```

## 铁律

1. `src/autoTag/`、`src/st/imageTagRegex.ts`、`src/backends/{size,mossLayout}.ts` **逐字复制，禁改逻辑**。
2. 差异只能发生在 stub / adapter / 新增模块；vendored 改动必须登记到 `VENDORED.md` 的 LOCAL PATCHES。
3. 每次柏宝绘升级先跑 `verify:upstream` + 黄金对拍，确认协议未变再同步。
