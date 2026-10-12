# REA → DSH 接入方案（待批准）

目标：安装 REA（`rea-agents`），接入本 coding agent（DeepSeek Harness / 本 profile），
验证安装，然后用 REA 逆向 fatetell.com 与 fatemaster.ai。

---

## 0. 勘察结论（已核实，非推测）

| 事实 | 证据 |
|---|---|
| 本机没有系统 `node` / `npm` / `npx` / `bun` | `which npx` 失败；`/usr/local/bin`、Homebrew、nvm、volta、bun 目录均无 |
| DSH 自带 Node **v24.21.0** 与 pnpm **11.7.0** | `~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/`；满足 REA engines `^22.19.0 \|\| ^24.11.0 \|\| >=26.0.0` |
| npm 上 REA 最新发布 = **6.4.0** | `https://registry.npmjs.org/rea-agents/latest` |
| REA 6.4.0 **不含** DeepSeek Harness 支持 | 解包 tarball 后 `grep -ri deepseek dist` 与 `"dsh"` 均无命中；REA 官方 installation.md 明确写：*“DeepSeek Harness (`dsh`) is on main and is not in npm 6.4.0; `rea setup --client dsh` against `@latest` reports an unsupported client”* |
| DSH 官方自带 MCP 客户端插件 | `app.asar` 内 `/dsh/node_modules/@deepseek-ai/dsh-mcp-client`（配置 schema 见其 README：`serverName`/`transport`/`command`/`args`/`env`/`failOnStartupError`/`toolCallTimeoutMs`/`reconnect.*`） |
| DSH 官方接入 MCP 的方式是**工作区 bundle + `plugin_manager install_bundle`** | DSH 技能 `cordis-plugin-development/references/mcp-bundle.md`：*“A configuration-only bundle's manifest needs a unique name, version, and `dsh.bundle.patch`”*；并明确*“Do not write the profile's `package.json` or `cordis.patch.yml` … each hand-made write outside the workspace needs its own approval”* |
| 本机有 Google Chrome | `/Applications/Google Chrome.app` → REA 网站分析（页面结构 / 脚本 / 网络 / 截图）可用 |
| 本机无 Hopper / Ghidra / IDA | 原生二进制反编译不可用（本次两个目标都是网站，不需要） |

### 因此对原命令的 3 处必要偏离

1. **`npx` 不存在** → 用自带 pnpm 的 `pnpm dlx`（npx 的等价 runner），或本地安装后
   `node <…>/rea-agents/scripts/rea.mjs …`。两者抓取的都是同一个 npm 包。
2. **`@latest`（6.4.0）不支持 `--client dsh`** → dsh 注册由 DSH 原生 bundle 机制完成，
   patch 内容与 REA main 的 `setup --client dsh` 文档所写条目一致（`@deepseek-ai/dsh-mcp-client` + `serverName: rea` + stdio）。
   若必须由 REA 自己执行 `setup --client dsh`，只能走方案 B（从 GitHub main 构建）。
3. **不手改 `~/.dsh/cordis.patch.yml`** → 改用工作区 bundle + `plugin_manager`，这是 DSH 官方路径，且可被
   `cordis_inspect_query` 复核。

---

## 1. 安装 REA（工作区内，不需要额外授权）

```bash
WS=/Users/xiaolv/Documents/deepseek-harness/default-workspace
NODE=$WS/…/node            # 实际使用 DSH 自带 node 绝对路径
PNPM=$WS/…/pnpm.mjs        # 实际使用 DSH 自带 pnpm 绝对路径

mkdir -p "$WS/rea/toolchain" && cd "$WS/rea/toolchain"
# store / cache / userconfig 全部指向工作区，避免任何写 $HOME
$NODE $PNPM add rea-agents@6.4.0 \
  --store-dir "$WS/rea/.pnpm-store" \
  --config.userconfig="$WS/rea/.npmrc"
```

产出稳定启动器（绝对路径，供 MCP stdio 使用）：

```
$WS/rea/toolchain/node_modules/rea-agents/scripts/rea.mjs
```

验证（只读为主）：`rea --version`、`rea doctor --json`（记录 node / browser / provider 检查结果）。

## 2. 生成并提交“安装计划”给你审阅

- REA 自身的计划（只读）：`rea setup --skill --dry-run --json`
- 等价 dsh 注册计划：下面的 bundle 两个文件（**这一步只是写出计划，不安装**）

## 3. 接入 DSH（需要你批准；会写本 profile）

目录 `$WS/rea-mcp-bundle/`：

`package.json`
```json
{
  "name": "@local/rea-mcp",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

`cordis.patch.yml`
```yaml
- insert:
    - id: rea-mcp
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: rea
        transport: stdio
        command: <DSH 自带 node 绝对路径>
        args:
          - <WS>/rea/toolchain/node_modules/rea-agents/scripts/rea.mjs
          - mcp
        failOnStartupError: false
        toolCallTimeoutMs: 300000
        env:
          REA_MCP_INPUT_SCHEMA_PROFILE: compact
          REA_BROWSER_EXECUTABLE: /Applications/Google Chrome.app/Contents/MacOS/Google Chrome
```

然后 `plugin_manager { action: install_bundle, target: "$WS/rea-mcp-bundle" }`
（该工具每次调用都需要批准）。`compact` 是为了压缩 REA 的工具 schema 体积——工具定义会进入每一次请求。

## 4. 验证安装（缺一不可）

1. `rea --version`、`rea doctor --json`；
2. 直接对 stdio 服务器做 MCP 握手并 `tools/list` 计数（脱离 DSH 的独立证据）；
3. `plugin_manager install_bundle` 返回 `application: applied`；
4. `cordis_inspect_query` `Config.listConfigs` 能看到 `rea-mcp` 行的解析后 schema；
5. `cordis_inspect_query` `Tool.listTools` 出现 `mcp__rea__*`；
6. 真实调用一个只读 REA 工具并拿到结果；
7. 若第 5 步工具未出现，重启 DSH 后复验（MCP 工具在启动时注册）。

## 5. 之后：用 REA 逆向 fatetell.com 与 fatemaster.ai

产物：`$WS/reverse/fatetell/…`、`$WS/reverse/fatemaster/…`，外加一份对比与可复用结论报告。

**边界（建议，请一并确认）**：只分析公开可访问的页面、公开 JS bundle、公开网络请求；
不登录、不绕过付费墙/验证码、不做批量抓取、不复制其私有素材与文案；遵守 robots.txt 与限速；
每条结论附证据与局限（REA 的 Evidence 契约要求如此）。

---

## 需要你批准的项

| # | 事项 | 是否必需 |
|---|---|---|
| 1 | `plugin_manager install_bundle`（DSH 规定必须批准） | 必需 |
| 2 | 方案 A：REA 6.4.0 + DSH 原生 bundle（快、稳定） | 二选一 |
| 3 | 方案 B：从 GitHub main 构建 REA（可真正跑 `setup --client dsh`，耗时明显更长） | 二选一 |
| 4 | 可选：把 REA 工作流 skill 装到 `~/.agents/skills`（工作区外，需一次性放宽授权）；不装则用 DSH 自带技能 | 可选 |
| 5 | 可选：REA CLI 写 `~/.rea` 缓存时的一次性放宽授权 | 可选 |
