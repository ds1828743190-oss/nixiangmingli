# 对比：FateTell vs FateMaster.AI

依据：[fatetell/REPORT.md](fatetell/REPORT.md)（286 行，19+29 个导出脚本、7 次浏览器场景）与
[fatemaster/REPORT.md](fatemaster/REPORT.md)（533 行，145 个 JS body、5 次场景、13 个 sitemap）。
两份报告的所有非显然结论都带 **Observed / Derived / Unknown** 标注；本文件只做交叉比对。

> 校正：FateMaster 报告中的对比表写「fatetell.com 无 Vercel 头」是对的，但它把 fatetell 判为
> 纯 Cloudflare。FateTell 侧证据更完整：**Cloudflare 边缘 + Zeabur 源站**（`x-zeabur-request-id`、
> `x-zeabur-ip-country`）。下表以 FateTell 报告的观测为准。

## 1. 结构与规模

| 维度 | FateTell (fatetell.com) | FateMaster (www.fatemaster.ai) |
|---|---|---|
| 框架 | Next.js **16.3.2** + React 19.1.0，App Router/RSC，**Turbopack** | Next.js App Router/RSC，**Webpack**，`?dpl=` 部署指纹 |
| 边缘/源站 | Cloudflare **→ Zeabur** | Cloudflare **→ Vercel**（`x-vercel-id`、`x-matched-path`） |
| 站群 | 营销站 + `web.`（PWA 应用）+ `post.`（博客）+ `guide.`（**Framer**）+ `fatebook.`（TLS 已过期） | 单站 + `/history` **独立 Next.js zone**（多区挂载） |
| 语言 | **8** 种（en-US 默认 + zh-CN/zh-TW/ja/ko/vi/de/ru） | **5** 种（zh 默认无前缀 + en/zh-Hant/ja/ko），next-intl |
| 内容纵深 | sitemap **81** URL，扁平 | **4,115** URL / 12 个子 sitemap（神煞/格局/卦/黄历日/星曜/生肖） |
| 定价呈现 | 服务端渲染在 `/shop`；`/pricing` **404** | 独立 `/pricing` + `GET /api/prices?locale=` 直出 **Stripe Price 对象** |
| 价格（2026-10-12 观测） | FateBook **$39.99**、AnnualBook **$29.99**、大师对话 15 次/$4.99、AI 占卜 5 次/$4.99、年订阅 **$59.99/年** | 单日解锁 **$15** / ¥89.8、年费 **$59/年** / ¥399；仅两档；宣传「永久锁价」 |
| 移动端 | App Store `id6752552096`，iOS bundle id 编进 **Web** 包作 `appleClientId`；Web 本身可安装 PWA | 客户端内置 **Android WebView 桥**（`window.android.unLoad`） |
| 主体 | © 2026 杭州宇见飞科技（Hangzhou Yujian Flying Technology） | **POMODIARY LLC**，`hi@fatemaster.ai` |
| 身份 | 有注册/登录（邮箱验证码 + Google/Apple） | **Better Auth**（`/api/auth`，Google OAuth），匿名可试用 |
| 鉴权 | 两套并存：REST 用 token 存 cookie、以**裸** `Authorization` 发送（`authenticationScheme:""`，无 `Bearer`）；**SSE 聊天却硬编码 `Bearer`**。配 `X-FT-APP-VERSION/DEVICE-TYPE/OS/PLATFORM`，聊天另加 `From: chat`；重试 ×2/1000ms，业务码 `10011`=登录过期 | Cookie 会话，**无** `Authorization` 头（未登录与已登录的 383 个请求头普查均为 0 命中）；客户端用 `localStorage` 缓存 access 做首屏乐观渲染 |

## 2. AI 层：两家独立收敛到同一套架构

这是本次逆向最有价值的发现——**两家都把「算」与「说」严格分离**：

