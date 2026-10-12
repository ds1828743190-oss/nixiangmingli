# Logged-in REA pass — FateMaster agent + FateTell chat

**Date:** 2026-10-12 (Asia/Shanghai)
**Scope written:** `/Users/xiaolv/Documents/deepseek-harness/default-workspace/reverse/logged-in/`
**Mode:** REA **connect** mode against the user's own already-signed-in Chrome (`http://127.0.0.1:9333`). No browser was launched. No credentials, cookies or storage values were read, exported or written.
**Toolchain:** `rea@6.4.0` via `rea-agents/scripts/rea.mjs`, `REA_LOG_LEVEL=warn`.

Every numbered finding is tagged **Observed** (directly present in captured bytes / live page code), **Derived** (inferred from an observed artifact), or **Unknown**.

---

## 0. Targets and attestation

| # | Site | target_id | URL at capture | Attached? |
|---|---|---|---|---|
| 1 | FateMaster agent | `66D6AE5D9508E294D2C091F009FE792F` | `https://www.fatemaster.ai/workspace/agent` | page, Chrome/155.0.8059.40 |
| 2 | FateTell chat | `BDC353EDEFDF426FAA862252819D8D5F` | `https://web.fatetell.com/chat?chat=bg&conversationId=715759fa-479c-4db7-ab07-958df082d773` | page, Chrome/155.0.8059.40 |

Both targets were present at start and still present at the end; neither tab was closed. Inventory: [`raw/targets.json`](raw/targets.json) (`/normalized_result/targets/0`, `/targets/1`). End URL of FateTell after capture is unchanged — [`raw/fatetell-chat.json`](raw/fatetell-chat.json) `/normalized_result/steps/2/artifacts/url/value/url`.

### 0.1 Connect-mode input shape (Observed)

The CLI schema for `capture-browser-scenario` only exposes `inputJson` ([`raw/schema-capture-browser.json`](raw/schema-capture-browser.json)), so the connect shape was read from the installed implementation:

- `browser` is a discriminated union on `mode`: `{"mode":"launch", executable_path, headless}` or `{"mode":"connect", cdp_endpoint, target_id}`
  — `rea-agents/dist/domain/browserScenarioValues.js` @55–70.
- Actions available: `goto`, `click`, `fill`, `press`, `select_option`, `check/uncheck`, `wait_for` (locator `{kind: test_id|role|css}`), `wait_for_timeout` — @141–197.
- `capture.network` = `{request_body, response_body, header_values}` independently selectable — @240–256.
- **Connect mode still performs `page.goto(start_url)`** (`rea-agents/dist/browser/PlaywrightScenarioSession.js` @106) and applies CDP device-metrics/locale overrides to the user's real tab (`PlaywrightScenarioBrowser.js` @235–257). See LIMITATIONS.

Working scenarios: [`raw/scenario-fm-probe.json`](raw/scenario-fm-probe.json), [`raw/scenario-fm-agent.json`](raw/scenario-fm-agent.json), [`raw/scenario-ft-load.json`](raw/scenario-ft-load.json). Nothing was written to `rea-mcp-bundle/`, `rea/`, `~/.dsh/` or the other `reverse/*` scopes.

---

## 1. FateMaster (`www.fatemaster.ai`)

Capture: [`raw/fatemaster-agent.json`](raw/fatemaster-agent.json) (3.5 MB, 279 events, 122.7 s, all 7 steps `error: null`) — `/normalized_result/duration_ms`.

### F1. `POST /api/agent/chat` — request (Observed)

- Transaction `request-54`: `/normalized_result/events/items/255` (request), `.../256` (response, **200**), `.../266` (request-finished).
- Request headers: `/normalized_result/events/items/257/headers/items` (22 entries). Extracted: [`raw/fm-chat-request.json`](raw/fm-chat-request.json).
- Request body, base64-decoded, `bytes: 85`, `sha256 92bfc61a…` (recomputed and matching):

