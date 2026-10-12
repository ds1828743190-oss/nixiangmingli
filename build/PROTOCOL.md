# 协议规范 v1（可实现的契约）

本文把自己产品的**流、工具、额度**三件事冻结成契约。规则来源是两家产品的实测行为
（[logged-in/REPORT.md](../reverse/logged-in/REPORT.md)、[COMPARISON.md](../reverse/COMPARISON.md) §3），
但我们定义的是**自己的 v1**，不是逐字节兼容层。参考实现见 [skeleton/](skeleton/)。

**改这份协议必须升版本号**；前后端各自声明自己支持的版本。

---

## 1. 三条通道总览

| 通道 | 传输 | 用途 | 续传 |
|---|---|---|---|
| **A. Agent 流** | `POST /api/agent/chat` → NDJSON（`content-type: text/plain`，一行一个 JSON） | 对话式 Agent（推理 + 工具 + 正文） | 否（短连接语义，重发幂等） |
| **B. 长回答流** | `POST /api/v1/{channel}/messages` → SSE（`data: <json>\n\n`） | 单次解读/长文，最需要断点续传 | **是**：`GET /api/v1/{channel}/messages/{messageId}/stream?from_seq=N` |
| **C. 内核调用** | `POST /api/bazi-calculate` → 普通 JSON | 纯确定性计算，**不经过 LLM** | 不适用（纯函数、可缓存） |

为什么区分 A/B：实测两家都**不**用 EventSource，都用 `fetch()` + `getReader()`。
A 走 NDJSON 更适合工具/阶段交织；B 走 SSE 帧格式便于带 `seq` 做续传。

---

## 2. 通道 A：NDJSON 帧定义

请求：`{ conversationId, message, timezone, language }`
响应：每行一个 JSON 对象，`\n` 结尾；解析必须容忍**半包**（按行缓冲，不能假设一次 chunk 是一帧）。

| kind | payload | 语义 | 客户端行为 |
|---|---|---|---|
| `conversation_id` | `{conversationId}` | 会话建立/复用（新会话首帧） | 存 id，后续请求带上 |
| `reasoning` | `{content}` | 思考流 | 追加到**折叠的思考区**，不进正文 |
| `phase_change` | `{}` | 从思考切到正文 | 折叠思考区，准备正文容器 |
| `tool_call` | `{toolCall:{name, arguments}}` | 即将调用工具 | 渲染"正在查询 X…"；记录 index |
| `tool_result` | `{index, result}` | 工具返回 | 按 index 回填对应调用，展示摘要 |
| `content` | `{content}` | 正文流 | 追加到正文 |
| `keep-alive` | `{}` | 心跳（防超时/防代理断连） | 忽略，但**刷新本地超时计时器** |
| `error` | `{message}` | 可展示错误 | 终止，显示 message |

**客户端读取规则（照抄实测的稳健做法）**
1. `getReader()` → `TextDecoder.decode(chunk, {stream:true})` → 累积缓冲 → 按 `\n` 切分 → `JSON.parse` 每行；残缺尾行留在缓冲。
2. **30s 无活动超时**（每 5s 轮询检查）→ abort。
3. 失败重试 **≤3 次，退避 2s**；重试必须带**同一个 `request_id`**（见 §5 幂等）。

---

## 3. 通道 B：SSE 帧 + 续传

请求：`{content, conversation_id, archive_id, request_id}`；头 `Accept: text/event-stream`。
响应：`data: <json>\n\n`，帧 JSON：

```json
{ "messageId": "msg_...", "seq": 12, "retryable": true,
  "msg": { "kind": "message", "content": "..." } }
```

| 帧内 `msg.kind` | 语义 |
|---|---|
| `start` | 流已建立（必须首帧） |
| `message` | 正文增量 |
| `action` | 工具/阶段动作（进度语义） |
| `end` | 正常结束（必须终帧） |
| `error` | 错误终止；`retryable` 决定是否可重试 |

**续传语义（规范）**
- `seq` 在**同一 `messageId` 内单调递增**，从 1 开始，不跳号、不重用；
- 服务端**持久化已发送帧**（至少保留到该消息终态 + 24h）；
- `GET .../stream?from_seq=N` 返回**严格 `seq > N`** 的帧，顺序不变，**无缺口、无重复**；
- 若消息已 `end`/`error`，先补发缺失帧，再发终帧后关闭；
- 客户端记录已收最大 `seq`，重连时带 `from_seq = maxSeq`。

