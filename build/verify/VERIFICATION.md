# 参考骨架验证记录

日期：2026-10-12 ｜ 对象：`build/skeleton`（REA 逆向结论 → 可运行骨架）

## 结论

| 验证 | 命令 | 结果 |
|---|---|---|
| 骨架自带测试 | `cd build/skeleton && "$NODE" --test` | **108 passed / 0 failed**（真实内核；`SHENSHA_STORE=sqlite` 与 `SHENSHA_KERNEL=stub` 亦为 108/0） |
| **独立验收**（本项目自己写的、不复用骨架解析器的端到端验收） | `cd . && "$NODE" build/verify/acceptance.mjs` | **31/31 — ACCEPTANCE: PASS** |
| 5 个端点手工实录 | 见 [curl-transcript.txt](curl-transcript.txt) | 全部符合 [PROTOCOL.md](../PROTOCOL.md) |

`NODE=/Users/xiaolv/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node`

> 注意：`node --test test/` 在 Node 24 会 `MODULE_NOT_FOUND`；用 `node --test`（自动发现）或直接给文件路径。

## 独立验收覆盖的 31 项

- **一致性（不变量）**：匿名快照不得谎报可用 Agent 试用；匿名拒绝必须与 SSE 通道同状态码（401）。
- **确定性内核**：`/api/bazi-calculate` 返回四柱 Facts + 交给模型的 `narrationPrompt`；坏日期是类型化 4xx。
- **通道 A（NDJSON）**：`text/plain`；首帧 `conversation_id`；`reasoning → phase_change → content`；无 `error` 帧。
- **通道 B（SSE）**：`text/event-stream`；**首帧之前**就有 `x-message-id`。
- **续传不变量**：中途断开后 `?from_seq=N` 只回 `seq > N`、从 `N+1` 起、严格递增、两段互不相交、以终止帧 + `[DONE]` 收尾。
- **幂等计费**：同一 `request_id` 重放 → 同一个 `x-message-id`，额度不再扣减。
- **额度契约**：耗尽返回类型化 code + 状态；快照同步 `hasRemaining:false`；**免费主体试用用尽必须是 `AGENT_TRIAL_EXHAUSTED` 而不是 `DAILY_LIMIT_REACHED`**（否则等于承诺一个不会回来的额度）。
- **鉴权边界**：无凭据 = 401（去登录），不是 403（额度）。

## 本轮修掉的缺陷（都有实测证据）

