# REA 逆向工程：方法与边界

本目录存放用 REA 对 fatetell.com 与 fatemaster.ai 的公开面取证结果。

- `fatetell/` — FateTell 站点（fatetell.com）的取证与报告
- `fatemaster/` — FateMaster.AI 站点（www.fatemaster.ai）的取证与报告
- 对比与玩法总结：本目录下的 `COMPARISON.md` / `PLAYBOOK.md`（取证完成后补全）

## REA 怎么用（本次实际路径）

启动器与运行时（本机无 npm/npx，直连 DSH 自带 node）：

```bash
NODE=/Users/xiaolv/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node
REA=/Users/xiaolv/Documents/deepseek-harness/default-workspace/rea/toolchain/node_modules/rea-agents/scripts/rea.mjs
export REA_BROWSER_EXECUTABLE="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
export REA_LOG_LEVEL=warn

# 1) 一次性有界浏览器场景（启动 Chrome，抓 DOM/网络/截图），完整结果落盘
"$NODE" "$REA" capture-browser-scenario scenario.json --format json > raw/home-capture.json

# 2) 把已保留的脚本站到磁盘，供离线静态分析
"$NODE" "$REA" export-web-scripts raw/home-capture.json raw/scripts

# 3) 静态重建 JS 应用图（不执行代码）
"$NODE" "$REA" analyze-javascript-application "$PWD/raw/scripts" --json > raw/app-graph.json

# 4) 结果很大 → 用过滤/限额，别整体打印
"$NODE" "$REA" capture-browser-scenario scenario.json --filter-output urls,requests --token-limit 4000
```

在 DSH 会话内，同一套能力也可以作为原生工具直接调用（`mcp__rea__<tool>`，共 170 个），
例如 `mcp__rea__analyze_web_bundle`、`mcp__rea__export_web_scripts`、`mcp__rea__inspect_web_page`。

## 用到的 REA 网站分析能力

| 能力 | CLI | MCP 工具 |
|---|---|---|
| 有界浏览器场景（DOM/网络/存储/截图） | `capture-browser-scenario` | `capture_browser_scenario` |
| 被动页面检查 | — | `inspect_web_page` |
| 页面 bundle 静态分析（chunk 图/路由/端点候选/指纹） | `analyze-web-bundle` | `analyze_web_bundle` |
| 脚本站盘 | `export-web-scripts` | `export_web_scripts` |
| 截图 | `capture-web-screenshot` | `capture_web_screenshot` |
| 页面声明的 WebMCP 工具 | `discover-webmcp-tools` | `discover_webmcp_tools` |
| 源位置/导入追踪 | `trace-web-source-location` / `trace-web-module-imports` | 同名 MCP 工具 |
| HAR / 抓包离线检查 | `inspect-web-network-capture` | 同名 |

## 边界（本次遵守）

- **只碰公开、未登录内容**：不登录、不付费、不绕验证码/付费墙、不批量抓取、不复制其素材与文案。
- 结论分三档标注：**Observed（有字节/JSON 证据）**、**Derived（由代码静态推断）**、**Unknown（公开面不可见）**。
- 抓取有界（少量请求），遵守 robots.txt 与常规限速；若站点阻止自动化访问，记录为限制而不是绕过。

## 你要提供登录态时，这样做（推荐，不交凭据）

不要把你的密码或 cookie 发给我。改为：

```bash
# 用你自己的日常 Chrome 配置启动一个可远程调试的实例，然后你自己在那个窗口里登录
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9333 \
  --user-data-dir="$HOME/.rea-login-profile"
# 在弹出的窗口里手动登录 fatetell.com / fatemaster.ai
```

登录完成后告诉我，我用 REA 以只读方式附着到 `http://127.0.0.1:9333`：

- `list_browser_targets` → 找到目标页的 `target_id`
- `observe_web_session` / `inspect_web_page` → 只观察你手动操作时的导航、请求与页面结构
- 可选：`observe_web_execution` → 精确 JS 覆盖率窗口（不执行你自己的代码、不改页面）

我全程不读取、不导出你的登录凭据；只读取页面结构与网络元数据。