**重试策略**：`{maxRetries:5, baseDelayMs:1000, maxDurationMs:120000}`，指数退避并被上限截断；
超过预算则展示"可重试"按钮而不是静默失败。

> 这条是整套设计里最值钱的部分：长回答（5–10 分钟）断网后**接着写**，而不是重新生成一遍——
> 既省成本，也避免用户看到两份不一致的答案。

---

## 4. 工具协议

**注册**（每个工具必须完整声明，缺一不注册）：

```json
{
  "name": "get_huangli_for_date",
  "description": "查询某日的黄历宜忌（确定性数据，不经过模型推断）",
  "inputSchema": { "type": "object", "properties": {...}, "required": [...] },
  "scopes": ["almanac"],            // 按 surface 作用域，不要全局注册表
  "effects": { "readOnly": true, "writesData": false, "opensWorld": false }
}
```

**规则**
1. **按 surface 注册**：每个界面只暴露自己那组工具，schema 更小、越权面更小（两家都这么做）。
2. **先校验、后执行**：参数不合 `inputSchema` 一律**不调用** handler，返回类型化错误。
3. **工具名用动词_名词**（`calculate_bazi`、`get_dayun_info`、`cast_liuyao`、`save_memory`），
   稳定的名字是可观测性、权限与评测的基础。
4. **每个工具返回结构化数据 + 人读摘要**；模型只消费结构化结果，不解析自然语言。
5. `tool_call` / `tool_result` 必须成对出现在流里，`index` 绑定；
   返回值过大时截断并在结果里标注 `truncated: true`。
6. `effects` 用于权限与审计：涉及写入/外网的工具需要显式允许。

---

## 4bis. 出生数据的输入契约（结构化优先，散文永不作数）

**规则：内核只接受结构化出生数据。** 任何从自然语言里正则抠出来的日期，**不得**作为排盘依据。

理由不是洁癖，而是这个品类的头号事故：用户说"我 90 年的"，模型猜成 1990-01-01，
于是一整份报告建立在一个错误的命盘上——而用户无法从文字里察觉。骨架里的
`extractDate()` 只是一个演示替身，它自己在注释里就写明"绝不能成为权威日期"。

**通道 B 请求体扩展**

```json
{
  "content": "帮我看一下今年的运势",
  "conversation_id": "…", "archive_id": "…", "request_id": "…",
  "birth": {                        // 可选，但排盘/运势类请求必需
    "date": "1990-05-17",           // YYYY-MM-DD，公历
    "time": "08:30",                // HH:MM；未知时显式传 null 而不是猜
    "timezone": "Asia/Shanghai",    // IANA
    "gender": "female",
    "dayBoundary": "midnight",      // 或 "zi-chu"（23:00 换日）
    "useTrueSolarTime": false,
    "longitude": 120.15             // 仅当 useTrueSolarTime=true 时使用
  }
}
```

**判定顺序**

| 情况 | 行为 |
|---|---|
| 请求面需要命盘且 `birth` 完整 | 内核用 `birth` 计算 → 叙述层只解释产出的事实 |
| 需要命盘但 `birth` 缺失/不全 | `400 INCOMPLETE_INFORMATION`，`details.missing` 逐项列出（`date` / `time` / `place`）；**不要**用散文里的日期替用户补全 |
| 用户明确表示不知道出生时间 | 允许 `time: null`，此时**时柱标为未知**并在报告中显式声明；不得默认为 12:00 或 00:00 |
| 纯知识问答（不问命盘） | 不调用内核，也就没有 Facts；叙述层必须声明"本次回答不基于你的命盘" |

**为什么把 `time: null` 单列**：不知道时辰是常态，而不是错误输入。假装知道会污染时柱与
"胎命身"等下游结构；显式未知则让产品可以退化成"六字"结论并如实说明——这也是可审计的一部分。

**服务端校验顺序**（与 §6 的错误码配套）：登录 → 额度 → 结构校验（`birth` 字段与取值范围）
→ 内核计算 → 叙述。结构校验必须在内核之前，且失败时不消耗额度。

### 4bis.1 交节精度与"边界不确定带"（内核必须暴露的两个字段）

年柱以**立春时刻**为界、月柱以**节**为界，所以节气时刻的误差会直接变成**静默的柱子错误**。
内核必须把这件事说出来，而不是让误差藏着：