| # | 缺陷 | 证据 | 修法 |
|---|---|---|---|
| 1 | **快照与请求互相矛盾**：`/api/access` 说 `agentTrial{limit:2,remaining:2,hasRemaining:true}`，而 `POST /api/agent/chat` 同时被拒 | 判为 3 个失败项 | 匿名快照改为 `{accessType:null, signInRequired:true, agentTrial:{limit:0,…}}`；HTTP 层先判登录 |
| 2 | **同一条件两个答案**：NDJSON 通道对"无凭据"回 403，SSE 通道回 401 | 实测两条通道 | 两条通道统一 `401 UNAUTHENTICATED` |
| 3 | **`request_id` 不幂等**：重放新建消息（`msg_…_1` → `msg_…_2`） | 实测两次 POST | hub 增 `findByRequestId` + 记录 `principalId`；server 在额度检查**之前**重放同一消息 |
| 4 | **续传/重放未校验归属**：`messageId` 可被其它账号猜中读取 | 代码审查 | 续传与重放校验同一 principal，不匹配按 404 |
| 5 | **演示工具调用与事实不一致**：工具参数日期被硬编码为 `2000-01-01`，而同一次回答讲的是另一个日期 | curl 实录 | 默认工具计划在计划期绑定 facts 的 `date`/`timezone`（保持确定性） |
| 6 | 骨架自带 5 个测试缺陷 | 见 [pending-fixes.md](pending-fixes.md) | 已修：`assert.notMatch`→`doesNotMatch`、SSE 路由误用 JSON 解析、`=== 4` 过脆、空 hub 上使用他 hub 的 messageId、匿名 403→401 的期望值 |
| 7 | **`AGENT_TRIAL_EXHAUSTED` 不可达**：免费用户试用用尽后落到 `DAILY_LIMIT_REACHED`，等于告诉他"明天再来"，而那份额度永远不会回来 | 骨架作者自查发现 | 判定顺序固定为 `401 → ANON_LIMIT_REACHED → 试用 → AGENT_TRIAL_EXHAUSTED → 日额度 → DAILY_LIMIT_REACHED`；`accessSnapshot` 改为读真实权益而非写死 `hasSubscription:false`。已加入验收项 27 防止回归 |
| 8 | **内核接受不存在的 IANA 时区**：`timezone:"Not/AZone"` 被静默接受并排出命盘 | 我的结构化出生数据探针 | 内核用 `Intl` 校验时区，拒绝时抛 `INVALID_TIMEZONE`。时区决定节气与换日判定，错的时区=错的命盘且用户无法察觉 |
| 9 | **我实现 §4bis 时自己引入的三处漏洞**（探针逐条抓出）：结构校验排在扣费之后（错误输入也扣一次额度）；**非法**出生日期静默降级成占位命盘并返回 200；SSE 路由只校验字段是否齐全、不校验取值是否合法 | 我的 7 例出生数据探针 | 两路由统一为 `登录 → 额度 check → 结构校验 → 内核干跑 → 扣费 → 生成`；结构化出生数据下内核报错一律 400，不再回落占位；新增 `x-chart-source: birth\|placeholder` 响应头让"权威命盘 vs 演示占位"可被机器判定 |
| 10 | **API key 会被回显**：供应商错误体若把凭据夹带回来（`bad key sk-...`），原来的实现会把原文放进错误消息，进而可能进日志或流帧 | 我为 `createChatStream` 写的"不得泄露 key"测试（先写测试，随后它真的失败了） | 错误消息构造前先做 `detail.split(apiKey).join('[redacted]')`。教训：这类测试必须**先于**实现写好，否则永远不会发现 |
| 11 | **消息 ID 生成器跨实例碰撞**：`时间戳+实例内计数器` 在"同毫秒 + 计数器归零"时产生相同 ID，被主键拒绝后表现为"新建消息失败" | 我的"重启后仍能找到同一消息"测试 | 改用 `crypto.randomUUID()`。真正的收获是：**主键把生成器的 bug 暴露了出来**，而不是让它静默产生重复身份 |
| 12 | **持久化版本的"stranded ending"判定错了**：按 `status !== 'open'` 判断会导致传输中断（markError 置为 error 但从未写终止帧）的消息**永远拿不到结尾** | 我的 store 单测 | 改为判断**是否存在终止帧**，并让 `appendTerminalIfStranded` 绕过 open 守卫走同一条 `#insert` 路径；接口与内存版逐一对齐 |
| 13 | **鉴权占位接受任意非空 Bearer**：`Authorization: Bearer <任意字符串>` 直接变成 `user:<字符串>`，使**续传归属、`request_id` 幂等、额度账本**三处校验同时失效（归属校验不可能强于它所依据的身份） | 代码审查 + 新增的 session 测试（伪造/跨密钥/过期各一例） | 换成 HMAC-SHA256 签名会话（`src/session.mjs`）：无 `alg` 协商、`timingSafeEqual` 常量时间比较、`exp` 缺失即拒、失败码区分"过期"与"格式错"。**不能验证的令牌不再产生身份**，未配置校验器时也不得信任 |
| 14 | **测试自己依赖了这个洞**：36 处测试用 `Bearer acct-1` 这类任意字符串当身份 | 替换鉴权后套件立即变红 | 新增 `test/helpers.mjs`，所有测试改为**用与服务端相同的密钥现签令牌**；独立验收台则通过**开关式 dev 端点经 HTTP 签发**（保持"不 import 被测代码"的独立性） |

## 明确尚未实现（骨架故意留白，不是缺陷）

- **历法内核**：`kernel.mjs` 是 stub，四柱为占位值，`notes`/`todos` 里如实标注；真实实现需接历法库（节气、真太阳时、DST 历史、子时口径、藏干/十神/大运）。
- **模型调用**：`narrator.mjs` 是确定性假叙述器，不联网、不需要 API key；替换点就是它。
- **持久化**：`stream-hub` 与 `quota` 是内存实现。生产要求：`(message_id, seq)` 唯一约束、按 `(principal, request_id)` 唯一索引、跨进程的额度账本。
- **鉴权**：`resolvePrincipal` 接受任意非空 Bearer；生产必须做签名/会话校验。
- **计费与退款**：额度在消息创建时扣减；`retryable` 的终止错误按策略退款尚未实现（协议里已写明）。
- **管理面**：配额后台、风控、内容审核、观测与告警。

