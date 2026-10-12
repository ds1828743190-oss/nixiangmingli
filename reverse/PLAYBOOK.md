# PLAYBOOK：从这两家能抄什么、怎么用 REA 做同类逆向

来源：[COMPARISON.md](COMPARISON.md)、[fatetell/REPORT.md](fatetell/REPORT.md)、[fatemaster/REPORT.md](fatemaster/REPORT.md)。
只写有观测支撑的模式；每条都标出证据出处。

---

## A. 可复用的产品/Agent 设计模式（按价值排序）

### A1. 确定性内核 + 受限叙述层（两家独立收敛，最高价值）
排盘/历法/起卦一律由规则引擎算，模型只负责把已算出的结构讲清楚。
- FateMaster 产品文案原话：「排盘由确定性规则引擎完成…**AI 不参与排盘**，只负责把排好的结构讲清楚」。
- FateTell 三段式：「专业算法插件解决排盘 → 专家系统整合多流派 → 人（价值对齐）解读」，并公开批评通用 LLM 的历法错误与**谄媚**。
- 落地要点：模型输入里**必须**带结构化事实（四柱/藏干/神煞/格局），并且 UI 把这些事实与散文**并列展示**，让用户能审计推导（FateTell `/archive` 的做法）。
- 反面清单也写进产品：FateMaster 明确 Agent **不得伪造命盘**、**不抽塔罗**（"需要抽牌请用独立工具"）。

### A2. 把"思考 / 工具 / 正文"做成协议一等公民
FateMaster 的 NDJSON 流消息类型（观测自调用点）：
`keep-alive`、`error{message}`、`reasoning{content}`、`phase_change`、`content{content}`、`conversation_id`、
`tool_call{name,arguments}`、`tool_result{index,result}`。
配套：30s 无活动超时（5s 轮询）→ abort；重试 3 次 / 2s 退避；UI 把 reasoning 放独立折叠面板、工具调用渲染成
"分析中，已调用 N 个工具"、结束显示"共 N 次查询"。
→ 直接可抄的协议形状；比把 CoT 塞进 content 让前端正则解析稳健得多。

**更值得抄的是"可续传的流"**（FateTell，登录后实测）：SSE over `fetch()` + `getReader()`，按 `\n\n` 切帧、
只解析 `data:` 行 JSON；事件 `start|message|action|end|error`；每帧带 `messageId`、**`seq`**、`retryable`；
重试 `{maxRetries:5, baseDelay:1000, maxDurationMs:120000}`，断线后
`GET /api/v3/{channel}/messages/{messageId}/stream?from_seq=N` **从断点续传**。
→ 长回答断网时"接着写"而不是重生成，这是命理/长文这类高延迟场景的关键体验设计。
（顺带：FateTell 用 `Accept: text/event-stream`，FateMaster 却是 `content-type: text/plain` + 自定义
`x-experimental-stream-data` 的 NDJSON——**同一家产品线里两种风格都成立，别把传输当成推断依据**。）

### A3. 工具按 surface 作用域注册，而不是一个全局大注册表
FateMaster 在 i18n 目录里暴露了 ~45 个工具名，分六组（八字/紫微/占卜/黄历/关系/记忆/misc），
并且图表分析面、关系面各有**更窄的工具子集**。→ 每个界面只加载自己那组，schema 更小、越权面更小、评测更好做。

### A4. 长文交付 = 章节化 + 进度语义 + 异步送达 + 可重放
FateMaster 人生报告：免费主判词 → 付费 10 章；生成时暴露流水线阶段（立盘→换算干支历→甲子轮锁定→
校验刑冲会合→检索六十神煞→推演大运→称身→深度模型执笔），每章"执笔/定稿"，支持 replay，5–10 分钟后**邮件送达**。
FateTell FateBook：10 张卡（隐喻名 + 功能名），阅读进度，门控文案 "Only part of this chapter is shown"。
→ 长任务要给"正在做什么"的语义，而不是一个转圈；交付走异步，别让用户守着 tab。

### A5. 额度即错误码契约
FateMaster 实际返回：`ANON_CALC_LIMIT`、`BIRTH_PLACE_REQUIRED`、`BIRTH_TIME_REQUIRED`、`INVALID_LUNAR_DATE`、
`CALCULATION_FAILED`、`INCOMPLETE_INFORMATION`、`INVALID_RELATIONSHIP_TYPE`、`INTERNAL_SERVER_ERROR`、
`ANON_LIMIT_REACHED`、`DAILY_LIMIT_REACHED`、`AGENT_TRIAL_EXHAUSTED`(403)。
→ 前端按 code 分支、文案可国际化，比按 HTTP 状态猜要稳。匿名试用（trial）比硬门禁转化更好。

**实测到的免费层尺度（2026-10-12，登录态）**：FateMaster agent 试用 `agentTrial{limit:2}`——**两条消息**就用尽；
FateTell 占卜 `bagua 1/1`（当日），用尽后页面**直接不渲染输入框**，只留"购买 FATETELL"入口。
→ 免费层被压到"刚好够体验一次、不够比较"的程度，这是刻意的转化设计；做同类产品时要主动决定这个数字，
因为它直接决定试用期能否观察到工具调用（我们的取证就正好卡在这条线上）。

