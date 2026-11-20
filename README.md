# ST-BaiImage-CCExtra

柏宝绘（ST-BaiBai-Image）的伴生插件。目标：复刻柏宝绘的「文本 → tag」LLM 分析链路，做到与上游**协议级逐字一致**，唯一差异是输入从「整楼正文」换成「划线文本」。

工程总方案见工作区：`ST-BaiImage-CCExtra-分析链路协议级复刻-工程方案.md`。
逐字复制登记、不变量与排错索引见本仓库 `VENDORED.md`。

## 进度

- ✅ **M0** 项目骨架 + 上游锚点（`d6c5519` / v0.3.6）
- ✅ **M1** 纯函数逐字搬运：`clean / protocol / rebase / slotPlan / imageTagRegex / size / mossLayout` + nai 三判定
- ✅ **M2** Adapter：只读设置（递归 Proxy + 测试草稿层）、共享副 API 渠道、`charTags` 运行时、上下文/角色锚点/柏宝书记忆
- ✅ **M3** 提示词层：`prompt.ts` 逐字搬入 + 10 份内置提示词脚本抽取 + 黄金哈希哨兵（`consistency/`）
- ✅ **M4** 划线取词：`selection/`（定位核心 / 捕获 / 切片⇄整楼行号换算 / 写回重定位）
- ⬜ **M5** 分析执行：`runner.ts` 接入（把 `source` 换成划线文本）
- ⬜ **M6** 出图：调公开 `generate()` + 切方案
- ⬜ **M7** UI：划线触发、预览、进度与失败提示

## 目录约定

```
src/
├── autoTag/      # vendored：clean/protocol/rebase/slotPlan/prompt/context/charAnchors/...
├── st/           # vendored：context/imageTagRegex
├── backends/     # vendored：size/mossLayout/comfyTemplates/comfyui；nai 为逐字抽取的判定
├── api/          # vendored：client（副 API 调用）
├── state/        # vendored：charTags/globalCharTags/history；settings 为只读 Adapter
├── generationMeta.ts  # vendored
├── shims/vue.ts  # reactive 等价 shim（让上游文件一字不改可搬）
├── consistency/  # 黄金哈希哨兵 + 基准快照
└── selection/    # 自有代码：划线取词与坐标换算（唯一允许写业务逻辑的地方）
```

`@` 别名 → `src/`，与上游同构，保证 vendored 文件 import 路径不改。

## 命令

```bash
npm install --cache ./.npm-cache --legacy-peer-deps  # 本机 npm 解析 vitest peer 有 bug，必须带 legacy
npm run typecheck
npm test
BAIBAI_UPSTREAM="C:/.../ST-BaiBai-Image" npm run verify:upstream
```

## 铁律

1. vendored 文件（`autoTag/`、`st/`、`backends/`、`api/`、`state/` 除 `settings.ts`）**逐字复制，禁改逻辑**。
2. 差异只能发生在 Adapter / shim / 生成物 / 新增模块；vendored 改动必须登记到 `VENDORED.md` 的 LOCAL PATCHES。
3. 每次柏宝绘升级先跑 `verify:upstream` + 黄金对拍，确认协议未变再同步。
4. 只读柏宝绘配置：`state/settings.ts` 在非测试环境写入即抛错。