## 复现

```bash
WS=/Users/xiaolv/Documents/deepseek-harness/default-workspace
NODE=/Users/xiaolv/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node

cd "$WS/build/skeleton" && "$NODE" --test 'test/*.test.mjs'            # 94/0（真实内核）
cd "$WS/build/skeleton" && SHENSHA_KERNEL=stub "$NODE" --test 'test/*.test.mjs'   # 94/0（占位内核）
cd "$WS/build/skeleton" && SHENSHA_STORE=sqlite "$NODE" --test 'test/*.test.mjs'  # 94/0（持久化存储）
cd "$WS" && "$NODE" build/verify/acceptance.mjs                       # 31/31 ACCEPTANCE: PASS
cd "$WS" && "$NODE" build/verify/kernel-crosscheck.mjs                # 20/20 ACCEPTANCE: PASS（含精度目标）

# 历法内核自带测试（43/43）
cd "$WS/build/kernel" && "$NODE" --test 'test/*.test.mjs'
```

## 交节精度：门槛区分（重要）

`kernel-crosscheck.mjs` 的 20 条**全部为绿**（v3 / VSOP87D 之后）。

| 类别 | 内容 | 状态 |
|---|---|---|
| **安全门禁**（必须常绿） | 上报的 `termAccuracySeconds` 必须 **≥ 实测最大误差**（低报误差窗口比窗口宽得多更危险） | ✅ 绿 |
| **安全门禁**（必须常绿） | 落在误差窗口内的出生时刻必须被标记（`boundaryUncertainty.applies=true`）且给出文案 | ✅ 绿 |
| **安全门禁**（必须常绿） | 远离边界的出生时刻**不得**被标记（不狼来了） | ✅ 绿 |
| **精度目标**（v3 已达成） | 50 点节气集合 max ≤ 2 分钟；立春两侧各 1 分钟的年/月柱正确 | ✅ **实测 9.6 秒** |
| 审计对象正确性 | 门禁必须审**真正在用的**模块（曾因主模块换成 VSOP87 而仍审旧模块） | ✅ 绿 |

**为什么这样分**：即使在 8.8 分钟误差的 v2 阶段，产品也不会"静默出错"——它会明确标记换界。
真正的危险是**低估自己的误差**，所以那条排序在精度目标之上；v3 提升精度后，
诚实性机制**保留未拆**，只是窗口从 528 s 收窄到 60 s。

## 真实内核接入（2026-10-12）

`build/kernel/`（锚定干支日 + 立春/节分界 + 五虎遁/五鼠遁 + IANA 时区与 DST）已成为**默认内核**，
经 `src/kernel-active.mjs` 装配；`SHENSHA_KERNEL=stub` 退回占位内核，两种模式测试均为 94/0。

外部锚点全部通过（`kernel-crosscheck.mjs` 12/15，其中 12 条为通过项）：

| 锚点 | 结果 |
|---|---|
| 1949-10-01 = 甲子日（Zenodo A3，"三源一致"） | ✅ `day=jia-zi` |
| 2000-01-01 = 己卯年 丙子月 戊午日（老黄历） | ✅ 三柱全部一致 |
| 2000-01-01 各时辰时干（五鼠遁 戊日→子时壬） | ✅ `ren-zi` / `ding-si` / `gui-hai` |
| 日柱逐日 +1、60 日回归（跨 5 年） | ✅ |
| 十二时辰窗口（13 个采样点） | ✅ |
| 年柱不在 1 月 1 日翻转 | ✅ |
| 23:00 换日两种口径 | ✅ `midnight→戊午`、`zi-chu→己未` |
| 时辰边界 22:59/23:01 | ✅ `癸亥`/`壬子` |
| `computeFacts` 纯函数性 | ✅ |

**未通过的三条全部由交节精度引起**：精度 8.1 min > 2 min 门禁；且因 2024 立春算早了 2.2 分钟，
`16:25` 被划入甲辰年（应为癸卯）——边界用例正是为暴露这种"精度不足 ⇒ 静默错柱"而写的。