```json
{"conversationId":null,"message":"你好","timezone":"Asia/Shanghai","language":"zh"}
```

- Header set (names): `accept, accept-encoding, accept-language, baggage, content-length, content-type, cookie, origin, priority, referer, sec-ch-ua*, sentry-trace, user-agent`. `content-type: application/json`. **There is no `authorization` header**; the `cookie` header is present with `"redacted": true` — a same-origin **cookie session** (Better Auth). Masked form: `Cookie: <REDACTED>`.
- Response headers: `content-type: text/plain; charset=utf-8`, `content-encoding: br`, `cf-cache-status: DYNAMIC`, plus `x-experimental-stream-data` (Next.js streaming route) — `/normalized_result/events/items/256`, full list in [`raw/fm-chat-request.json`](raw/fm-chat-request.json) `response_headers`.

### F2. `/api/agent/chat` — response body is real NDJSON (Observed)

200 response body captured complete (`state: captured`, `representation: browser-decoded-response-bytes`, **1,145 B**, sha256 recomputed = captured). Raw stream: [`raw/fm-chat-stream.ndjson`](raw/fm-chat-stream.ndjson); parsed: [`raw/fm-chat-messages.json`](raw/fm-chat-messages.json).

**31 lines, all JSON, 0 unparsed. Type census: `{"conversation_id":1,"content":30}`.**

```ndjson
{"type":"conversation_id","conversationId":"5f9b5da3-5fd3-4208-82e1-1203a607888d"}
{"type":"content","content":"你好"}
{"type":"content","content":"！"}
... 29 more single-character content frames
```

Newline-delimited JSON, **not** SSE, **not** WebSocket — independently confirmed on the authenticated page by its reader code (F3).

### F3. Stream reader, in the live authenticated page chunk (Observed)

[`025-…_page-59c8c5f3dfcb87e7.js`](raw/fm-bundle/025-www.fatemaster.ai__next_static_chunks_app_5Blocale_5D_workspace_agent_page-59c8c5f3dfcb87e7.js_dpl_dpl_5bzs6bphFcVbvPfg9miX1XxST4YB) (30,574 B, the agent route chunk served to the signed-in page):

| Fact | Byte offset |
|---|---|
| `fetch("/api/agent/chat", {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({conversationId, message, timezone, language})})` | @15076 |
| `403 === e.status && "AGENT_TRIAL_EXHAUSTED" === t.code` branch | @15414 |
| `e.body?.getReader()` → `TextDecoder` → `split("\n")` → `JSON.parse` | @15560 |
| `"tool_result" === t.type && "number" == typeof t.index` → attaches `t.result` back to `toolCalls[t.index]` | @16047 |
| `"phase_change" === t.type` → sets `isReasoningPhase:!1` | @16248 |

Full envelope observed by that reader: `{"type":"conversation_id", conversationId}`, `{"type":"tool_call", toolCall:{name, arguments}}`, `{"type":"tool_result", index, result}`, `{"type":"reasoning", content}`, `{"type":"phase_change"}`, `{"type":"content", content}`, `{"type":"error", message}`. **`conversation_id`/`content` are Observed live; the other five types are Observed in code but were not exercised in my stream.**

### F4. **Real tool schema inventory — 43 tool names (Observed)**

The signed-in `/workspace/agent` document embeds the server-rendered i18n payload, which contains an `agent.toolCall` map of *real tool identifiers* → Chinese labels:

- Source: [`004-www.fatemaster.ai_workspace_agent`](raw/fm-bundle/004-www.fatemaster.ai_workspace_agent) (initial HTML, 181,361 B), map byte range **156657–158051**.
- Extracted: [`raw/fm-tool-names.json`](raw/fm-tool-names.json) (43 entries, each with its own byte offset; e.g. `get_today_info` @156669 … `import_self_profile_from_contact` @158003).

