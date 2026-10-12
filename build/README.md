# build/ — 你自己的命理 AI 助手（落地资料）

按这个顺序读：

| 顺序 | 文件 | 作用 |
|---|---|---|
| 1 | [PLAN.md](PLAN.md) | **执行流程**：可复用边界、默认决策、P0–P4 阶段与验收、架构蓝图与六条不变量、数据模型、成本模型、排期、风险 |
| 2 | [PROTOCOL.md](PROTOCOL.md) | **可实现契约**：NDJSON 帧、SSE + `seq` 续传、工具注册与校验、幂等计费、额度错误码、渲染映射 |
| 3 | [CONTENT.md](CONTENT.md) | **内容方案**：原语清单、页型模板、生成管线与硬门禁、SEO/GEO 动作、版本与重生成策略 |
| 4 | [skeleton/](skeleton/) | **可运行的参考骨架**：零依赖、`node --test` **62/0**，覆盖协议/续传/工具校验/额度四条链路 |
| 5 | [verify/](verify/) | **独立验收**：`acceptance.mjs`（26/26 PASS，不复用骨架解析器）、[VERIFICATION.md](verify/VERIFICATION.md)（验证记录与缺陷清单）、[curl-transcript.txt](verify/curl-transcript.txt)（5 个端点实录） |

## 接入真实模型（只差你的 key）

模型接缝已**接进服务端**。不配置 key 时跑确定性 fixture（离线可跑通全链路）；配置后同一条代码路径改由真实模型驱动：

```bash
NODE=/Users/xiaolv/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node

SHENSHA_LLM_KEY=sk-... \
SHENSHA_LLM_BASE_URL=https://api.deepseek.com/v1 \
SHENSHA_LLM_MODEL=deepseek-chat \
SHENSHA_STORE=sqlite SHENSHA_DB=./data/streams.db \
PORT=8787 "$NODE" build/skeleton/src/server.mjs
```

| 环境变量 | 作用 | 默认 |
|---|---|---|
| `SHENSHA_LLM_KEY` | 设置即启用真实模型；**不设置就跑 fixture** | 无 |
| `SHENSHA_LLM_BASE_URL` | OpenAI 兼容端点 | `https://api.deepseek.com/v1` |
| `SHENSHA_LLM_MODEL` | 模型名 | `deepseek-chat` |
| `SHENSHA_STORE` | `sqlite` 启用持久化（跨重启续传） | 内存 |
| `SHENSHA_DB` | SQLite 文件路径 | `:memory:` |
| `SHENSHA_KERNEL` | `stub` 退回占位内核 | 真实内核 |
| `SHENSHA_SESSION_SECRET` | 会话签名密钥（≥16 字节）；不设则每进程随机生成、重启失效 | 随机（临时） |
| `SHENSHA_ALLOW_DEV_SESSION=1` | 开放 `POST /api/session {sub}` 用于开发签发；**默认关闭**（关闭时返回 404） | 关闭 |

key 只在 `providerFromEnv()` 读取，且已从供应商错误消息中打码（第 10 类缺陷）；模型模式下**工具调用仍受注册表闸门约束**，参数非法时 handler 不执行、拒绝结果作为类型化 action 回喂给模型（有测试）。

## 当前状态（2026-10-12 收口）

| 验证 | 结果 |
|---|---|
| 历法内核自带测试 | **43 / 0** |
| 骨架自带测试（真实内核 / SQLite / 占位内核） | **94 / 0** ×3 |
| 独立验收（不复用骨架解析器） | **31 / 31 PASS** |
| 外部锚点交叉验证 | **20 / 20 PASS**（含精度目标） |
| 外部锚点 | 1949-10-01=甲子、2000-01-01=己卯/丙子/戊午、五鼠遁时干、日柱逐日+1、两种换日口径、立春两侧各 1 分钟 —— 全绿 |
| 交节精度 | **实测最大 9.6 秒**（50 点公开节气表），目标 ≤2 分钟 |
| 安全门禁 | 误差窗口不低报；窗口内标记；远离边界不标记 —— 全绿 |

**已交付**：分阶段流程（PLAN）、协议与架构规范（PROTOCOL）、内容方案（CONTENT）、可运行骨架（skeleton）、真实历法内核（kernel）、持久化存储、模型接缝、三层验证资产（verify）。

**明确遗留**（都不阻塞使用，且都有文档与门禁）：
1. ~~交节精度 ±8.8 分钟~~ → **已收口：v3 VSOP87D，实测最大 9.6 秒**；
2. ~~会话校验是"接受任意非空 Bearer"的占位~~ → **已收口：签名会话（HMAC-SHA256）**；
3. 真实模型需要你的 `SHENSHA_LLM_KEY` 才会启用（不设则跑确定性 fixture）。

## 立刻可做的三件事