| | FateTell | FateMaster |
|---|---|---|
| 排盘位置 | **客户端**（浏览器内） | **服务端**（`POST /api/bazi-calculate`） |
| 排盘引擎 | **6tail lunar-javascript**（`EightChar`/`Yun`/`DaYun`/`getYearInGanZhiExact`…），页面自链 `6tail.cn/calendar/api.html` | 自研确定性规则引擎 |
| 公开的算法说法 | 三阶段：「专业算法插件解决排盘 → 专家系统整合多流派解盘 → 人（价值对齐）提供解读」；明确批评通用 LLM 的历法换算错误、训练数据流派偏置、**谄媚** | 「**排盘由确定性规则引擎完成…AI 不参与排盘，只负责把排好的结构讲清楚**」 |
| 领域规则细节 | 真太阳时、十神、藏干、纳音、神煞、空亡、大运/流年/流月、胎命身；23:00 子初 vs 00:00 换日；DST 重复时刻 | **五道时间校正**（时区→夏令时→真太阳时→子时口径→年柱立春分界）；藏干权重 本气/中气/余气 = **1.0/0.7/0.5**；**57 神煞**；**25 格局**；123 国历史时区数据 |
| 反捏造保证 | 报告把原始四柱/藏干与英文原型并列展示，便于用户审计推导 | 写进产品文案：Agent **不得伪造命盘**；塔罗**明确排除**在 Agent 之外（"需要抽牌请用独立塔罗工具"），宁可少做也不假装 |
| 工具集 | 未在公开包中暴露 | **~45 个工具**在 i18n 目录里完整枚举，且**按界面分组**（八字/紫微/占卜/黄历/关系/记忆），另有更窄的图表分析组与关系组 → 工具是**按 surface 作用域**而非全局注册表 |
| 人设 | 未观测到命名「大师」 | **确认无命名大师**（`大师`/袁天罡/李淳风… 在 145 个 JS 中 0 命中）；差异化靠"选哪门术数"与工具作用域 |
| 记忆 | 多出生档案（`/user/{add,get,update,remove}-archive`），按档案出 AnnualBook | 服务端记忆 + 管理 UI（关于你 / 关于命例人物，可改可删可清空），工具 `save_memory`/`recall_memories`/`update_memory`；文案声明"记忆不改变排盘公式" |

**共同结论**：命理类 AI 产品的正确性来自「确定性内核 + 受限叙述层」，而不是让模型自由发挥。两家还都把这条
原则**写进了面向用户的文案**（反谄媚、反伪造），把它当卖点而不是免责声明。

## 3. 流式协议（两家均已登录后实测）

登录后取证（[logged-in/REPORT.md](logged-in/REPORT.md)）补齐了这一节：

**FateTell — SSE over `fetch()`（不是 EventSource，不是 WebSocket）**
- `POST https://api.fatetell.com/api/v3/{channel}/messages`，头 `Content-Type: application/json`、
  `Authorization: Bearer <token>`、**`Accept: text/event-stream`**、`Accept-Language`、`From: chat`；
  body `{content, conversation_id, archive_id, request_id}`（占卜完结时另有 `number`）。
- 读取：`fetch()` + `resp.body.getReader()`，按 `\n\n` 切帧，只对 `/^data:\s*(.+)$/m` 行做 JSON 解析。
- 事件：`start | message | action | end | error`；每帧带 `messageId`、`seq`、`retryable`、`msg`。
- **可恢复流**：重试 `{maxRetries:5, baseDelay:1000, maxDurationMs:120000}`；
  断线后续传 `GET /api/v3/{channel}/messages/{messageId}/stream?from_seq=N`。
- 频道表：`bg → zhouyi-bagua`（bagua/zhouyi_bagua）、`dasiming → dasiming`。
- **修正**：未登录时报的 `chatUrlPrefix:"/capi"` 是**死常量**——只在一个 env 对象里声明过，无任何引用点；真正在用的是 `/api/v3`。

**FateMaster — fetch + NDJSON（不是 SSE，也不是 WebSocket）**
- `POST /api/agent/chat`，body `{conversationId, message, timezone, language}`；实测 200，响应头
  `content-type: text/plain` + `x-experimental-stream-data`（注意：**不是** `text/event-stream`）。
