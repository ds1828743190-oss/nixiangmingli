# FateMaster.ai — evidence-backed teardown

Target: `https://www.fatemaster.ai` (bare `fatemaster.ai` 302s to `www`).
Method: REA 6.4.0 `capture-browser-scenario` (Playwright, headless Chromium 155.0.8059.40), static
analysis of captured response bytes, and the site's own publicly advertised `robots.txt` / sitemaps.
Public, unauthenticated pages only. No login, no payment, no captcha solving, no credential use.

All captures were taken **2026-10-12** (site server date header: `Mon, 12 Oct 2026 10:16:13 GMT`).

Evidence labels used below:

- **OBSERVED** — raw bytes / JSON / headers show it.
- **DERIVED** — static inference from captured code (not executed).
- **UNKNOWN** — server-side only, or requires login/payment, or otherwise not publicly observable.

---

## 0. How to read the evidence paths

| Path | What it is |
|---|---|
| `raw/home-partial.json` | Full scenario capture for `/` (366 events, 72 transactions). Source of `raw/home/*`. |
| `raw/home/summary.md` | Human-readable roll-up: steps, limitations, network table, console errors. |
| `raw/home/network.json` | One row per transaction: method, status, resource type, media type, local body file, URL. |
| `raw/home/bodies/NNN-request-M.<ext>` | Raw browser-decoded response bytes, named by capture ordinal. |
| `raw/home/artifact-step3-*.{json,png}` | Final DOM (173,784 B), accessibility tree, URL, history, storage, screenshot. |
| `raw/{pricing,workspace2,agent2,bazi}/` | Same layout for `/pricing`, `/workspace`, `/workspace/agent`, `/workspace/bazi-calculate`. |
| `raw/app/` | All 145 captured `.js` bodies re-keyed by their real URL path (`_next/static/chunks/...`). |
| `raw/messages-zh-<page>.json` | next-intl message catalogues lifted from the RSC flight payload in each page's SSR HTML. |
| `raw/html/<page>.html` | Raw SSR HTML (fetched once per route, `Accept-Language: zh-CN`). |
| `raw/sitemap*.xml` | Site's own sitemap index + 12 child sitemaps (4,115 URLs). |
| `raw/app-graph-partial.json` | REA `analyze-javascript-application` partial Evidence (19 MB; low coverage — see Limitations). |

Capture inventory: 5 browser scenarios, ~30 direct HTTP document/sitemap fetches, 383 captured
network transactions in total, 6 screenshots.

---

## 1. Tech stack

| Layer | Finding | Evidence |
|---|---|---|
| Framework | **Next.js App Router** (RSC/flight, server components) | **OBSERVED** `raw/home/summary.md:54-71` — `_next/static/chunks/app/%5Blocale%5D/{layout,page,not-found,global-error}-*.js`, `main-app-*.js`, `webpack-*.js`; `Vary: RSC, Next-Router-State-Tree, Next-Router-Prefetch` in `raw/home/network.json` doc headers. `?…&_rsc=hg3d2` prefetches (**OBSERVED**, `raw/home/summary.md:72-113`). |
| Hosting | **Vercel** behind **Cloudflare** | **OBSERVED** `x-vercel-id: hkg1::iad1::k9z6n-…`, `x-vercel-cache: MISS`, `x-matched-path: /[locale]`, `server: cloudflare`, `cf-ray: a4955907a88b1ebf-HKG`, `cf-cache-status: DYNAMIC`, `alt-svc: h3`, `content-encoding: zstd` — all in the `request-1` response header set (`raw/home-partial.json` → `capture.events.items[kind=network-content, transaction_id="request-1", phase="response", headers]`). |
| Deploy identity | Vercel deployment id in every asset URL: `?dpl=dpl_5bzs6bphFcVbvPfg9miX1XxST4YB`, plus an `x-deployment-id` request header on 145 requests | **OBSERVED** `raw/home/summary.md:54-71`; **OBSERVED** header-name census in `raw/*/partial.json` → `capture.events.items[kind=request].header_names` |
| Build tooling | Webpack (Next.js bundled), CommonJS-ish factory chunk format | **OBSERVED** `webpack-5f95e28ec511e58b.js` in `raw/app/home/_next/static/chunks/`; module factories `12345:(e,a,t)=>` visible throughout. |
| i18n | **next-intl**, 5 locales: `zh` (default, unprefixed), `en`, `zh-Hant`, `ja`, `ko`; locale codes `en-US/zh-CN/zh-TW/ja-JP/ko-KR` | **OBSERVED** `raw/home-partial.json` → `artifact-step3-dom.json` `<link rel="alternate" hreflang>` set; and `raw/agent2/bodies/031-request-32.js` module 35713: `["zh","en","zh-Hant","ja","ko"]` plus the `{code,lang,language}` language-picker array. Full message catalogues: `raw/messages-zh-*.json`. |
| Auth | **Better Auth** (client SDK) with cookie sessions + Google social login | **OBSERVED** `GET /api/auth/get-session` returns literal `null` when anonymous (`raw/home/bodies/029-request-30.json`); `"/api/auth"` default basePath and `authClient` export in `raw/agent2/bodies/031-request-32.js` (module 34285: `authClient, signIn, signInWithGoogle, signInWithGoogleIdToken, signOut, signUp, useSession`); Better-Auth internals `better-auth:broadcast-channel`, `better-auth:focus-manager` in `raw/agent2/bodies/011-request-12.js` @ offset 7685; `/api/auth/google-redirect?callbackURL=` string in `raw/*/bodies/*.js`. |
| Analytics | **Google Analytics 4** `G-C9KHBDVEFN` via `googletagmanager.com/gtag/js` | **OBSERVED** `POST https://www.google-analytics.com/g/collect?v=2&tid=G-C9KHBDVEFN…` and `GET https://www.googletagmanager.com/gtag/js?id=G-C9KHBDVEFN` — `raw/home/summary.md:112-113`. |
| Analytics | **Cloudflare Insights** + Cloudflare RUM/NEL | **OBSERVED** `https://static.cloudflareinsights.com/beacon.min.js/v4bc70e2c…` (same table, line 43); `POST https://www.fatemaster.ai/cdn-cgi/rum?` → 204; `report-to: {"group":"cf-nel",…a.nel.cloudflare.com…}` header. |
| Error monitoring | **Sentry**, tunnelled through the app origin at `/monitoring`, with W3C trace propagation | **OBSERVED** 3 × `POST https://www.fatemaster.ai/monitoring?o=4508962625028096&p=4508962626732032&r=us` → `200 {}` (`raw/home/bodies/024-request-25.json`); **OBSERVED** `sentry-trace` and `baggage` request header names on 161 of 383 captured requests (`raw/*/partial.json` → `capture.events.items[kind=request].header_names`); **DERIVED** `o`/`p`/`r` are Sentry org / project / region, and the SDK string `[Sentry.init()]` + envelope URL builder `${…}/api/${projectId}/envelope/?sentry_version=7` appears in `raw/*/bodies/*.js`. |
| First-party attribution | `scripts/deferred-global-effects.js` classifies referrers and POSTs to `/api/attribution` | **OBSERVED** `raw/home/bodies/019-request-20.js` lines 2 and 198 (comment: *"归因字段名必须与 app/api/attribution/route.ts 的 Zod schema 保持同步"*), loaded as `https://www.fatemaster.ai/scripts/deferred-global-effects.js`. |
| Other libs | `date-fns` (**OBSERVED**, `raw/*/bodies/*.js`), `cookies-next` (**OBSERVED**, `raw/agent2/bodies/028-request-29.js`), Radix UI primitives + `sonner` toasts + `cmdk` + `next-themes` (**DERIVED** from `t.d(a,{Z:()=>…})` primitive bundles), framer-motion-class animation (**DERIVED**) | |
| Company | **POMODIARY LLC** | **OBSERVED** `raw/head-meta.txt` → `<meta name="author" content="POMODIARY LLC">`, `creator`, `publisher`. Contact `hi@fatemaster.ai`, X `@Fatemaster73685`/`@Fatemaster38208`. |
| Mobile/webview | Client ships an **Android WebView shim** (`window.android.unLoad`) | **OBSERVED** `raw/home/bodies/019-request-20.js` → `ensureAndroidBridge()`; **DERIVED** implies an Android WebView host app exists. |