| # | tool | label | # | tool | label |
|---|---|---|---|---|---|
| 1 | `get_today_info` | 获取今日信息 | 23 | `get_palace_stars` | 宫位星曜查询 |
| 2 | `get_dayun_info` | 获取大运信息 | 24 | `get_sanfang_sizheng` | 三方四正分析 |
| 3 | `get_liunian_info` | 获取流年信息 | 25 | `get_xiaoxian` | 小限查询 |
| 4 | `get_liuyue_info` | 获取流月信息 | 26 | `get_sihua_for_tiangan` | 四化查询 |
| 5 | `get_shishen_analysis` | 十神分析 | 27 | `get_star_brightness` | 星曜亮度 |
| 6 | `get_shensha_info` | 神煞查询 | 28 | `get_boshi_stars` | 博士十二星 |
| 7 | `get_xingchong_huihe` | 刑冲会合分析 | 29 | `get_suiqian_jiangqian` | 岁前将前星 |
| 8 | `get_huangli_info` | 黄历查询 | 30 | `get_flying_sihua` | 飞星四化 |
| 9 | `get_huangli_for_date` | 黄历查询 | 31 | `get_daymaster_comparison` | 日主对比 |
| 10 | `convert_date` | 日期转换 | 32 | `get_pillar_interaction` | 四柱互动分析 |
| 11 | `get_ganzhi_calendar` | 查干支对照表 | 33 | `get_person_shishen` | 个人十神分析 |
| 12 | `get_weather` | 天气查询 | 34 | `get_person_shensha` | 个人神煞分析 |
| 13 | `lookup_user_records` | 查找命盘记录 | 35 | `get_person_dayun` | 个人大运分析 |
| 14 | `cast_liuyao` | 六爻起卦 | 36 | `get_person_xingchong` | 个人刑冲分析 |
| 15 | `cast_meihua` | 梅花起卦 | 37 | `get_cross_shishen` | 交叉十神分析 |
| 16 | `save_memory` | 记住信息 | 38 | `load_record` | 加载命盘记录 |
| 17 | `recall_memories` | 回忆信息 | 39 | `calculate_bazi` | 排八字盘 |
| 18 | `get_current_liunian_year` | 获取当前流年 | 40 | `reverse_bazi` | 反推阳历日期 |
| 19 | `get_today_date` | 获取今日信息 | 41 | `calculate_ziwei` | 排紫微盘 |
| 20 | `get_daxian_by_age` | 按年龄查大限 | 42 | `update_memory` | 更新记忆 |
| 21 | `get_year_fortune_detail` | 流年运势详情 | 43 | `import_self_profile_from_contact` | 导入本人命盘 |
| 22 | `get_daxian_palace_detail` | 大限宫位详情 | | | |

**Tool *names*: Observed (43). Tool *argument JSON Schemas*: Unknown — server-side only** (see §4). No `tool_call` frame was produced by my one message, so no `arguments` payload was ever seen. The `agent.*` i18n namespace contains only labels (`callingTools`, `toolsCalled`, `toolArguments`, `toolResult`) — no parameter definitions.

### F5. `GET /api/access` — entitlement snapshot, and what my message consumed (Observed)

Extracted: [`raw/fm-access.json`](raw/fm-access.json). Two 200 responses with matching sha256; JSON pointers at `/normalized_result/events/items/244` (request), `.../247` (response), `.../267`, `.../273`.

Field names used by the client: `hasSubscription`, `hasPurchase`, `subscription`, `purchase`, `customer`, `accessEndDate`, `accessType`, `remainingTime`, `agentTrial`.

Full bodies (no personal data):

```json
// request-52 — BEFORE my message  (raw/events/items/247)
{"hasSubscription":false,"hasPurchase":false,"subscription":null,"purchase":null,"customer":null,
 "accessEndDate":null,"accessType":null,"remainingTime":null,
 "agentTrial":{"limit":2,"used":1,"remaining":1,"hasRemaining":true}}
// request-57 — AFTER my message   (raw/events/items/273)
{"hasSubscription":false,"hasPurchase":false,"subscription":null,"purchase":null,"customer":null,
 "accessEndDate":null,"accessType":null,"remainingTime":null,
 "agentTrial":{"limit":2,"used":2,"remaining":0,"hasRemaining":false}}
```