### A6. 服务端权威额度 + 客户端只做首屏乐观渲染
FateMaster：`localStorage["<userId>_cachedAccessDetails"]` 只用于首屏；真正的额度由生成接口独立返回错误。
FateTell：`/user/web-benefits` + `/user/web-benefits/usage/{productId}` 供额，门控 UI 在客户端。
→ 客户端缓存可以提升体验，但**绝不能被当作授权依据**。

### A7. 免费钩子 + 可读样例（暗漏斗）
- 无需注册的确定性工具（FateTell `/bazi-calculator`，FateMaster 14 宫格工具台）。
- 一份**完整可读**的样例报告：FateTell 的 `/archive` 甚至**不在 sitemap 中**，只在运行时从 `/ai-fortune-teller` 预取被发现 → 有意保留的"暗入口"。
- 样例必须声明数据为虚构、时间线锚定在某年（FateTell `/archive` 就这么写），既真实又不承担责任。

### A8. 记忆与"我是谁"锚点
FateMaster：服务端记忆 + 管理 UI（关于你 / 关于命例人物，可编辑/删除/清空），工具
`save_memory`/`recall_memories`/`update_memory`；且明确声明"**记忆不会改变排盘公式**"。
"本人档案"是跨 surface 的一等概念（`selfSetup`、`selfGate`、`import_self_profile_from_contact`）。
FateTell：多出生档案 CRUD（`/user/{add,get,update,remove}-archive`），按档案出年度报告。
→ 记忆要可管理、可删除，并明确它**不影响确定性计算**——这既是合规也是信任。

### A9. 归因与定价管道
- 定价：FateMaster `GET /api/prices?locale=` 直出 Stripe Price 对象，服务端渲染 `/pricing`；结账
  `POST /api/create-checkout-session{price,locale,touchpoint,context:{page,entrypoint,preCheckoutPage}}`，
  `preCheckoutPage` 由 `deferred-global-effects.js` 写 `sessionStorage.pre_checkout_page`；埋 `paywall_view`。
- 归因：`/api/attribution` 首触归因，referrer 分类**包含 AI 助手**（chatgpt/claude/perplexity/poe…）→ GEO 被当正式渠道。
- FateTell：OpenAI Ads `oaiq` 像素 + `oppref/__obref` 从营销站透传到 `web.` 深链；PostHog 用隐私优先默认值
  （`person_profiles:"never"`、`autocapture:false`、`respect_dnt:true`），同意后才 flush 队列。

### A10. 增长：实体礼品卡 / KOL 码 / 邀请 / 双人合盘
FateTell 的 `redeem_*`（163 条）是一套完整的实体卡兑换系统：一次性、非转让、首次绑定账号与档案、
**平台绑定**（网页版 FateBook vs App 内 Pocket FateBook 二选一）；外加 `kol_*`（52 条）与
`invite_*`（41 条）、`connection_invite_*`（双人合盘邀请）。→ 命理品类线下礼品化是被验证的渠道。

### A11. 内容护城河（GEO/SEO）
FateMaster：**4,115** URL / 12 个子 sitemap，按领域原语（神煞 285、格局 120、卦 320、黄历日 1210、
星曜 470、塔罗 395、生肖 60）程序化生成，×5 语言。FateTell：81 URL + Framer 文档站 + 博客子域 + 8 语言。
→ 长尾不是"多写文章"，而是**每个领域原语一页**。

**把 AI 爬虫当渠道，而且要写进 robots.txt。** FateMaster 的 `robots.txt` 直接留了运维注释：
*"AI 爬虫：允许抓取内容页（GEO：让 AI 搜索/问答引擎能引用本站内容）… 曾经封禁 GPTBot/anthropic-ai
导致 ChatGPT/Claude 无法引用本站，已于 2026-07 放开。"* 配合其归因把 chatgpt/claude/perplexity/poe
单列为来源桶——**解封 AI 爬虫 + 度量 AI 来源**是一套完整的 GEO 增长动作，值得直接照搬。

### A12. 明确的"不做什么"
FateMaster 把塔罗排除在 Agent 之外、把"不伪造命盘"写成保证；这类**能力边界声明**本身是信任与评测的抓手。

---

## B. REA 实战方法论（含踩坑）

### B1. 推荐流程（本次验证有效）
1. `capture-browser-scenario <input.json> --format json > raw/capture.json` — 有界浏览器场景，抓 DOM/AX/网络/存储/截图。
2. `export-web-scripts <capture.json> <outDir>` — 把已保留脚本站盘。
3. 直接 **grep/AST 读盘上的 JS**，而不是依赖 `analyze-javascript-application` 的图投影（覆盖太低，见 B3）。
4. 交叉验证：`-/_next/static/chunks/*.js` 这类静态资源可直接下载；但 `robots.txt` 里 `Disallow: /api/` 的路径**不要**直接请求。