No model/provider name, API key, or inference SDK appears anywhere in client bytes
(**OBSERVED**: zero matches for `gpt-4`, `gpt-5`, `claude-`, `sonnet`, `opus`, `gemini-`, `deepseek`,
`qwen`, `kimi`, `glm-4`, `doubao`, `openrouter`, `siliconflow`, `dashscope`, `groq`,
`temperature`, `max_tokens`, `model:` across all 145 captured JS bodies).

---

## 2. Routes / pages and the product flow

### 2.1 Route surface (OBSERVED)

From `robots.txt` (which explicitly advertises the sitemap) + 13 sitemaps:

```
raw/sitemap.xml                 index → 12 child sitemaps + /history/sitemap.xml (separate sub-site)
raw/sitemap-main.xml      170
raw/sitemap-zodiac.xml     60      /workspace/chinese-zodiac-compatibility/<animal>
raw/sitemap-blog.xml      145      /blog/…   (e.g. blog/china-daylight-saving-time)
raw/sitemap-guides.xml    240
raw/sitemap-mingli-cases   25      /mingli-cases
raw/sitemap-geju.xml      120      /guides/geju/<pattern>
raw/sitemap-huangli.xml  1210      /workspace/huangli/…
raw/sitemap-shensha.xml   285      /guides/shensha/<star>
raw/sitemap-qimen.xml     675      /guides/qimen-dunjia/…
raw/sitemap-ziwei.xml     470      /guides/ziwei-…, /workspace/ziwei-…/…
raw/sitemap-tarot.xml     395      /tarot-cards, /workspace/tarot/…
raw/sitemap-64-hexagrams  320      /guides/64-hexagrams/<1..64>
                          ----
TOTAL                     4115
```

Every content route is duplicated across the 5 locales (×5 in `sitemap-main.xml`).
This is an SEO/GEO content moat: ~4,100 mostly-static guide pages, one per 神煞 / 格局 / 卦 / 星曜 /
黄历 day / zodiac pairing.

**Application routes** (`raw/messages-zh-*.json` + `raw/home/accessibility.txt` footer + `raw/workspace2/network.json`):

```
/                         landing
/pricing                  plans
/about  /privacy  /terms  /reset-password  /account  /login
/workspace                dashboard (prefetches the whole tool catalogue on hover)
/workspace/bazi-calculate 排盘 (form: name, gender, solar/lunar date, time, birthplace)
/workspace/bazi-daily     daily 日签
/workspace/bazi-marriage | bazi-lover | bazi-business | bazi-parent-child |
  bazi-mother-child | bazi-mother-in-law | bazi-best-friends | bazi-friends |
  bazi-leader | relationship | relationship-network | chinese-zodiac-compatibility/<animal>
/workspace/ziwei-doushu   /workspace/ziwei-marriage
/workspace/liuyao  /workspace/qimen  /workspace/meihua/daily-decision  /workspace/tarot
/workspace/huangli  /workspace/28-mansions  /workspace/life-kline
/workspace/life-report    八字人生报告  (the flagship paid AI deliverable)
/workspace/agent          命理 AI Agent (the conversational agent)
/workspace/history  /workspace/records     (history / records)
/history                  served by a SEPARATE Next.js zone (see §7)
/guides/** /mingli-cases /blog/** /tarot-cards
```

### 2.2 User-facing flow (OBSERVED from DOM + copy + copy strings)