**Important:** the account had exactly **one** agent-trial use left when I started (`used: 1`, `limit: 2`), and the single authorised `你好` message consumed it (`used: 2`, `remaining: 0`). That is why no tool call could be observed: a greeting does not invoke tools, and the agent trial is now exhausted. I did **not** send a second message (§6, LIMITATIONS).

### F6. Everything else captured for FateMaster (Observed)

[`raw/fm-bundle/`](raw/fm-bundle/) holds all 50 captured response bodies (2.27 MB, sha256-verified, `manifest.json`), including `GET /api/auth/get-session` (628 B) and `GET /api/agent/conversations` (352 B). Screenshot: [`raw/screenshots/fatemaster-agent.png`](raw/screenshots/fatemaster-agent.png) — shows the `你好` bubble and the reply.

---

## 2. FateTell (`web.fatetell.com`) — the chat transport

Capture: [`raw/fatetell-chat.json`](raw/fatetell-chat.json) (4.3 MB, 398 events, 34.0 s). Derived artifacts: [`raw/ft-api-transactions.json`](raw/ft-api-transactions.json), [`raw/ft-chat-transport.json`](raw/ft-chat-transport.json), [`raw/ft-entitlements.json`](raw/ft-entitlements.json), [`raw/ft-personal-data-shapes.json`](raw/ft-personal-data-shapes.json), bundles in [`raw/ft-bundle/`](raw/ft-bundle/).

### T1. **Transport = SSE over `fetch` + `ReadableStream` (`Accept: text/event-stream`). Not `EventSource`, not WebSocket.** (Observed)

The signed-in page loaded the chat client. From [`070-…3a225d0e0b9215db.js`](raw/ft-bundle/070-web.fatetell.com__next_static_chunks_3a225d0e0b9215db.js) (identical twin in `026-…eda5a6b7c1f3a5c4.js`):

```js
let g = o(`/api/v3/${t}/messages`);                 // @11123  → https://api.fatetell.com/api/v3/{channel}/messages
let y = (0,a.getToken)();
if (!y) throw e.onHttpError?.(401,"No authentication token available"), new i(401,"No authentication token available");
let a = await fetch(g, {
  method: "POST",                                    // @11123
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${y}`,                    // @11189
    Accept: "text/event-stream",                     // @11225
    "Accept-Language": (0,n.getAcceptLanguage)()
  },
  body: JSON.stringify(r), signal: c
});
let s = a.body?.getReader();                         // @11420
```

SSE frame parser (Observed, same file):

- split the decoded stream on `\n\n` (@10105); keep the trailing partial frame; for each complete frame take the **`` /^data:\s*(.+)$/m ``** line and `JSON.parse` it.
- event dispatch `switch(e.event)`: **`start`, `message`, `action`, `end`, `error`** (@9699); unknown types only `console.warn`.
- per-frame state: `messageId` (string), `seq` (number, tracked as `lastSeq`), `retryable` (boolean), `msg`.
- reconnect policy: `{maxRetries:5, baseDelay:1e3, maxDurationMs:12e4}` (@9303); retryable when HTTP 408 or ≥500; resume by `GET /api/v3/{channel}/messages/{messageId}/stream?from_seq={lastSeq}` (@13611).

**Channel table (Observed, [`026-…eda5a6b7c1f3a5c4.js`](raw/ft-bundle/026-web.fatetell.com__next_static_chunks_eda5a6b7c1f3a5c4.js) @12893):**

```js
{ bg:       {channel:"zhouyi-bagua", benefitsType:"bagua",    configType:"zhouyi_bagua", routeParam:"bg"},
  dasiming: {channel:"dasiming",     benefitsType:"dasiming", configType:"dasiming",     routeParam:"fb"} }