```json
"calendar": {
  "termAccuracySeconds": 60,
  "nearestTerm": { "name": "lichun", "instant": "2024-02-04T08:26:53.000Z", "deltaSeconds": 412 },
  "boundaryUncertainty": {
    "applies": true,
    "windowSeconds": 60,
    "message": "出生时刻距立春仅 6 分 52 秒，年柱可能处于换界处"
  }
}
```

| 字段 | 含义 | 为什么必须有 |
|---|---|---|
| `termAccuracySeconds` | 本内核所实现节气算法自身的误差上限（如低精度公式 ≈ 960、高精度级数 ≈ 60） | 产品的"确定性"承诺必须带上它的精度边界；否则等于宣称完美 |
| `nearestTerm` | 出生时刻最近的节/立春及其时间差 | 让"边界命例"可被检索、可被复核 |
| `boundaryUncertainty.applies` | 当 `|deltaSeconds| ≤ termAccuracySeconds` 时为 true | **不确定时必须说不确定**：宁可提示"你的出生时刻正好在换月边界上"，也不要静默选一个可能错的柱子 |

**验收要求**
1. 内核的 `termAccuracySeconds` 必须由**与公开发布的节气表比对**得出，并写进内核 README；
   `build/verify/kernel-crosscheck.mjs` 里的门禁（当前阈值 2 分钟）必须为绿。
2. 边界用例：取某个节前后各 1 分钟的两个出生时刻，断言月柱不同；再取 `±termAccuracySeconds`
   内的时刻，断言 `boundaryUncertainty.applies === true`。
3. 不允许"把误差抹平成 0"来通过门禁——如实上报误差并提示边界，才是这套架构要的性质。

---

## 5. 幂等与计费

**计费时机：在消息创建时扣减一次**（不是生成成功后才扣）。理由：按"成功"计费会被人用失败重试套利，
而且长文生成本来就是异步的，"成功"的判定点会漂移。代价是服务端故障会让用户损失一次额度，
所以约定：**终止帧为 `error` 且 `retryable: true` 时，允许按策略把该次额度退回**
（骨架不实现退款，但保留 `code` 供策略层判断）。

- 客户端每次请求生成 `request_id`；**重试复用同一个**。
- 服务端以 `(principal, request_id)` 建唯一约束：
  - **重放**：同一 `request_id` 再来一次 → 不新建消息、**不再扣减、不再调模型**，返回**同一个
    `x-message-id`**，并把已存帧照原样回放（客户端要能续上原来那份回答，而不是拿到第二份不同的）；
  - **重放不受额度影响**：原来的那次已经付过费，所以即使额度此刻已耗尽，重放/续传仍必须成功；
  - 处理中 → 返回同一 `messageId` 走续传（§3）。
- 续传、重连、传输层重试**都不是新消息**，因此都不是第二次扣费。
- 归属校验：`messageId` 的续传与重放都必须校验**同一个 principal**，否则返回 404
  （不要把 `messageId` 当成可跨账号使用的凭据）。

---

## 6. 额度与错误码（机器可读，客户端按 code 分支）

`GET /api/access`：

```json
{ "hasSubscription": false, "hasPurchase": false, "accessType": "trial",
  "accessEndDate": null, "remainingTime": null,
  "agentTrial": { "limit": 2, "used": 1, "remaining": 1, "hasRemaining": true } }
```

| code | HTTP | 含义 | 客户端文案方向 |
|---|---|---|---|
| `ANON_CALC_LIMIT` | 403 | 匿名排盘次数用尽 | 引导注册 |
| `BIRTH_PLACE_REQUIRED` | 400 | 缺出生地（影响真太阳时） | 表单聚焦 |
| `BIRTH_TIME_REQUIRED` | 400 | 缺出生时间（当前内核无法表达"时柱未知"） | 提供"我不知道时间"分支 |
| `INVALID_TIMEZONE` | 400 | 未知的 IANA 时区（**必须拒绝**：它决定节气与换日的判定） | 从下拉框选真实时区 |
| `INVALID_LUNAR_DATE` | 400 | 农历日期非法 | 就地纠正 |
| `INCOMPLETE_INFORMATION` | 400 | 信息不全 | 列出缺项 |
| `ANON_LIMIT_REACHED` | 403 | 匿名 AI 用量用尽（**无试用额度**的界面用；有试用的界面用下面的 `AGENT_TRIAL_EXHAUSTED`） | 引导注册/购买 |
| `DAILY_LIMIT_REACHED` | 403 | 当日额度用尽（含重置时间） | 告知明日重置 |
| `AGENT_TRIAL_EXHAUSTED` | 403 | Agent 试用结束（**匿名与登录共用同一个试用计数器**） | 升级入口（不要静默失败） |
| `INTERNAL_SERVER_ERROR` | 500 | 服务端异常 | 可重试按钮 |