1. **Landing** (`/`) → hero "AI 驱动的东方智慧解析系统", a 14-tile tool grid
   (`raw/home/accessibility.txt`): 八字排盘, 梅花易数, 六爻, 奇门遁甲, 塔罗, 紫微斗数, 紫微合婚,
   **命理 AI Agent**, 老黄历. Jung quote as brand positioning. "无需注册，免费体验" (no signup required).
   **OBSERVED** `raw/home/accessibility.txt` and `raw/home/artifact-step3-dom.json`.
2. **排盘 (chart arrangement)** — `/workspace/bazi-calculate`: "基本信息 → 时间信息 → 出生地点 →
   开始计算八字". Tabs: `日期 | 八字` input modes; `阳历 | 农历`; a "我知道出生时间" switch; a birthplace
   autocomplete; toggles for 真太阳时 / 早晚子时 / 夏令时. **OBSERVED** `raw/bazi/accessibility.txt`.
3. **Free rule-engine chart → free AI preview → paid deep report.** Copy states the split explicitly:
   landing FAQ — *"排盘由确定性规则引擎完成…AI 不参与排盘，只负责把排好的结构讲清楚"*
   (**OBSERVED** `raw/home/accessibility.txt`).
4. **`/workspace/life-report`** — "免费推演主判词" (free main-verdict preview) → paywall
   (`wheel.paywallLabel = "执笔者已定夺 · 以下为你的完整命书目录"`) → 10-chapter AI-written book,
   "约需 5–10 分钟", emailed on completion. **OBSERVED** `raw/messages-zh-life-report.json` → `lifeReport.*`.
5. **`/workspace/agent`** — free-text conversation; the agent picks a 术数, calls chart tools, streams
   reasoning then content, keeps memory. **OBSERVED** `raw/messages-zh-agent.json`, `raw/agent2/*`.
6. **Retention**: daily 日签, 命盘 records library, relationship graph (per-contact AI scores with
   monthly refresh), conversation history, AI memory management, report feedback. **OBSERVED**
   `raw/messages-zh-workspace.json` / `raw/messages-zh-life-report.json`.

---

## 3. Backend API surface

All endpoints below are **OBSERVED** in client bytes as `fetch(<literal>)` call sites, or **OBSERVED**
as actual captured transactions fired by the page during a normal visit. `robots.txt` disallows `/api/`
for crawlers, so **no endpoint was probed directly**; every fact here comes from page-initiated traffic
or static code.

| Endpoint | Method | Purpose | Evidence |
|---|---|---|---|
| `/api/bazi-calculate` | POST | 排盘 (chart arrangement) | **OBSERVED** call site `raw/bazi/bodies/038-request-39.js` @ offset 22497 |
| `/api/bazi-reverse` | POST | Reverse-solve solar dates from a given 八字/六字 | **OBSERVED** literal in `raw/*/bodies/*.js` |
| `/api/analyze` | POST (streams) | AI chart interpretation | **OBSERVED** call site `raw/bazi/bodies/037-request-38.js` @ offset 53420 |
| `/api/analysis/<id>/delete` | DELETE | Delete an AI analysis record | **OBSERVED** `raw/bazi/bodies/037-request-38.js` |
| `/api/analyses/`, `/api/questions/` | — | Analysis + Q&A history | **OBSERVED** literals in `raw/*/bodies/*.js` |
| `/api/records`, `/api/records/<id>`, `/api/records/question?id=` | GET/DELETE | 命盘 record library | **OBSERVED** literals |
| `/api/history?type=bazi&language=` | GET | History feed | **OBSERVED** literal |
| `/api/places/autocomplete?input=`, `/api/places/details?placeId=` | GET | Birthplace geocoding (proxies Google Places — `https://www.google.com/ccm/geo` also present) | **OBSERVED** literals |
| `/api/agent/chat` | POST | Agent conversation (streams) | **OBSERVED** call site `raw/agent2/bodies/022-request-23.js` @ offset 15075 |
| `/api/agent/conversations` | GET | List conversations | **OBSERVED** `raw/agent2/bodies/022-request-23.js` @ offset 13897 |
| `/api/agent/conversations/<id>` | GET / DELETE | Load / delete a conversation | **OBSERVED** same file @ offsets 14175, 14573 |
| `/api/access` | GET | Entitlement snapshot | **OBSERVED** `raw/agent2/bodies/031-request-32.js` @ offset 30640 |
| `/api/prices?locale=<locale>` | GET | Price catalogue (Stripe objects) | **OBSERVED** live transaction `raw/pricing/bodies/032-request-33.json` |
| `/api/create-checkout-session` | POST | Stripe Checkout session | **OBSERVED** call sites `raw/pricing/bodies/010-request-11.js` @ 2157 and `raw/agent2/bodies/020-request-21.js` @ 2775 |
| `/api/attribution` | POST | First-touch attribution upsert | **OBSERVED** `raw/home/bodies/019-request-20.js` @ 6627 |
| `/api/auth/*` (Better Auth: `get-session`, `google-redirect`, sign-in/up/out) | GET/POST | Auth | **OBSERVED** live `GET /api/auth/get-session → 200 null` ×2 per page; literals |
| `/monitoring?o=…&p=…&r=us` | POST | Sentry envelope tunnel | **OBSERVED** live transactions |

### 3.1 Request/response shapes (OBSERVED)

`POST /api/bazi-calculate` — JSON body built in `raw/bazi/bodies/038-request-39.js` @ 22497:

```
{ ...birthDate as ISO string incl. seconds..., language, fromBazi: "date"|"bazi",
  useTrueSolarTime, useEarlyLateZiHour, dstAdjusted }
→ 200 { id, timeAdjustment, daylightSavingAdjustment, timeZone, ...four pillars... }
→ error { code: "ANON_CALC_LIMIT" | "BIRTH_PLACE_REQUIRED" | "BIRTH_TIME_REQUIRED"
                | "CALCULATION_FAILED" | "INCOMPLETE_INFORMATION" | "INVALID_LUNAR_DATE"
                | "INVALID_RELATIONSHIP_TYPE" | "INTERNAL_SERVER_ERROR" }
```