- 读取：`getReader()` + `TextDecoder({stream:true})` + `split("\n")` + `JSON.parse`（`new WebSocket(` 命中 0 次）。
- 消息类型：`keep-alive` / `error` / **`reasoning`** / **`phase_change`** / **`content`** / `conversation_id` /
  **`tool_call`** / **`tool_result`**（`{index, result}` 按序号回填）。
- 韧性：30s 无活动超时（5s 轮询）→ abort；最多重试 3 次，2s 退避。
- UI 语义：`reasoning` 进独立"思考过程"折叠面板；`phase_change` 切到正文流；工具调用渲染成
  "分析中，已调用 {count} 个工具…"；结束显示"共 {count} 次查询"。

→ 可复用：**把"思考 / 工具 / 正文"做成协议里的一等消息类型**；并且**给流一个可续传的锚点**
（FateTell 的 `messageId + seq → from_seq` 是最值得抄的一点：断了能接着写，而不是重生成）。
另一个教训：**别相信声明里的前缀常量**，`/capi` 这种死常量会误导逆向结论。

## 4. 长文交付物：章节化 + 仪式感 + 可重放

| | FateTell FateBook | FateMaster 人生报告 |
|---|---|---|
| 结构 | **10 张卡 / "九章相连"**（`pages_card_title_0..9` + subtitle），每张卡一个隐喻名 + 功能名：Red Envelope \| Career & Resources、Love Lock \| Relationships、Wenchang Brush \| Learning、Safety Talisman \| Well-Being | **10 章**（能量循环路径/优势杠杆/易损点/运行手册/财富模式/亲密关系/滋养源/当前阶段 + 高配·低配两路 + 升级路线） |
| 免费/付费切分 | `/archive` 公开样例只完整开放 Day Master 一章，其余 9 章折叠；门控文案 "Only part of this chapter is shown" | 免费给**主判词/用神**预览 → 付费解锁全书；`wheel.paywallLabel` |
| 生成体验 | 卡片式阅读 + 阅读进度 | **仪式化进度**：立盘 → 换算干支历 → 甲子轮锁定 → 校验刑冲会合 → 检索六十神煞 → 推演大运 → 称身 → 深度模型执笔；每章"执笔/定稿"；**支持 replay** |
| 交付 | 网页 + iOS Pocket FateBook（平台绑定） | **约 5–10 分钟生成，完成后邮件送达** |

→ 可复用：长文生成不是"转圈等 5 分钟"，而是**把内部流水线显式暴露成进度语义**，并允许重放；交付走异步（邮件）而不是让用户守着页面。

## 5. 商业化：免费钩子 + 服务端权威额度 + 错误码契约

- **免费钩子**：两家都提供**无需注册**的确定性工具（FateTell 的 `/bazi-calculator`、FateMaster 的 14 宫格工具台），
  外加一个完整可读的**样例报告**（FateTell 的 `/archive` 甚至**不在 sitemap 里**，只在运行时被发现 → 暗漏斗入口）。
- **额度即 API 契约**（FateMaster，观测到实际错误码）：
  `ANON_CALC_LIMIT`、`BIRTH_PLACE_REQUIRED`、`INVALID_LUNAR_DATE`、`ANON_LIMIT_REACHED`、`DAILY_LIMIT_REACHED`、
  `AGENT_TRIAL_EXHAUSTED`(403)。→ 前端据此渲染文案，而不是靠字符串匹配。
- **权威性**：FateMaster 客户端用 `localStorage["<userId>_cachedAccessDetails"]` 只做首屏乐观渲染，
  生成接口独立返回额度错误 → 判定在服务端。FateTell 亦由 `/user/web-benefits` +
  `/user/web-benefits/usage/{productId}` 供额，门控 UI 在客户端。
- **支付**：FateMaster 走 Stripe（`/api/create-checkout-session` 带 `touchpoint` 与
  `sessionStorage.pre_checkout_page`，`paywall_view` 埋点）；FateTell 走 `/pay/create-payment` + `/pay/order-info`，
  另有**实体礼品卡兑换**（163 条 `redeem_*` 文案，一次性、绑定账号与平台）、KOL 码（52 条）、邀请（41 条）、
  双人合盘邀请。

## 6. 增长与埋点