**额度判定顺序（契约，必须逐条按序）**

```
无凭据            -> 401 UNAUTHENTICATED            （去登录；不是额度问题）
匿名              -> 403 ANON_LIMIT_REACHED         （store 层兜底；HTTP 层已由 401 拦下）
试用有余额        -> 放行
无订阅且无单次购买 -> 403 AGENT_TRIAL_EXHAUSTED      （升级时刻，必须独立成码）
订阅/已购 + 日额度有余 -> 放行
否则              -> 403 DAILY_LIMIT_REACHED        （并告知重置时间）
```

这条顺序里最容易写错、也最伤用户的一步是第三条：**没有付费权益、试用也用完时，绝不能回
`DAILY_LIMIT_REACHED`**——那等于告诉一个免费用户"明天再来"，而那份额度对他永远不会回来。
实测骨架早期版本正是如此（`AGENT_TRIAL_EXHAUSTED` 不可达），已修正并固化为验收项。

**`/api/access` 必须读真实权益**（订阅/单次购买），不能把 `hasSubscription`/`hasPurchase` 写死——
写死会让任何付费墙 UI 失去意义。`agentTrial` 与上述判定共用同一个计数器。

**状态码为什么统一用 403，而不是 429**：额度用尽是一个**授权判断**，不是传输层限流；`429` 留给真正的
速率限制（带 `Retry-After`）。这与实测一致——被测产品在 Agent 试用用尽时返回的就是
`403 { code: "AGENT_TRIAL_EXHAUSTED" }`。客户端只按 `code` 分支，`status` 仅作传输层判断。

**匿名试用规则（不变量）**：`GET /api/access` 暴露的 `agentTrial` 计数器，必须**就是**
Agent 请求实际扣减与拒绝所依据的那个计数器。任何"快照说还有次数、请求却被拒"的组合都是 bug，
因为客户端会把两者同时展示给用户。

**同条件同答案（不变量）**：同一个条件在所有 Agent 通道上必须给同一个答案。当前产品决策是
**Agent 需要登录**（对齐实测：对话能力在登录后才加载），因此"无凭据"这一条件在所有 Agent 通道上
一律回答 `401 UNAUTHENTICATED`——不能一条通道 401、另一条 403。相应地，匿名主体的快照必须
**不谎报**可用额度：

```json
{ "accessType": null, "signInRequired": true,
  "agentTrial": { "limit": 0, "used": 0, "remaining": 0, "hasRemaining": false } }
```

`signInRequired` 是新增的可选字段（向后兼容）：客户端据此渲染"登录后可用"，而不是把它当成
"额度用尽"——两者的补救措施完全不同。匿名用户仍然可以使用**确定性**工具（排盘等，走
`ANON_CALC_LIMIT`），这正是免费钩子；`ANON_LIMIT_REACHED` 保留给"允许陌生人使用 AI 分析"
的界面（本骨架未实现该界面）。

> 若产品决定改为"匿名也给 2 次对话"，只需改一处策略开关：让匿名主体拿到 `agentTrial`，
> 并让快照如实上报该计数器。上面的两条不变量仍然成立——变的只是数值，不是结构。

**额度耗尽不是错误页**：失败发生在生成开始之前，所以用一个干净的 4xx + `code` 结束，
不要先开流再在流里报错——那会让客户端已经渲染了半截界面。

**规则**：额度判定只在服务端；客户端 `localStorage` 缓存**仅用于首屏乐观渲染**，任何生成请求都要重新校验。

---

## 6bis. 会话与鉴权（Bearer 必须是**签名**令牌）

**规则：不能验证的令牌不是"弱身份"，而是没有身份。** 服务端绝不把 `Bearer <任意字符串>` 当成 `user:<字符串>`
——那会让下游所有归属校验（续传读取、`request_id` 幂等、额度账本）全部变成装饰。

**令牌格式**（`src/session.mjs`）

```
v1.<base64url(payload)>.<base64url(HMAC-SHA256(secret, "v1." + payload))>
payload = { sub, iat, exp }        // exp 必填：没有过期时间的令牌等于永不失效
```