The error-code enum is a literal object in `raw/bazi/bodies/038-request-39.js` @ offset 39845.

`POST /api/analyze` — JSON body **OBSERVED** at the call site:

```
{ yearPillar, monthPillar, dayPillar, timePillar, gender,
  birthDate, analysisStyle: "moderate", baziId, language }
→ streams NDJSON; errors "ANON_LIMIT_REACHED", "DAILY_LIMIT_REACHED" (HTTP non-OK, JSON body)
```

`POST /api/agent/chat` — JSON body **OBSERVED** at offset 15075:

```
{ conversationId, message,
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, language }
Headers: Content-Type: application/json (+ Better-Auth session cookie, same-origin default credentials)
→ 401 unauthenticated · 403 { code: "AGENT_TRIAL_EXHAUSTED" } · 200 stream
```

`GET /api/prices?locale=zh` — **OBSERVED** full body (`raw/pricing/bodies/032-request-33.json`, 3,074 B):
a JSON array of raw **Stripe Price** objects (`id`, `productId`, `unitAmount`, `currency`, `type`,
`interval`, `intervalCount`, `trialPeriodDays`, `metadata`, `createdAt`, `updatedAt`, embedded `product`).

`GET /api/access` — **OBSERVED** field names used by the client: `hasSubscription`, `hasPurchase`,
`accessType`, `accessEndDate`, `remainingTime`, `agentTrial` (`{hasRemaining}`)
(`raw/agent2/bodies/031-request-32.js` @ 30640–31500).

### 3.2 Auth mechanism

- **Cookie session, not bearer. OBSERVED.** The auth client is Better Auth on same-origin
  `/api/auth`; attribution sync calls `fetch('/api/auth/get-session', { credentials: 'include' })`
  (`raw/home/bodies/019-request-20.js`); `GET /api/auth/get-session` returns `null` unauthenticated.
  A census of every request header name across all 383 captured requests yields exactly
  `accept-language, sec-ch-ua*, upgrade-insecure-requests, user-agent, referer, origin, content-type,
  baggage, sentry-trace, next-router-prefetch, next-router-state-tree, next-url, rsc, x-deployment-id`
  — **no `authorization` header appears at all**
  (`raw/*/partial.json` → `capture.events.items[kind=request].header_names`). Cookies are not exposed
  as header names by Playwright, so cookie transport is established by the Better Auth client,
  the `credentials:'include'` call, and the absence of any bearer token. Google OAuth via
  `/api/auth/google-redirect?callbackURL=`.
- **Client-side entitlement cache. OBSERVED (DERIVED for the trust boundary).** `localStorage`
  `lastLoggedInUserId` + `<userId>_cachedAccessDetails` are read synchronously to render access state
  before the network answers (`raw/agent2/bodies/031-request-32.js`). The cache is a UX optimisation;
  the *generation* endpoints are server-rendered and return `ANON_*`/`DAILY_LIMIT_REACHED`/
  `AGENT_TRIAL_EXHAUSTED`, so enforcement must be server-side (**DERIVED**). Whether any paid feature is
  gated *purely* client-side is **UNKNOWN** without an entitlement.

### 3.3 Streaming mechanism

**Fetch stream + newline-delimited JSON (NDJSON). Not SSE, not WebSocket. OBSERVED.**

- `/api/analyze` — `resp.body.getReader()` → `TextDecoder.decode(v,{stream:true})` → accumulate →
  `split("\n")` → `JSON.parse(line)`. Message shapes: `{type:"keep-alive"}`, `{type:"error", message}`,
  `{type:"reasoning", content}`, `{type:"content", content}`, plus a `isComplete` boolean.
  Guard: 30 s inactivity timeout (5 s poll) → abort; retry up to 3× with 2 s backoff.
  (`raw/bazi/bodies/037-request-38.js` @ ~53500–55000.)
- `/api/agent/chat` — same NDJSON reader. Additional message types: `{type:"conversation_id",
  conversationId}`, `{type:"tool_call", toolCall:{name, arguments}}`,
  `{type:"tool_result", index, result}`, `{type:"phase_change"}`.
  Client model: `reasoning` accumulates into a *thinking* pane; `phase_change` flips
  `isReasoningPhase` to false; `content` then renders into the answer bubble; tool calls render as
  "分析中，已调用 {count} 个工具…" and `tool_result` attaches back by `index`.
  (`raw/agent2/bodies/022-request-23.js` @ ~15200–16400.)
- Zero `new WebSocket(` and zero real `EventSource` usage in any captured body — the 4 `EventSource`
  hits are a string inside a Sentry/Next.js library enumeration list. **OBSERVED**
  (`grep -c 'new WebSocket'` = 0; `EventSource` hits at `raw/*/bodies/005-request-6.js` offset 410815).

### 3.4 Rate limiting (OBSERVED as error contracts + UI copy)

| Signal | Where | Evidence |
|---|---|---|
| `ANON_CALC_LIMIT` on 排盘 | `/api/bazi-calculate` | `raw/bazi/bodies/038-request-39.js` @ 22529, error enum @ 39845 |
| `ANON_LIMIT_REACHED` on AI analysis | `/api/analyze` | `raw/bazi/bodies/037-request-38.js` @ 53628 |
| `DAILY_LIMIT_REACHED` on AI analysis | `/api/analyze` | same offset; string "当前访问人数过多，请稍候重试" = `baziResult.aiAnalysis.analysisRequestFailed` |
| `AGENT_TRIAL_EXHAUSTED` (HTTP 403) | `/api/agent/chat` | `raw/agent2/bodies/022-request-23.js` @ 15294 |
| Client-side throttle for bulk AI scoring, with a retry-after-seconds banner | relationship graph bulk refresh | `raw/messages-zh-workspace.json` → `workspace.relationshipNetwork.bulkScore.rateLimited = "触发限流，{seconds} 秒后自动继续 · {done}/{total}"` |
| Daily free preview / regenerate caps | life report | `raw/messages-zh-life-report.json` → `lifeReport.previewLimit`, `lifeReport.regenLimit` |