```bash
NODE=/Users/xiaolv/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node

# 1) 跑骨架自带测试（69/0）
cd build/skeleton && "$NODE" --test 'test/*.test.mjs'

# 2) 跑独立验收（31/31：协议、续传、幂等、额度优先级、鉴权边界、结构化出生数据）
cd /Users/xiaolv/Documents/deepseek-harness/default-workspace && "$NODE" build/verify/acceptance.mjs

# 3) 跑历法内核的独立交叉验证（外部锚点：1949-10-01=甲子、2000-01-01=戊午）
"$NODE" build/verify/kernel-crosscheck.mjs
```

## 当前状态（2026-10-12）

- 骨架自带测试 **69 passed / 0 failed**；独立验收 **31/31 PASS**。
- 已修 9 类缺陷，记录在 [verify/VERIFICATION.md](verify/VERIFICATION.md)（含"快照与请求互相矛盾""同一条件两个答案""`request_id` 不幂等""免费用户试用用尽被回成明日再来""内核接受不存在的时区"等）。
- 结构化出生数据契约（PROTOCOL §4bis）已实现：`birth` 为权威来源，非法输入一律类型化 400 **且不扣额度**，`x-chart-source` 头区分"权威命盘/演示占位"。
- 模型接缝已就绪（`skeleton/src/llm.mjs`）：注入式 `chatStream`，测试全用假流；工具闸门、NDJSON/SSE 双格式、abort、`maxToolRounds`、以及 provider 错误里的 **key 打码** 都有测试。
- **真实历法内核已接入并成为默认**（`build/kernel/`：锚定干支日、立春分界年柱、节分界月柱、五虎遁/五鼠遁、IANA 时区与 DST、两种换日口径）。`SHENSHA_KERNEL=stub` 可退回占位内核。
- 骨架测试在**三种配置下全部 108/0**：真实内核（默认）、`SHENSHA_STORE=sqlite`（持久化存储）、`SHENSHA_KERNEL=stub`（占位内核）。独立验收 **31/31 PASS**。
- **会话校验不再是占位**（`src/session.mjs`）：Bearer 必须是 **HMAC-SHA256 签名令牌**（`v1.<payload>.<sig>`），
  无 `alg` 协商、`timingSafeEqual` 常量时间比较、无 `exp` 即拒；伪造/跨密钥/过期分别返回可区分的
  `SESSION_BAD_SIGNATURE` / `SESSION_EXPIRED` 等码。**不能验证的令牌不再变成身份**——此前的占位实现接受任意非空字符串，
  使续传归属、`request_id` 幂等、额度账本三处校验同时失效。匿名免费钩子保留（有测试守着）。
- **模型接缝已接进服务端**（`llm.mjs` + `providerFromEnv()`）：不配 key 跑确定性 fixture，配 `SHENSHA_LLM_KEY` 即由真实模型驱动同一条代码路径；工具闸门、reasoning/content 分流、key 打码都有测试。
- **持久化不再是占位**：`src/store-sqlite.mjs` 用 Node 24 内置 `node:sqlite` 实现，与内存版**同接口可替换**，并把两个此前只能"写在文档里"的要求变成数据库约束：帧表 `PRIMARY KEY (message_id, seq)`（并发下 seq 单调）、`(channel, request_id) WHERE request_id <> ''` 偏索引（跨重启的幂等键）。测试含**杀进程重启后仍能续传**的端到端用例。
- **交节精度已达标（v3）**：换成**完整 VSOP87D 地球级数**（1080 + 997 项，从公开表**机械提取**、无人工转录）后，
  50 点公开发布节气集合上**最大偏差 9.6 秒**（平均 4.7 秒），相对 v2 的 8.8 分钟改善约 55 倍；
  此前因精度不足而失败的两条严格边界用例（2024 立春两侧各 1 分钟）已转绿（`16:25 → 癸卯`、`16:28 → 甲辰`）。
  诚实性机制保留未拆：`termAccuracySeconds` 收窄到 60 s，窗口内命例仍会被标记。详见 [verify/kernel-accuracy.md](verify/kernel-accuracy.md)。
- 骨架刻意留白的部分：真实历法内核、真实模型调用、持久化、鉴权校验、退款策略——同上文档末尾列出。

## 与逆向结论的对应关系

| 我们的设计 | 来自哪条实测 |
|---|---|
| 确定性内核 + 受限叙述层 | 两家都写明"AI 不参与排盘/只负责解释" |
| NDJSON（Agent）/ SSE + `seq` 续传（长回答） | 分别实测自两家；续传是 FateTell 的 `from_seq` 机制 |
| 工具按 surface 分域注册 | 一家的工具集按界面分组，且 Agent 明确排除某类术数 |
| 服务端权威额度 + 错误码契约 | 实测到完整错误码枚举与 `agentTrial` 结构 |
| 章节化长文 + 异步邮件 + 回放 | 实测到 10 章结构、仪式化进度、邮件送达与 replay |
| 记忆可管理且不影响确定性计算 | 实测到记忆管理 UI 与"记忆不改变排盘公式"的文案 |
| 长尾内容按领域原语一页 + 放开 AI 爬虫 | 实测到 4115 页程序化内容与 robots.txt 的 GEO 注释 |

> 借鉴的是**结构与协议**。文案、视觉素材、品牌与实现代码一律自己写。