```

For the tab that was open (`chat=bg`) the endpoint is therefore
`POST https://api.fatetell.com/api/v3/zhouyi-bagua/messages`.

**Request body (Observed, `026-…` @26616):**

```js
f = { content: <user message, or "完成占卜" when completing a divination>,
      conversation_id: F.conversationId,
      archive_id: Y.current || d?.archive_id || "",
      request_id: p() }                                   // crypto.randomUUID()
// if completing a divination: f.number = t
```

Related bodies: the greeting call is `{archive_id, request_id}` (@25154); resume/reconnect sends body `{}`; `onStart` yields `{conversationId, messageId, lotTitle}`, `onDelta(content,{seq})`, `onAction` yields e.g. `{action:"start-pull"}`, `onEnd(content,{messageId, lotTitle})`.

### T2. **`/capi` is a dead constant — the live chat prefix is `/api/v3`** (Observed)

`chatUrlPrefix:"/capi"` is declared once in the env object ([`020-…a4f2c67ee5c9e128.js`](raw/ft-bundle/020-web.fatetell.com__next_static_chunks_a4f2c67ee5c9e128.js) @50944, next to `apiUrl:"https://api.fatetell.com"`, `apiUrlPrefix:"/fapi"`, `isRequestProxy:false`) and has **exactly one file referencing it across all 75 captured bundle bodies — that config file itself.** No call site. The authenticated chat client builds `/api/v3/{channel}/messages`. So: `/fapi` = REST user/product API, `/api/v3` = chat/REST-v3 API, `/capi` = unused legacy constant. (This closes the open question left by the unauthenticated pass.)

### T3. Both FateTell auth header forms, masked (Observed name/presence + Derived/observed scheme)

1. **Chat SSE** — hardcoded in the SSE client: `Authorization: Bearer <token>` (literal template @11189). Masked: `Authorization: Bearer <REDACTED>`.
2. **Generic REST (`/fapi`, `/api/v3`)** — the Axios interceptor: `t.headers.Authorization = e.authenticationScheme ? \`${e.authenticationScheme} ${r}\` : r` with `authenticationScheme:""` → a **raw token with no scheme** ([`020-…`](raw/ft-bundle/020-web.fatetell.com__next_static_chunks_a4f2c67ee5c9e128.js) @168257 + @169744). Masked: `Authorization: <REDACTED>`.

Both forms were **present on every authenticated request** — e.g. `authorization_present: true` for `request-43/44/45/46` and for `/user/user-info`, `/user/get-archive` ([`raw/ft-api-transactions.json`](raw/ft-api-transactions.json), [`raw/ft-personal-data-shapes.json`](raw/ft-personal-data-shapes.json)). REA itself redacted the values (`"redacted": true`) — **no token value was captured, read or written.** Observed header names on those calls: `accept, accept-language, authorization, from, referer, sec-ch-ua*, user-agent, x-ft-app-version: 0.0.0, x-ft-device-type: desktop, x-ft-os: macos, x-ft-platform: web`. Note the additional `From: chat` header, which was not in the earlier unauthenticated census.

### T4. Authenticated REST traffic observed on page load (Observed)

6 transactions to `api.fatetell.com`, all GET, all 200 ([`raw/ft-api-transactions.json`](raw/ft-api-transactions.json); JSON pointers `/normalized_result/events/items/{145,147,199,202,204,206}`):

| tx | endpoint | bytes |
|---|---|---|
| request-37 | `/fapi/user/user-info?_t=…` | 873 |
| request-38 | `/fapi/user/get-archive?_t=…` | 2177 |
| request-43 | `/api/v3/user/web-benefits?_t=…` | 244 |
| request-44 | `/api/v3/conversations?config_type=dasiming,zhouyi_bagua&platform=web&page_size=8` | 353 |
| request-45 | `/api/v3/conversations/715759fa-…` | 276 |
| request-46 | `/api/v3/conversations/715759fa-…/messages?page_size=50` | 5059 |