Numeric limits (how many anonymous calls, how long the agent trial) are **UNKNOWN** — the server never
returns them publicly and I did not attempt to exhaust them (that would be abusive).

No `Retry-After` header, no `429` status, and no `X-RateLimit-*` header appeared in any of the 383
captured transactions. **OBSERVED** (`raw/*/network.json`).

---

## 4. The AI layer (publicly observable)

### 4.1 Provider / model — UNKNOWN

Nothing in client bytes names a model or vendor (§1). Prompts are server-side. No `/api/*` response body
other than `/api/prices`, `/api/auth/get-session` and the Sentry tunnel was retrievable without
authenticating, so **model identity, prompt text, temperature and system instructions are not publicly
observable**. What the product *says* about the model: **OBSERVED** `raw/messages-zh-life-report.json`:
`lifeReport.meta.description = "两路模型判定用神，深度推理模型逐章执笔"` → "a two-path model decides the
useful god (用神); a deep reasoning model writes it chapter by chapter". And
`lifeReport.generateHint = "正文由深度模型逐章执笔，约需 5–10 分钟"`.

### 4.2 Tool / function inventory — OBSERVED (full list, from the shipped i18n catalogue)

The agent's entire tool surface is enumerated in `raw/messages-zh-agent.json` →
`agent.toolCall.*` (~45 names). Grouped:

- **八字 (BaZi)**: `calculate_bazi`, `reverse_bazi`, `get_today_info`, `get_today_date`,
  `get_dayun_info`, `get_liunian_info`, `get_liuyue_info`, `get_current_liunian_year`,
  `get_shishen_analysis`, `get_person_shishen`, `get_shensha_info`, `get_person_shensha`,
  `get_xingchong_huihe`, `get_person_xingchong`, `get_person_dayun`, `get_ganzhi_calendar`,
  `convert_date`
- **紫微斗数 (Zi Wei Dou Shu)**: `calculate_ziwei`, `get_daxian_by_age`,
  `get_daxian_palace_detail`, `get_year_fortune_detail`, `get_palace_stars`, `get_sanfang_sizheng`,
  `get_xiaoxian`, `get_sihua_for_tiangan`, `get_flying_sihua`, `get_star_brightness`,
  `get_boshi_stars`, `get_suiqian_jiangqian`
- **占卜 (divination)**: `cast_liuyao` (六爻起卦), `cast_meihua` (梅花起卦)
- **黄历 (almanac)**: `get_huangli_info`, `get_huangli_for_date`
- **关系 (relationship)**: `get_daymaster_comparison`, `get_pillar_interaction`,
  `get_cross_shishen`, `load_record`, `lookup_user_records`, `import_self_profile_from_contact`
- **记忆 (memory)**: `save_memory`, `recall_memories`, `update_memory`
- **misc**: `get_weather`

A second, narrower tool list appears in `baziResult.toolCall.*` (`get_wuxing_analysis`,
`get_day_master_strength`, `get_geju_analysis`) and a relationship-scoped list in
`workspace.relationshipNetwork.qa.toolCall.*` (`get_network_overview`, `get_pairwise_daymaster`,
`get_pairwise_pillar_interaction`, `get_pairwise_cross_shishen`, `get_liuyue_info`, …) — so tools are
**scoped per surface**, not one global registry. **OBSERVED** (`raw/messages-zh-{agent,life-report,workspace}.json`).

Tool-call UX: chips with `{name, arguments}` + `{index, result}` re-attached by ordinal, plus
"分析完成，共 {count} 次查询". **OBSERVED** `raw/agent2/bodies/022-request-23.js` @ ~15900.

### 4.3 Divination systems supported

八字/四柱, 紫微斗数, 六爻纳甲, 梅花易数, 奇门遁甲, 老黄历择日, 塔罗, 生肖配对, 二十八星宿,
人生 K 线. **OBSERVED** `raw/home/accessibility.txt` + `raw/messages-zh-agent.json`.

Notably, **tarot is explicitly excluded from the agent**: `agent.seo.method_tarot_desc = "Agent 当前不会
抽取塔罗牌；需要抽牌或解读牌阵时，请使用独立的塔罗工具。"` and
`agent.seo.methodsDesc = "…塔罗抽牌仍是 FateMaster 的独立工具，Agent 不会在对话里伪造牌阵。"`
**OBSERVED** — an unusually explicit scope boundary treated as a correctness guarantee.

### 4.4 排盘 / chart-arrangement algorithm hints — OBSERVED (first-party documentation)

The site documents its own engine on `/workspace/bazi-calculate` and `/guides/calculation-methodology`:

- **Five ordered time corrections** before any stem is written: 时区 → 夏令时 → 真太阳时 → 子时口径 →
  年柱分界. **OBSERVED** `raw/bazi/accessibility.txt` (*"出生时间要先过五道关"*).
- **Hidden-stem (藏干) weighting** by 本气/中气/余气 = **1.0 / 0.7 / 0.5**, explicitly *not* counting.
  **OBSERVED** `raw/bazi/accessibility.txt`.
- **57 神煞** computed per 《三命通会》 (Ming-dynasty source). **OBSERVED** same file; `agent.seo`
  mentions "检索六十神煞" in the report animation copy (`raw/messages-zh-life-report.json` → `wheel.phaseShensha`).
- **25 格局**: 八正格 + 从格 + 专旺格 + 化气格, plus three-branch combination rewrites. **OBSERVED**
  `raw/bazi/accessibility.txt` (*"本引擎可识别 25 种格局"*).