| | FateTell | FateMaster |
|---|---|---|
| 埋点 | PostHog US（且隐私优先：`person_profiles:"never"`、`autocapture:false`、`respect_dnt:true`）+ GA4 + Cloudflare RUM | GA4 `G-C9KHBDVEFN` + Cloudflare Insights/RUM + **Sentry 经 `/monitoring` 同源隧道** |
| 广告 | **OpenAI Ads SDK `oaiq` v0.1.41**，`oppref/__obref` 归因从营销站透传到应用深链 | — |
| 归因 | 站内一致性 | `/api/attribution` 首触归因，**referrer 分类含 AI 助手**（chatgpt/claude/perplexity/poe 等）→ 把 GEO 当正式渠道度量 |
| SEO/GEO | 81 URL + Framer wiki + 博客子域，8 语言 | **4,115** 程序化长尾页（每神煞/格局/卦/黄历日一页）×5 语言；`robots.txt` 注释**明写 GEO 意图**：*"AI 爬虫：允许抓取内容页（GEO：让 AI 搜索/问答引擎能引用本站内容）… 曾经封禁 GPTBot/anthropic-ai 导致 ChatGPT/Claude 无法引用本站，已于 2026-07 放开"* |
| 一致性 | 同意后才 flush PostHog 队列（`fatetell_analytics_consent=granted`） | 锁价承诺（`yearlySubscription.pricePromise`）作为留存卖点 |

## 7. 工程质量信号（逆向我们真的看到了东西）

- FateMaster 有一个**真实缺陷**：`/history` 是独立 Next.js 多区子站，但发出根相对的 `_next` 资源路径，
  客户端导航时 `/_next//history/_next/static/chunks/…` → 308、`…js.undefined.js` → 404，并抛
  `Failed to fetch RSC payload … Cannot read properties of undefined (reading 'call')`；SSR 本身正常。
- FateTell 的 `/api/bazi/places` 有 **429 限流**与 400ms 防抖 + 80 条客户端缓存；Cloudflare Bot Management
  对非浏览器客户端有过滤（`curl` 取 `/archive` 超时，浏览器正常）。
- 两家都把内部 ID 编进客户端（Stripe `prod_T5sHCo32yIBnPM`、FateTell 5 个产品 UUID）→ 便于对账，也说明
  权限判定不应依赖这些 ID 的保密性。

## 8. 共同的 Unknown（公开面确实看不到）

| 未知 | 状态 |
|---|---|
| LLM 供应商/模型/版本 | 两家都**不可观测**：FateMaster 的 145 个 JS 里 `gpt-*`/`claude-*`/`gemini-*`/`deepseek`/`temperature` 等 **0 命中**；FateTell 仅命中 OpenAI **Ads** SDK 与 Markdown 库 |
| System prompt / 工具定义 | 服务端。FateMaster 已登录的 SSR 载荷泄露 **43 个工具名**，但**参数 JSON schema 仍未知**（试用额度在触发 `tool_call` 帧之前就耗尽了） |
| FateTell 聊天流式传输 | ✅ **已解决**（登录后实测）：SSE over fetch，见 §3；`/capi` 是死常量 |
| 用神/格局具体算法与报告 prompt | 服务端 |
| 免费额度精确数值 | **部分已知**：FateMaster agent 试用 `{limit:2}`（本次实测耗尽）；FateTell 占卜 `bagua 1/1`（当日已耗尽，页面直接不给 composer，只留购买入口）。两家的免费层都**极小** |

## 9. 一句话总结

**FateTell 是"品牌 + 礼品 + 多平台货架"路线**（实体卡、KOL、邀请、iOS/PWA 双货架、8 语言）；
**FateMaster 是"工具台 + 内容护城河 + 单 Agent"路线**（14 个工具、4115 页长尾、关系图谱等二阶交付物、明确的能力边界）。
两者在产品层完全不同，但在**AI 架构层几乎逐条一致**：确定性排盘内核、受限叙述层、按 surface 作用域的工具、
把 reasoning/tool/phase 放进流式协议、章节化长文交付、服务端权威额度 + 错误码契约、免费钩子 + 样例报告。