### T5. Entitlement JSON shape (Observed) — and why nothing was sent

[`raw/ft-entitlements.json`](raw/ft-entitlements.json) (full text, no personal data):

```json
{"code":0,"msg":"Success","data":{"subscription":null,
 "usage":{"dasiming":{"daily_used":0,"daily_limit":0,"permanent_remaining":0,"resets_at":"midnight"},
          "bagua":   {"daily_used":1,"daily_limit":1,"permanent_remaining":0,"resets_at":"midnight"}}}}
```

`bagua` is exhausted (1/1). The client send guard is exactly `Math.max(0, daily_limit-daily_used) + permanent_remaining > 0` ([`026-…`](raw/ft-bundle/026-web.fatetell.com__next_static_chunks_eda5a6b7c1f3a5c4.js) @21782) and the HTTP map is `401→logout, 403→refresh benefits + "chat.no_quota", 429→"chat.conversation_limit", 408/≥500→delivery_uncertain, else send_fail` (@22235). **Consequently the page renders no composer at all:** the end-state DOM contains **0 `<textarea>`, 0 `contenteditable`, 0 `<input>`, 0 `placeholder`** ([`raw/artifacts/fatetell-end-dom.html`](raw/artifacts/fatetell-end-dom.html)) and the a11y tree has **no textbox** — only `button "购买 FATETELL"` and `可用 0 次(今日剩余 0/1)` ([`raw/artifacts/fatetell-end-a11y.txt`](raw/artifacts/fatetell-end-a11y.txt)). Screenshot: [`raw/screenshots/fatetell-chat.png`](raw/screenshots/fatetell-chat.png). **The chat message was therefore skipped, not refused: there was no input to type into.**

### T6. Personal-data responses — field names only (Observed shapes)

Values were replaced with types in [`raw/ft-personal-data-shapes.json`](raw/ft-personal-data-shapes.json). Envelope is always `{code:number, msg:string, data:…}`.

- `/fapi/user/user-info` → `data`: `user_id, user_name, email, gender, birthday, birthtime, birthplace, location, avatar, interface_language, status, create_time, archive_id, true_solar_time, profile{id, bazi, pattern, sun_pillar, strength, likes[], dislikes[], general_info, wealth_info, emotional_info, update_status}, is_vip, is_big_member, is_month_vip, is_year_vip, has_ever_paid, has_ever_subscribed`.
- `/fapi/user/get-archive` → `data.archives[]`: `user_id, archive_id, user_name, gender, birthday, true_solar_time, use_true_solar_time, birthplace, type, is_lock, is_editable, fate_is_upgradable, yun_is_upgradable_dict, year_yun_list, lunar_{year,month,day,hour}, {year,month,day,hour}_ganzhi, profile_id, strength, likes, dislikes, update_status, geju, zhuxing, nayin, wuxing_score, wuxing_party_energy, lucky_direction, strong_wu_xing, weak_wu_xing, {year,month,day,time}_dizhi_canggan(+_wuxing), {year,month,day,time}_dishi, {year,month,day,time}_xunkong, day_character, stem_relationships, branch_relationships, dizhi_shishen`.
- `/api/v3/conversations` → `data`: `items[]{id, config_type, archive_id, title, message_count, created_at, updated_at}, next_cursor, has_more`.
- `/api/v3/conversations/{id}` → `data`: `{id, archive_id, title, message_count, created_at, updated_at}`.
- `/api/v3/conversations/{id}/messages` → `data`: `items[]{id, conversation_id, agent_key, role, content, status, created_at, rating}, next_cursor, has_more`.

---

## 3. Entitlement JSON shapes — summary

