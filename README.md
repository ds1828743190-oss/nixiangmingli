# 命理 AI 助手 —— 逆向结论 + 可运行实现

本仓库有两部分：

1. **逆向取证**（`reverse/`）：对 FateTell（fatetell.com）与 FateMaster.AI（fatemaster.ai）公开面的
   evidence-backed 拆解，以及跨站对比与可复用玩法。
2. **自己的实现**（`build/`）：先有流程与协议，再有零依赖可运行骨架、真实历法内核、
   持久化存储、模型接缝，以及三层验证资产（其中独立验收**不复用被测代码的解析器**）。

一句话结论（逆向部分）：两家产品路线完全不同，但在 **AI 架构层几乎逐条一致**——
确定性排盘内核 + 受限叙述层、按界面分域的工具、把 reasoning/tool/phase 放进流协议、
服务端权威额度、章节化长文交付。本仓库的实现就是按这套结构做的。

---

## 环境要求

| 项 | 要求 | 说明 |
|---|---|---|
| Node.js | **24+**（推荐） | 全仓库**零 npm 依赖**，只用标准库。`node:sqlite` 需要 24（或 22.5+ 加 `--experimental-sqlite`） |
| 操作系统 | macOS / Linux / Windows | 代码中**没有绝对路径**（只有文档里出现过本机路径，不影响运行） |
| 网络 / API key | **不需要** | 不配 `SHENSHA_LLM_KEY` 时跑确定性 fixture，全链路离线可跑通 |

## 快速开始（三个命令）

```bash
# 1) 全部测试：历法内核 + 骨架（真实内核 / SQLite / 占位内核 三种配置）
node --test 'build/kernel/test/*.test.mjs' 'build/skeleton/test/*.test.mjs'

# 2) 独立验收：把服务端当独立进程启动，用真实签名令牌跑 31 项契约检查
node build/verify/acceptance.mjs

# 3) 外部锚点交叉验证：1949-10-01=甲子、2000-01-01=己卯/丙子/戊午、节气精度门禁
node build/verify/kernel-crosscheck.mjs
```

若本机已有 `npm`，也可以用 `package.json` 里的脚本：

```bash
npm test           # 同上 1)
npm run acceptance # 同上 2)
npm run crosscheck # 同上 3)
npm start          # 起服务（默认 8787）
```

## 跑起来

```bash
# 只跑确定性路径（不需要任何密钥）
PORT=8787 node build/skeleton/src/server.mjs

# 接入真实模型（OpenAI 兼容端点）
SHENSHA_LLM_KEY=sk-... \
SHENSHA_LLM_BASE_URL=https://api.deepseek.com/v1 \
SHENSHA_LLM_MODEL=deepseek-chat \
SHENSHA_SESSION_SECRET=$(head -c 32 /dev/urandom | base64) \
SHENSHA_STORE=sqlite SHENSHA_DB=./data/streams.db \
PORT=8787 node build/skeleton/src/server.mjs
```

| 环境变量 | 作用 | 默认 |
|---|---|---|
| `SHENSHA_LLM_KEY` | 设置即启用真实模型；不设置跑确定性 fixture | 无 |
| `SHENSHA_LLM_BASE_URL` / `SHENSHA_LLM_MODEL` | 端点与模型名 | DeepSeek / `deepseek-chat` |
| `SHENSHA_SESSION_SECRET` | 会话签名密钥（≥16 字节）。**生产必须显式设置**，否则每进程随机、重启即失效 | 随机（临时） |
| `SHENSHA_ALLOW_DEV_SESSION=1` | 开放 `POST /api/session` 开发签发；默认关闭（返回 404） | 关闭 |
| `SHENSHA_STORE=sqlite` / `SHENSHA_DB` | 持久化存储与文件路径 | 内存 |
| `SHENSHA_KERNEL=stub` | 退回占位内核（仅供对照） | 真实内核 |

## 目录

| 路径 | 内容 |
|---|---|
| [`build/README.md`](build/README.md) | **入口文档**：当前状态、环境变量、验证数字 |
| [`build/PLAN.md`](build/PLAN.md) | 分阶段流程（P0–P4）、六条不变量、成本模型、精度决策 |
| [`build/PROTOCOL.md`](build/PROTOCOL.md) | 可实现契约：NDJSON/SSE 帧、`seq` 续传、幂等计费、额度优先级、结构化出生数据、会话鉴权 |
| [`build/CONTENT.md`](build/CONTENT.md) | 内容方案：原语清单、页型模板、生成管线硬门禁、SEO/GEO |
| [`build/skeleton/`](build/skeleton) | 零依赖骨架：帧/流/工具/额度/持久化/模型接缝/服务端 |
| [`build/kernel/`](build/kernel) | 真实历法内核：VSOP87D 节气、锚定干支日、立春/节分界、五虎遁/五鼠遁、IANA 时区 |
| [`build/verify/`](build/verify) | 验证资产：独立验收、交叉验证、精度审计、验证记录 |
| [`reverse/COMPARISON.md`](reverse/COMPARISON.md) | FateTell vs FateMaster 逐维对比 |
| [`reverse/PLAYBOOK.md`](reverse/PLAYBOOK.md) | 12 条可复用模式 + REA 实战方法论与踩坑 |
| [`reverse/fatetell/REPORT.md`](reverse/fatetell/REPORT.md) · [`reverse/fatemaster/REPORT.md`](reverse/fatemaster/REPORT.md) · [`reverse/logged-in/REPORT.md`](reverse/logged-in/REPORT.md) | 三份取证报告（公开面 / 公开面 / 登录态） |

## 当前验证状态

| 验证 | 结果 |
|---|---|
| 历法内核测试 | 43 / 0 |
| 骨架测试（真实内核 / SQLite / 占位内核） | 108 / 0 ×3 |
| 独立验收 | 31 / 31 PASS |
| 外部锚点交叉验证 | 20 / 20 PASS |
| 交节精度 | 实测最大 **9.6 秒**（50 点公开发布节气表） |

## 没有放进仓库的东西（以及为什么）

**`reverse/**/raw/` 未纳入版本控制**：那是从两家站点抓取的**第三方资源**（JS bundle、DOM、截图、网络响应），
属于对方的内容，**不适合再分发**。它们仍在本机，另有完整归档（见 [`NOTICE.md`](NOTICE.md) 与
[`MANIFEST-evidence.md`](MANIFEST-evidence.md)），后者含体积与关键文件摘要，便于追溯而不必随仓库传播。

**`rea/`**（REA 工具链安装目录，216MB）也未纳入：它是 `rea-agents@6.4.0` 的第三方 npm 安装，
可用 `pnpm add rea-agents@6.4.0` 复现，不必进仓库。

## 继续工作

- 想接着做功能：先读 [`build/README.md`](build/README.md) → [`build/PLAN.md`](build/PLAN.md) §2 的阶段与验收。
- 想改协议：先读 [`build/PROTOCOL.md`](build/PROTOCOL.md)，**改协议要升版本号**，并同步 `build/verify/acceptance.mjs`。
- 想扩精度/金标准：见 [`build/verify/kernel-accuracy.md`](build/verify/kernel-accuracy.md) 与 `PLAN` §8 第 3 条。