### B2. 控制上下文（REA 输出极大）
- `binary_session` 单次 ~177 KB；`app-graph.json` 可达 97 MB。
- 用全局选项 `--filter-output <keys>`、`--token-limit`、`--format md`，并**先落盘再离线 grep**。
- 在 DSH 会话内用 MCP 工具时同样成立：只调窄口径工具，宽口径工具的结果优先写盘。

### B3. 已知工具缺陷（两家独立复现，值得上游报 issue）
| 现象 | 触发 | 绕过 |
|---|---|---|
| `cleanup_incomplete`（退出码 1，`Analysis operation timed out after 1000ms: capture_browser_scenario`） | 7 次里 4 次（FateTell）、5 次里 2 次（FateMaster，含 `capture.at_end` 带 `storage` 时） | 数据**完整**保留在 `details.partial_observation.capture`；只需解包。FateMaster 侧发现**去掉 `storage` 采集**即可干净通过 |
| `export-web-scripts` 拒绝错误信封 capture（"Expected a valid inspect_web_page or capture_browser_scenario capture…"） | capture 处于错误信封时 | 自己把已保留的 base64 响应体解出来（按 `sha256` 校验）——两家都这么做 |
| `analyze-javascript-application` 覆盖极低 | FateTell：19 个文件只解析 5 个、`modules: 0`；FateMaster：145 个只解析 3 个、`findings` 里 10,915 条 `undefined` 关系 | 不要把结论建立在该图上；以导出的原始 bundle 为准 |
| 需要绝对路径 | `export-web-scripts` 传相对路径直接报错 | 一律传绝对路径 |
| Cloudflare 过滤非浏览器客户端 | `curl` 取 `fatetell.com/archive` 30s 超时，浏览器正常 | 用浏览器场景，不要绕过 |

### B4. 纪律（本次遵守，建议固化为规则）
- 只碰公开未登录面；不登录、不付费、不绕验证码、不批量抓取、不探测漏洞、不耗竭配额。
- 尊重 `robots.txt`：两家都 `Disallow: /api/`，因此所有 API 事实来自**页面自身发出的流量**或**已捕获字节里的静态字符串**。
- 结论分 **Observed / Derived / Unknown** 三档；每条非显然结论必须能指到文件 + 偏移/JSON 指针。
- 工具缺陷与限流要写进报告的 Limitations，而不是静默略过。

### B5. 想深入登录后的面时（不交凭据的做法）
用户自己启动可远程调试的 Chrome 并手动登录，REA 只读附着：
```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9333 --user-data-dir="$HOME/.rea-login-profile"
```
然后用 `list_browser_targets` → `observe_web_session` / `inspect_web_page`（可选 `observe_web_execution`）。
这样拿到的仍是**页面结构与网络元数据**，而不是用户凭据。

本次实测的 5 条经验（都是踩出来的）：

1. **connect 模式会 `page.goto` 同一个 URL**——目标标签页会被**重载**（FateMaster 原本可见的会话被换成新会话），
   并临时套用 CDP 的视口/语言覆盖。跑之前必须先告诉用户"页面会被刷新"。
2. **REA 会预先打码 `cookie` / `authorization`**，但**不要**在登录页上开 storage 采集——那是主动取凭据。
3. **发一条消息就是在花用户的额度**。先在 `/api/access` 或额度接口确认真实上限（本次 FateMaster 是 `limit:2`），
   把发送次数当稀缺资源规划；额度耗尽后 `tool_call` 帧就再也看不到了。
4. **没人操作就没有流**：`observe_web_session` 需要用户当场操作；要自己触发就用
   `capture-browser-scenario` 的 connect 模式，并在 `capture.network` 里同时选
   `request_body` + `response_body` + `header_values`。
5. **等价性陷阱**：声明里出现的前缀常量可能根本没有引用点（FateTell 的 `/capi` 就是死常量，
   真正在用的是 `/api/v3`）。任何"配置里写了 X"都要用**引用点**或**实际流量**复核。

---

## C. 如果要在 DSH 里复刻一套同类 Agent，最小可行清单

1. **确定性子系统**：把领域计算做成纯函数/库（本地或服务端），并配一套"事实 JSON"作为模型输入的骨架。
2. **受限叙述层**：system prompt 里写死"只解释给定事实、不得发明"；把反捏造写成产品保证与测试用例。
3. **流式协议**：NDJSON + `reasoning`/`tool_call`/`tool_result`/`phase_change`/`content`，客户端分区渲染。
4. **工具注册**：按 surface 分组注册（DSH 侧可用 `ctx.tools.register()` / 作用域），避免全局大 schema。
5. **额度与授权**：服务端权威 + 机器可读错误码；客户端缓存只做 optimistic UI。
6. **长文交付**：章节化 + 阶段进度 + 异步送达 + replay。
7. **记忆**：可管理（改/删/清空），并声明不影响确定性计算。
8. **免费钩子 + 样例报告**（可以是暗入口）。
9. **埋点与归因**：隐私优先默认值 + 首触归因（把 AI 助手 referrer 当渠道）。
10. **长尾内容**：按领域原语程序化生成 + 多语言。