- **Solar-time / DST engine with historical data for 123 countries and regions**; China 1986–1991 DST
  called out (~36 M births). **OBSERVED** `raw/home/accessibility.txt` FAQ.
- **大运 starting age**: classic 3-days-per-year / 1-day-per-4-months rule, *"余数精确到小时"*, exact
  transition dates given. **OBSERVED** `raw/messages-zh-life-report.json` → `baziResult.basicInfo.dayunStartInfo.description`
  and `raw/bazi/accessibility.txt`.
- **Direction**: 阳年生男/阴年生女顺推, the converse 逆推. **OBSERVED** `baziResult.daYunAnalysis.infoContent.calculationRules.basicConcepts`.
- **年柱 boundary is 立春's exact moment, not 正月初一**. **OBSERVED** `baziResult.basicInfo.zodiacInfo.description`.
- **刑冲会合** rendered as an explicitly layered, enumerated relation set (合/冲/暗合/害/破/刑 + 三会/拱会/三合/拱局/半合/土局). **OBSERVED** `baziResult.relations.description`.
- Personal-life-report prompt *content* is **UNKNOWN**; only the chapter plan is public
  (`lifeReport.chapters.*`: 能量循环路径 / 优势杠杆 / 易损点 / 运行手册 / 财富模式 / 亲密关系 / 滋养源 /
  当前阶段 + 高配/低配 two-path + 升级路线).

### 4.5 Persona / "masters" structure — OBSERVED negative + DERIVED

**There are no named masters/personas.** The product uses **one** agent identity, `命理 AI Agent`
(SEO title `AI 命理师`), which routes to tools. **OBSERVED**: no `大师`/`袁天罡`/`李淳风`/`鬼谷子`/
`刘伯温`/`诸葛亮` strings anywhere in the 145 captured JS bodies or the SSR HTML; the only
`persona*` hit is the word `personalityComplement` in an i18n key; `命理师` appears only as a generic
job title in SEO copy. Verification: `grep -ohr '大师' raw/*/bodies/* raw/html/*.html` → 0 hits.

Differentiation is instead expressed as **术数 choice** (the agent decides which divination system fits
the question) and as **surface-scoped tool sets** (§4.2). The agent copy explicitly asserts two
correctness boundaries: it may not fabricate a chart (`agent.seo.faq1A`) and it may not fabricate a
tarot spread (`agent.seo.method_tarot_desc`). **OBSERVED**.

### 4.6 Memory / personalization — OBSERVED

- Server-side memory with a management UI: `agent.memory.*` — "AI 记忆", sections 关于你 / 关于命例人物,
  per-item edit/delete, clear-all with confirmation, `memory.loginRequired = "请先登录"`.
- Backing tools `save_memory`, `recall_memories`, `update_memory`.
- Copy is careful about the boundary: `agent.seo.feature3Desc = "保存的背景可以减少重复输入…记忆不会改变
  排盘公式，也不会让主观解读自动变得更准确。"`
- A "who am I" anchor is a first-class concept across surfaces: `relationshipNetwork.selfSetup.*`,
  `lifeReport.selfGate.*` ("人生报告以你本人为主角"), `import_self_profile_from_contact`.
- **OBSERVED** `raw/messages-zh-{agent,workspace,life-report}.json`.

### 4.7 Streaming / partial rendering — OBSERVED

Reasoning token stream → separate collapsible "思维过程/思考过程" pane, then `phase_change` →
content stream. Tool-call chips appear while the answer streams. Life report instead uses a
ceremonial progressive UI: a scripted "推演仪式" with per-phase labels (`wheel.phaseBoot` 立盘…,
`wheel.calc` 换算干支历, `wheel.phaseLock` 甲子轮锁定…, `wheel.phaseRelations` 校验刑冲会合…,
`wheel.phaseShensha` 检索六十神煞…, `wheel.phaseDayun` 推演大运…, `wheel.phaseWeigh` 称身…,
`wheel.phaseWriting` 深度模型执笔…), per-chapter 执笔/定稿 lines, and a replay mode
(`wheel.replay`, `wheel.exitReplay`). **OBSERVED** `raw/messages-zh-life-report.json`.

---

## 5. Paywall / monetization

### 5.1 What is gated — OBSERVED

From `raw/messages-zh-agent.json` → `pricing.dialog.*` and `raw/messages-zh-life-report.json`:

- Gated surfaces: 八字分析, 紫微斗数分析, 八字合婚, 紫微合婚, 八字关系分析, 事业合作分析,
  梅花易数每日决策, 六爻断卦, 奇门遁甲, 塔罗解读, **命理 AI Agent**, 人生 K 线, 每日运势.
- Life report: the 主判词/用神 preview is **free**; the 10 chapters + 高配/低配 + 升级路线 are paid
  (`wheel.paywallLabel`, `wheel.unlockCta = "解锁完整命书 {price}"`).
- Relationship graph: **free tier caps contacts** — `relationshipNetwork.limitReached = "免费用户最多 {max}
  个联系人"`; the `{max}` value is **UNKNOWN** (interpolated server-side).
- Feature locks use a consistent shape (`featureLock.<feature>.title/description` + `subscribeNow`),
  i.e. locked areas still render their headers/descriptions and gate the body.
- Agent gating is a **trial**, not a hard lock: `AGENT_TRIAL_EXHAUSTED` + client `agentTrial.hasRemaining`
  (`es = !hasAccess && agentTrial?.hasRemaining`) — so anonymous users get a limited agent trial.

### 5.2 Entitlement check — OBSERVED + DERIVED

`GET /api/access` → `hasAccess = !!hasSubscription || !!hasPurchase` (+ `accessType`, `accessEndDate`,
`remainingTime`, `agentTrial`). Cached client-side as `localStorage["<userId>_cachedAccessDetails"]`
with `lastLoggedInUserId`, and used for optimistic first paint.
**DERIVED**: because the generation endpoints independently return `ANON_CALC_LIMIT` / `ANON_LIMIT_REACHED`
/ `DAILY_LIMIT_REACHED` / `AGENT_TRIAL_EXHAUSTED`, entitlement is re-verified server-side; the
localStorage cache is not the authority. I could not confirm whether every paid surface re-checks.