| Site | Endpoint | Observed shape | Still unknown |
|---|---|---|---|
| FateMaster | `GET /api/access` | `{hasSubscription, hasPurchase, subscription, purchase, customer, accessEndDate, accessType, remainingTime, agentTrial{limit, used, remaining, hasRemaining}}` | paid values for a subscribed account (`subscription`/`purchase`/`customer` were all `null`) |
| FateTell | `GET /api/v3/user/web-benefits` | `{code, msg, data{subscription, usage{<benefit>{daily_used, daily_limit, permanent_remaining, resets_at}}}}` | the shape with a non-null `subscription`; values for `dasiming` on a fresh day |
| FateTell | `GET /fapi/user/user-info` | `is_vip, is_big_member, is_month_vip, is_year_vip, has_ever_paid, has_ever_subscribed` | — (shapes observed, values masked) |

## 4. What remains server-side only

1. **FateMaster tool argument JSON Schemas** — not in any client bundle; the `agent.toolCall` map carries labels only. Would require a stream containing a real `tool_call` frame, which needs remaining agent trial.
2. **FateMaster system prompt / model / provider / tool-selection policy** — no prompt text in the payload or chunks.
3. **FateMaster server rate-limit numbers** — only codes (`AGENT_TRIAL_EXHAUSTED`) and the `agentTrial` counters are visible.
4. **FateTell SSE frame *bodies*** — the envelope (`event/seq/messageId/retryable/msg`) is Observed in the parser, but no live frame was captured; the per-event `data` payload of `start`/`message`/`action`/`end` is **Unknown**.
5. **FateTell server-side quota enforcement** — client gate Observed; the 403 path is Observed in code but not exercised.

## 5. Files

| Path | Contents |
|---|---|
| `raw/schema-capture-browser.json`, `raw/help-capture-browser.txt` | CLI schema/help |
| `raw/targets.json` | target inventory |
| `raw/scenario-fm-probe.json`, `raw/scenario-fm-agent.json`, `raw/scenario-ft-load.json` | connect-mode scenarios |
| `raw/fatemaster-agent.json` | full FateMaster capture (Evidence envelope) |
| `raw/fm-chat-request.json`, `raw/fm-chat-stream.ndjson`, `raw/fm-chat-messages.json` | `/api/agent/chat` request + decoded NDJSON + census |
| `raw/fm-access.json` | `/api/access` snapshots (before/after) |
| `raw/fm-tool-names.json` | **43 real tool names + labels + byte offsets** |
| `raw/fm-bundle/` (50 files + `manifest.json`) | every captured response body, sha256-verified |
| `raw/fatetell-chat.json` | full FateTell capture (Evidence envelope) |
| `raw/ft-api-transactions.json` | 6 authenticated API transactions, headers masked |
| `raw/ft-chat-transport.json` | **transport facts with file + byte offsets** |
| `raw/ft-entitlements.json` | web-benefits response |
| `raw/ft-personal-data-shapes.json` | personal-data responses, shapes only |
| `raw/ft-bundle/` (75 files + `manifest.json`) | every captured response body |
| `raw/artifacts/` | FateTell end-state outer DOM (`fatetell-end-dom.html`) + a11y tree text (`fatetell-end-a11y.txt`) |
| `raw/fm-ax.json`, `raw/ft-ax.json` | passive accessibility-text reads used to derive selectors (FateMaster / FateTell) |
| `raw/screenshots/` | `fatemaster-agent.png`, `fatetell-chat.png` |
| `raw/extract-fm.mjs`, `raw/extract-fm-tools.mjs`, `raw/extract-ft.mjs`, `raw/dump-bodies.mjs` | extraction scripts (all offline; no network) |
| `raw/fm-dom-passive.json`, `raw/fm-ax.json`, `raw/ft-ax.json` | passive pre-run page reads |
| `raw/fm-probe.json` | no-mutation selector probe |

---

## 6. LIMITATIONS — what I could not capture, and every action skipped

**Not captured / Unknown**

