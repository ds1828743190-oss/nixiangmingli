# REA → DSH 安装验证记录

日期：2026-10-12 ｜ 方案 A（REA 6.4.0 + DSH 原生 MCP bundle）

## 安装了什么

| 项 | 路径 / 值 |
|---|---|
| REA 包 | `rea-agents@6.4.0`（npm 最新发布版，本日核实） |
| 启动器（绝对路径） | `rea/toolchain/node_modules/rea-agents/scripts/rea.mjs` |
| 运行时 | DSH 自带 Node `v24.21.0`（满足 REA engines `^24.11.0`） |
| 包管理器 | DSH 自带 pnpm `11.7.0`（本机无 npm/npx，故用 pnpm 安装 + 直连 node 启动器） |
| DSH 侧注册 | 工作区 bundle `rea-mcp-bundle/`（`@local/rea-mcp`，`plugin_manager install_bundle`） |
| 工具命名 | `mcp__rea__<tool>` |

## 验证结果（6 项）

| # | 检查 | 结果 | 证据 |
|---|---|---|---|
| 1 | CLI 可运行 | ✅ `rea --version` → `6.4.0`；`doctor --json` node/host 均 healthy | `logs/rea-help.txt`；doctor 输出（node 24.21.0 / host 26.7.1） |
| 2 | MCP 服务器独立可用 | ✅ 自写 stdio 探针：protocol `2025-06-18`，`serverInfo.name=rea`，`version=6.4.0`，**170 个工具**，含网站分析工具族 | `mcp-probe.mjs` |
| 3 | bundle 安装生效 | ✅ `install_bundle` → `application: "applied"`，`warnings: []`，packageResult exitCode 0 | plugin_manager 返回 |
| 4 | 注册行出现在实时配置中 | ✅ `Config.listConfigs{name:"@deepseek-ai/dsh-mcp-client"}` → 1 条：`id=include:rea-mcp`、`patchId=rea-mcp`、`status=schema` | cordis_inspect_query |
| 5 | 工具对本 Agent 可见/可调 | ✅ 本会话工具表已注入 `mcp__rea__*`（170 个）+ `mcp__rea` 资源服务器 | 会话工具模式 |
| 6 | 真实工具调用成功 | ✅ `mcp__rea__binary_session{expected_package_version:"6.4.0"}` → `alignment.state="aligned"`（即实际运行中的服务端身份校验通过）、`protocol_features` progress/cancellation 均 true | 调用结果 |

## 关键配置（已生效）

```yaml
- insert:
    - id: rea-mcp
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: rea
        transport: stdio
        command: <DSH 自带 node 绝对路径>
        args: [<workspace>/rea/toolchain/node_modules/rea-agents/scripts/rea.mjs, mcp]
        failOnStartupError: false
        toolCallTimeoutMs: 300000
        env:
          REA_MCP_INPUT_SCHEMA_PROFILE: compact   # 170 个工具的 schema 压缩
          REA_BROWSER_EXECUTABLE: /Applications/Google Chrome.app/Contents/MacOS/Google Chrome
          REA_LOG_LEVEL: warn
```

## 环境限制（如实记录）

- 本机无 Hopper / Ghidra / IDA → REA 的**原生二进制反编译**不可用。本次两个目标都是网站，不需要。
- 本机无 npm/npx → 未逐字执行 `npx rea-agents@latest setup`；用的是等价 runner（DSH 自带 pnpm + 直连启动器）。
- npm 6.4.0 **不含** DeepSeek Harness 的 `--client dsh` 分支（该分支仅在 REA main），故 dsh 注册按 DSH 官方
  `mcp-bundle` 模板完成，patch 内容与 REA 文档中 `setup --client dsh` 写入的条目一致。
- 浏览器能力：`REA_BROWSER_EXECUTABLE` 指向已安装的 Google Chrome。

## 性能提醒（重要）

REA 的宽口径工具返回**非常大**（`binary_session` 单次约 177 KB）。后续只调用窄口径工具，
并优先把结果落盘（`export-web-scripts`、`--json > file`）后再离线 grep/read。