### 5.3 Price points — OBSERVED (live values, 2026-10-12)

`GET /api/prices?locale=zh` (`raw/pricing/bodies/032-request-33.json`) returned 6 Stripe Prices, all on
one Stripe product `prod_T5sHCo32yIBnPM`, product name `FateMaster.AI`:

| Type | Currency | Amount | Stripe price id | Created |
|---|---|---|---|---|
| `one_time` ("单日解锁" / daily pass) | USD | **$15.00** | `price_1S9gWYEU960zgEcXNSqsDRsa` | 2025-09-21 |
| `one_time` | JPY | **¥1,980** | `price_1SNPVIEU960zgEcXfMYrpXbh` | 2025-10-29 |
| `one_time` | CNY | **¥89.80** | `price_1SJbLLEU960zgEcXSan6CP3g` | 2025-10-18 |
| `recurring`, `interval: year` ("年费会员") | USD | **$59.00/yr** | `price_1S9ggFEU960zgEcXwD65WvQD` | 2025-09-21 |
| `recurring`, `interval: year` | JPY | **¥8,800/yr** | `price_1SNPUwEU960zgEcXoRktuvZ9` | 2025-10-29 |
| `recurring`, `interval: year` | CNY | **¥399.00/yr** | `price_1SXgTREU960zgEcXw2IPQRIP` | 2025-11-26 |

**Corroborated in rendered UI** for `zh`: `raw/pricing/accessibility.txt` shows `¥89.8 /天` and `¥399 /年`.
Two tiers only: a one-off day pass and an annual subscription; no monthly plan, no `trialPeriodDays`,
no `metadata`. Yearly advertises a **price-lock**: `yearlySubscription.pricePromise.*` =
*"永久锁定续费价格…续费永享原价"*.

**Checkout**: `POST /api/create-checkout-session` with `{price, locale, touchpoint, context:{page,
entrypoint, preCheckoutPage}}`; `touchpoint` values observed are `"page_checkout"` (from `/pricing`) and
`"dialog_checkout"` (from the subscription dialog); `preCheckoutPage` is read from `sessionStorage`
`pre_checkout_page`, which `deferred-global-effects.js` maintains by recording every non-pricing
pathname. **OBSERVED** `raw/pricing/bodies/010-request-11.js` @ 2157,
`raw/agent2/bodies/020-request-21.js` @ 2775, `raw/home/bodies/019-request-20.js`.

**Not observed**: the actual Checkout session response (requires an authenticated click), the
success/cancel return routes, invoice/receipt handling, refund policy, and whether the daily pass is
single-calendar-day or 24 h. All **UNKNOWN**.

### 5.4 Conversion instrumentation — OBSERVED

`paywall_view` is fired with `{surface:"page", page:pathname}` from `/pricing`
(`raw/pricing/bodies/010-request-11.js` @ 1486). Attribution captures `utm_*`, `document.referrer`
origin, a **classified source** (`google`, `baidu`, `bing`, `yahoo`, `sogou`, `360`, `chatgpt`,
`claude`, `perplexity`, `poe`, `twitter`, `facebook`, `instagram`, `xiaohongshu`, `weibo`, `douyin`,
`bilibili`, `zhihu`, `reddit`, `linkedin`, `youtube`, `telegram`, `whatsapp`, `wechat`, `discord`),
`landing_page` and `first_visit`, then POSTs to `/api/attribution` once a session exists.
**OBSERVED** `raw/home/bodies/019-request-20.js` — note the AI-assistant referrer buckets, i.e. GEO
acquisition is measured as a first-class channel, and `robots.txt` says the same in prose.

---

## 6. Comparison with fatetell.com

Both sites were inspected live on 2026-10-12. FateMaster's sibling/competitor is **structurally smaller
and differently shaped**.

| Dimension | FateMaster.ai | fatetell.com | Evidence |
|---|---|---|---|
| Framework | Next.js App Router (RSC) | Next.js (`_next/static` present) | **OBSERVED** `raw/fatetell/home.html` |
| CDN | Cloudflare → Vercel (`x-vercel-id`, `x-matched-path`) | Cloudflare (`server: cloudflare`); no Vercel headers emitted on `/` | **OBSERVED** `raw/fatetell/home.headers` |
| Locales | 5: zh, en, zh-Hant, ja, ko | 8: zh-CN, zh-TW, en, ja-JP, ko-KR, vi-VN, de-DE, ru-RU | **OBSERVED** sitemaps |
| Sitemap size | **4,115 URLs** across 12 child sitemaps (one per 神煞/格局/卦/日/星曜) | **81 URLs**, flat | **OBSERVED** `raw/sitemap*.xml` vs `raw/fatetell/sitemap.xml` |
| Route style | kebab-case noun routes, deeply nested (`/workspace/meihua/daily-decision`, `/guides/geju/zheng-guan-ge`) | flat camelCase (`/bazi-calculator`, `/aboutUs`, `/privacyPolicy`, `/terms`) + a small `/bazi/{day-master,five-elements,ten-gods,methodology}` set | **OBSERVED** |
| Pricing page | dedicated `/pricing` with rendered tiers + `/api/prices` | **no `/pricing`** — `/pricing` returns **404**; monetization sits behind `/shop` | **OBSERVED** `HTTP 404 size=14045` for `https://fatetell.com/pricing` |
| Product shape | 14+ interactive tools in one workspace, daily 日签, relationship graph, AI memory, single conversational agent | marketing site + `/app` + `/ai-fortune-teller` + `/bazi-calculator` + `/shop` | **OBSERVED** |
| Deliverables | 八字人生报告 (10-chapter AI book, emailed), 人生 K 线, per-relationship AI scores with monthly refresh | FateBook / AnnualBook paid reports (per task brief) | — |