| 设计点 | 理由 |
|---|---|
| 不做算法协商（没有 `alg` 字段） | 算法固定，就不存在 `alg: none` 这类降级攻击面 |
| `timingSafeEqual` 常量时间比较（带长度校验） | 逐字节 `===` 会泄漏"猜对了多少字节"，足以逐字节伪造 |
| 先验签、后解析 | 不解析未验证的载荷，失败原因也统一 |
| 密钥只在进程内；令牌里没有密钥 | 泄漏令牌 = 泄漏一个会话，不是泄漏密钥 |
| `exp` 缺失即拒 | 否则会造出永不失效的令牌 |

**失败码（HTTP 401，客户端据此决策）**

| code | 含义 | 客户端动作 |
|---|---|---|
| `SESSION_MALFORMED` | 结构不对/载荷非法/缺 exp | 视为未登录（清本地令牌） |
| `SESSION_BAD_SIGNATURE` | 签名不匹配（伪造或换密钥） | 视为未登录 |
| `SESSION_EXPIRED` | 已过期 | **提示重新登录**（与"格式错"区别对待） |
| `SESSION_UNSUPPORTED_VERSION` | 版本前缀不是 `v1` | 升级客户端 |
| `SESSION_NO_SUBJECT` | 签名有效但 `sub` 为空 | 视为未登录 |
| `SESSION_NO_VERIFIER` | 服务端未配置校验器 | 视为未登录（**不是**信任） |
| `UNAUTHENTICATED` | 未带凭据 | 引导登录 |

**密钥与开关**

| 环境变量 | 作用 |
|---|---|
| `SHENSHA_SESSION_SECRET` | 签名密钥（≥16 字节）。**不设置**则每进程随机生成：演示可用，但重启即失效，且 `sessionEphemeral` 会如实上报 |
| `SHENSHA_ALLOW_DEV_SESSION=1` | 开放 `POST /api/session {sub}` 用于开发签发。**默认关闭**，关闭时返回 **404**（不是 403——探测者不该知道这个路由存在） |

**匿名免费钩子必须保留**：无凭据请求落到 `anon:<x-anon-id|default>` 主体，确定性工具（排盘）照常可用；
需要身份的是 Agent 与付费面。会话校验的引入**不得**把免费钩子一起关掉（有测试守着）。

| 协议元素 | UI |
|---|---|
---

## 7. 客户端渲染映射（协议 → UI）

| 协议元素 | UI |
|---|---|
| `reasoning` | 默认折叠的"思考过程"，可展开；**不混进正文** |
| `phase_change` | 折叠思考区，正文容器出现 |
| `tool_call`/`tool_result` | "分析中，已调用 N 个工具"，可展开看细节（名称 + 摘要，不暴露原始大对象） |
| `content` | 正文流式追加；长文按章节分容器 |
| 终帧 | 显示"已完成，共 N 次查询"；长文显示进度与"回放" |

---

## 8. 版本与兼容

- 路径带主版本：`/api/v1/...`；帧内可选 `v` 字段。新增 `kind` 视为向后兼容（客户端必须忽略未知 kind）。
- 删除/改语义必须升主版本，并保留旧版本至少一个大版本周期。
- 协议常量的等价性检查：**任何"配置里声明的前缀"都要用引用点或实际流量复核**
  （教训：两家之一声明过一个从未被引用的前缀常量，直接误导了逆向结论）。

---

## 9. 验收清单（对应骨架里的测试）

- [ ] NDJSON 帧顺序正确，半包可解析
- [ ] SSE 帧 `seq` 单调、终帧必达
- [ ] 中断后 `from_seq` 续传：**无缺口、无重复**
- [ ] 工具参数非法时 **handler 不被调用**，返回类型化错误
- [ ] 额度耗尽返回**精确 code + HTTP 状态**；免费主体试用用尽必须是 `AGENT_TRIAL_EXHAUSTED`
- [ ] 同 `request_id` 重试**不重复计费**、不重复调模型
- [ ] 匿名快照与实际判定一致（不谎报可用额度）；同条件在所有 Agent 通道给同一状态码
- [ ] 排盘类请求缺 `birth` → `400 INCOMPLETE_INFORMATION` 且**不消耗额度**；散文中的日期永不进入内核（§4bis）
- [ ] 历法内核：日柱锚点与外部来源一致、逐日 +1、年柱在立春翻转（见 `build/verify/kernel-crosscheck.mjs`）
- [ ] 未签名/伪造/跨密钥/过期令牌**一律不产生身份**（401 + 对应 `SESSION_*` 码）；服务端无校验器时也不得信任
- [ ] 匿名免费钩子仍可用：无凭据的确定性工具请求返回 200