1. **No live `tool_call`, `tool_result`, `reasoning` or `phase_change` frame.** `你好` is a greeting; the answer was greeting text only. The account had `agentTrial {limit:2, used:1}` at start, and my single message took `used` to 2 — **the trial is now exhausted** (`remaining:0`). I sent no second message (see skips).
2. **No live FateTell chat stream at all** — no `/capi` request and no `/api/v3/zhouyi-bagua/messages` request was ever issued, because the page had no composer (quota 0/1).
3. **Tool argument schemas** remain Unknown (server-side).
4. **Storage/cookies were never read.** `capture.at_end` never contained `"storage"`, `capture.after_each_step` was empty, and scenario `storage` was empty arrays in all three scenarios. Storage **key names** were not collected either. `cookie` and `authorization` header values arrived pre-redacted (`"redacted": true`) and were additionally replaced with `null` by my extractors — **no session token, cookie value or credential exists in any file I wrote.**
5. **Connect-mode side effects on the user's real tabs (Observed, unavoidable in this mode):** each scenario executed `page.goto` on the identical current URL, i.e. **the two tabs were reloaded** (FateMaster `/workspace/agent`, FateTell the exact `chat=bg&conversationId=…` URL). The FateMaster reload replaced the previously visible conversation with a fresh thread. CDP device-metrics/locale overrides (`1440x900`, `zh-CN`, `Asia/Shanghai`) were applied for the duration of each scenario and expire on disconnect. The external Chrome was only disconnected, never closed.
6. **Screenshots contain the account email** (`1828743190@qq.com`, both sites) and the FateTell tab shows the user's own fortune text; a screenshot cannot be field-masked. No other account data was added by me.
7. FateTell `/fapi/user/user-info` response bodies exist unredacted in the raw capture `raw/fatetell-chat.json` (that is the immutable Evidence); the derived artifacts give shapes only.

**Skipped for safety / capability (nothing else was touched)**

| # | Action | Why skipped |
|---|---|---|
| S1 | **2nd FateMaster chat message** (would have been allowed: "at most 2") | `agentTrial.remaining` was 0 after the first message. Sending would attempt service beyond the entitlement and would consume nothing but quota that no longer exists. **Reported, not attempted.** |
| S2 | **Any FateTell chat message** | No composer exists (quota gate `bagua 1/1`); verified in DOM, a11y and screenshot. Nothing to type into; not a refusal by me. |
| S3 | Any purchase / "解锁全部功能" / "购买 FATETELL" / Stripe Checkout | Forbidden by the task; never clicked. |
| S4 | Account settings, profile/birth-data forms, "个人资料", archive create/update/delete | Forbidden; never clicked. The only composer I filled was the FateMaster chat box, with the neutral text `你好`. |
| S5 | Any delete | Forbidden; never invoked. |
| S6 | Opening new tabs / navigating to other routes (e.g. `/fate`, `/archive`, `/pricing`) | Forbidden; only the identical `start_url` reload of the two open pages occurred. |
| S7 | Storage/cookie capture options | Forbidden; never selected. |
| S8 | Exhausting rate limits / probing 429 | Never attempted. All 6 FateTell API calls were GETs issued by the page itself. |

**Account-mutating side effect actually incurred:** exactly one FateMaster agent message (`你好`) was sent, as authorised, consuming the account's last agent-trial use. No FateTell write of any kind occurred.

**Tool errors, verbatim**

1. `rea list-browser-targets --cdp-endpoint http://127.0.0.1:9333` →
   ```json
   { "code": "UNKNOWN", "message": "Unknown flag: --cdp-endpoint" }
   ```
   Cause: the arg is positional (`rea list-browser-targets <endpoint>`); corrected immediately.
2. `timeout 120 "$NODE" "$REA" …` exited **127** with `timeout: command not found` — macOS has no GNU `timeout`. This was my shell wrapper, not REA; the command was re-run without it (exit 0). No REA operation failed after that.

**Working-side notes:** the REA `capture-browser-scenario` and `inspect-web-page` commands used here returned `normalized_result.completeness.status = "incomplete"` with `missing_sections: ["events"]` on every run; this did not prevent the network bodies/headers and end-state artifacts from being captured, and the Evidence was self-verifying (all recomputed sha256 values matched the captured digests).