Not directly comparable (not publicly visible without logging in): fulfilment latency/quality, whether
fatetell.com enforces entitlement server-side, and their report tooling. **UNKNOWN**.
FateMaster's distinctive structural bets, relative to a marketing-site sibling, are (a) a ~50× larger
programmatic guide corpus, (b) tool-call-grounded agent rather than free-form chat, (c) second-order
deliverables (relationship graph, life K-line, life report) rather than one report SKU.

---

## 7. Notable defects / quirks observed

- **Broken cross-zone navigation into `/history`.** Client-side navigation to `/history` requests
  `/_next//history/_next/static/chunks/51ddee8f1e24f7fa.js` → **308**, and
  `/_next/static/chunks/history/_next/static/chunks/93edf41099eef83b.js.undefined.js` → **404**, plus a
  console error `Failed to fetch RSC payload for https://www.fatemaster.ai/history. Falling back to
  browser navigation. TypeError: Cannot read properties of undefined (reading 'call')`.
  `/history` itself SSR-renders fine (`title: 中国命理发展史`, `canonical: …/history`).
  **OBSERVED + DERIVED**: this is a Next.js multi-zone / basePath asset-prefix mismatch — the 中国命理发展史
  sub-site (`raw/sitemap.xml` comment says *"history/sitemap.xml 不在本仓库，由 chinese-astrology-history
  子站生成"*) is mounted at `/history` but emits root-relative `_next` URLs.
  (`raw/home/summary.md:45-46,68,117-118`.)
- `deferred-global-effects.js` is served from `/scripts/` (a literal folder) while `robots.txt`
  disallows `/static/` — not a conflict, but note the script is *not* fingerprinted/immutable.
- Sentry is tunnelled through the app origin, so `/monitoring` traffic is same-origin and would appear
  in ad-blocker/same-origin analytics tooling. **OBSERVED**.

---

## 8. Limitations

**Method / scope**
1. `robots.txt` (`raw/robots.txt`) sets `Allow: /` but `Disallow: /api/`, `/_next/`, `/static/`,
   `/cdn-cgi/`, `/*.json$`, `/design-system`, `/admin`. I therefore **did not** fetch or enumerate any
   `/api/`, `/_next/` or `*.json` resource directly. Every API fact comes from (a) traffic the browser
   itself generated during a bounded normal page visit, or (b) static strings in already-captured
   response bytes. Consequence: there may be endpoints that only fire after login/payment and that I
   did not see.
2. No authenticated state. I did not log in, sign in with Google, pay, or solve any captcha, and I
   submitted no real personal data. Everything behind `session != null` is invisible.
3. Bounded interaction: 5 browser scenarios, ~30 document/sitemap fetches, ~1–3 s spacing, no
   concurrency, no scale crawling. I did not attempt to trip rate limits.
4. No chart was ever calculated: `/api/bazi-calculate` and `/api/analyze` were never invoked, so their
   real response shapes (chart JSON schema, analysis record schema) are **UNKNOWN** — only the error
   contracts and the request shapes are observed.
5. Model/provider identity, system prompts, tool JSON schemas, the 用神 algorithm, and the report
   prompt are server-side and remain **UNKNOWN**.

**Tooling**
6. `capture-browser-scenario` failed closed with `cleanup_incomplete` on 2 of 5 runs when
   `capture.at_end` included `storage` — *"Browser scenario cleanup could not be confirmed: Analysis
   operation timed out after 1000ms: capture_browser_scenario"*
   (`raw/home-capture.json`, `raw/pricing-capture.err.txt`). The data is still returned under
   `details.partial_observation.capture`; omitting `storage` made runs succeed cleanly. The home
   capture kept its 3 layout cookies and 1 localStorage + 3 sessionStorage keys
   (`raw/home/artifact-step3-storage.json`), so the loss was small.
7. `export-web-scripts` refused both the error-envelope capture and the raw capture with
   *"Expected a valid inspect_web_page or capture_browser_scenario capture, with retained script
   sources or response bytes"* (`raw/export-web-scripts.err.txt`). **Workaround used**: I materialised
   the already-retained browser-decoded response bytes from the capture into `raw/app/` myself
   (`tools/build-appdir.mjs`), 145 JS files, 6.9 MB. No refetch occurred.
8. `analyze-javascript-application` returned only **partial** coverage:
   `{"relevant_files":145,"parsed_javascript_files":3,"modules":27,"findings":105,"parse_failures":0}`
   with the limitation *"Provider javascript-static-analysis adapter failed during
   analyze_javascript_application"* (`raw/app-graph-partial.json`). Its semantic graph produced 10,915
   `undefined`-kind relations, so I did **not** rely on it for endpoint or flow claims; all §3/§4 claims
   come from direct string/AST-level inspection of the captured bytes instead.
9. Some selected network content was unavailable (8 of 72 responses on `/`), and request bodies were
   `not_exposed` for 68 of 72 transactions (Playwright does not expose them) — so for
   `/api/agent/chat` and `/api/analyze` the *request* shape is from the call site, not from a captured
   wire body. **OBSERVED** limitation text at `raw/home/summary.md:9`.
10. Analytics/monitoring request bodies were captured but `/monitoring` returned `{}`, `/cdn-cgi/rum`
   returned an empty 204, and GA requests were blocked/unavailable — so no telemetry payload was read.

**Product**
11. `{price}` in the unlock CTA, `{max}` free-contact cap, the daily free-preview count, the agent trial
    size, and the exact paywall boundaries per surface are runtime/server values that could not be
    resolved anonymously.
12. The rendered price list was captured for `locale=zh` only; whether other locales surface different
    currency/plan sets was not tested.
13. `history` cross-zone bug (§7) means the client-side behaviour of `/history` under SPA navigation is
    broken; only its SSR output was inspected.
