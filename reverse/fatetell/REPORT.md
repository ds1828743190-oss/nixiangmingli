# FateTell (fatetell.com) — Reverse-Engineering Teardown

**Target:** `https://fatetell.com` (public, unauthenticated pages only)
**Method:** REA 6.4.0 `capture-browser-scenario` (bounded Playwright runs), `export-web-scripts`, `analyze-javascript-application`, plus static grepping of exported bundles.
**Date of captures:** 2026-10-12 (UTC), Cloudflare edge colo SIN.
**Scope root:** `reverse/fatetell/`

Citation convention: paths are relative to `reverse/fatetell/`. `@N` = byte offset in a minified single-line bundle (byte offsets, not line numbers, because the bundles are minified to one line). `[ev_…]` = REA evidence id of the capture.

| Capture | REA evidence id | Notes |
|---|---|---|
| `raw/home-capture.json` | *(error envelope, `cleanup_incomplete`; capture retained in `details.partial_observation`)* | homepage, headers + DOM + AX + screenshot |
| `raw/home-bodies-capture.json` | `ev_cc03d9d519892efdc4efdb871bd6e88f8efc62e8e3b1a8d78453319936353be4` | homepage with response bodies → script export |
| `raw/pages-capture.json` | *(partial_observation)* | /shop, /app, /ai-fortune-teller, /bazi-calculator |
| `raw/webapp-capture.json` | `ev_50883fa9f25e8662b97e8c9224cc602133ca51f27929a593d9a0d8080c970234` | web.fatetell.com/onboarding |
| `raw/webapp-bodies-capture.json` | *(partial_observation)* | web app with response bodies |
| `raw/final-capture.json` | `ev_2848014c227e375795250d75358bceb09c8e6d9001362f7e9a33f5ad99b1d5bb` | /archive, /aboutUs, /terms |
| `raw/webshop-capture.json` | *(partial_observation)* | web.fatetell.com/shop |
| `raw/export-scripts.json` | `ev_3b43e38fbb92c8fd37a0853817f4f99251376f6f2830837dfd35a4c7a9321987` | script export manifest |

> Note: several runs returned exit code 1 with `code: "cleanup_incomplete"` — the capture itself completed and was returned in full inside `details.partial_observation.capture`; only browser teardown confirmation timed out. `raw/extract-capture.js` unwraps this. Each such capture carries the limitation *"Scenario observations are partial because browser cleanup could not be confirmed."*

---

## 1. Observed — Tech stack

| Layer | Finding | Evidence |
|---|---|---|
| Framework | **Next.js 16.3.2, App Router + React 19.1.0**, Turbopack build | `next@16.3.2` and `react-dom@19.1.0` literals in `raw/scripts/files/origins/aef2162290…/_next/static/chunks/2qw56ud3sxl2p.js`; `turbopack-1i721e9d9j3v1.js`; `vary: rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch` in the document response headers (`raw/home-capture.json`, `network-content` response headers for `request-1`) |
| RSC | App Router flight payload embedded as `self.__next_f.push([1,"…"])`; decoded to `raw/home.flight.txt` (76,815 bytes) | `raw/home.dom.txt`; decoder `raw/decode-rsc.js` |
| CSS | Tailwind-style class maps + Next CSS chunks; Radix UI primitives | `radix-ui.com` in `raw/webapp-js/…`; `raw/scripts/files/…/chunks/*.css` |
| Hosting / CDN | **Cloudflare in front of a Zeabur origin** | response headers of `https://fatetell.com/`: `server: cloudflare`, `cf-ray: a49558bdfa84fdf2-SIN`, `cf-cache-status: DYNAMIC`, `server-timing: cfEdge;dur=28,cfOrigin;dur=357`, and **`x-zeabur-request-id` / `x-zeabur-ip-country`** (`raw/home-capture.json`) |
| Cloudflare plumbing | CF bot-management + RUM + Insights beacon present | `https://fatetell.com/cdn-cgi/challenge-platform/scripts/jsd/main.js`, `cdn-cgi/rum`, `static.cloudflareinsights.com/beacon.min.js` (`raw/home.network.json`, `raw/pages.network.json`) |
| Static site generator (docs) | **Framer** (guide.fatetell.com) | `<meta name="generator" content="Framer cc3b8f8">` in `raw/guide-what-is-chinese-bazi-astrology.html` |
| Blog | separate host `post.fatetell.com` (33 sitemap URLs, 3 locales) | `raw/post-sitemap.xml` |
| Fonts | Google Fonts: Raleway, EB Garamond, Noto Serif SC | `raw/home.network.json` (fonts.googleapis.com/gstatic.com) |
| Images | `next/image` optimizer + external `media.fatetell.com` | `_next/image?url=…media.fatetell.com…` in `raw/home.network.json` |
| PWA | web app is an installable PWA | `web.fatetell.com/manifest.webmanifest`; console `beforeinstallpromptevent` message in `raw/webapp.events.ndjson` |

### i18n
- 8 locales, default `en-US`, with locale-prefixed routes (`/zh-CN`, `/zh-TW`, `/ja-JP`, `/ko-KR`, `/vi-VN`, `/de-DE`, `/ru-RU`).
  Evidence: `localeMetadata` + `locales:["zh-CN","zh-TW","en-US","ja-JP","ko-KR","vi-VN","de-DE","ru-RU"]` at `raw/scripts/files/origins/aef2162290…/_next/static/chunks/0ew-ko1fvp8bc.js` @431.
- `LanguageSwitcher` renders the 8 native names (`English`, `简体中文`, `繁體中文`, `日本語`, `한국어`, `Tiếng Việt`, `Deutsch`, `Русский`) — `…/chunks/2ogeogvilp940.js` @6047.
- Cookie `NEXT_LOCALE` on the marketing site (`raw/home.storage.json`); cookie `lang` on `web.fatetell.com` (`raw/webapp.s1-onboarding_settle.storage.json`).
- Per-page translated dictionaries are shipped inside the RSC payload (598 `key:value` pairs on the homepage alone) — extracted to `raw/home.i18n.txt`, `raw/aft.i18n.txt`.

### Analytics / 3rd-party SDKs (observed)
| Vendor | Identifier | Evidence |
|---|---|---|
| **PostHog** (US cloud) | project key `phc_WBvfiP36Pne3SwqugnPmLWPB3sTIvYg3WiTIa4r7v0d`, host `us.i.posthog.com` | `NEXT_PUBLIC_POSTHOG_KEY` fallback literal at `…/chunks/2qw56ud3sxl2p.js` @293; cookie/localStorage keys in `raw/home.storage.json` |
| PostHog survey module | `us-assets.i.posthog.com/static/1.422.5/surveys.js` | `raw/home.network.json`; exported at `raw/scripts/files/origins/910f6131…/static/1.422.5/surveys.js` |
| **Google Analytics 4** | `G-RM05FGMBGY` via `googletagmanager.com/gtag/js` | `i="G-RM05FGMBGY"` at `…/chunks/2qw56ud3sxl2p.js` @~500; `POST google-analytics.com/g/collect?v=2&tid=G-RM05FGMBGY` in `raw/pages.network.json` |
| **OpenAI Ads / oaiq SDK** v0.1.41 | pixel `HGLEjFZUbnxib8XXs74jss` (prod), `5CtLuEAqZjWQtGtpcFWaYx` (test) | `openAIAdsPixelId`/`openAIAdsTestPixelId` in `raw/home.flight.txt`; `bzrcdn.openai.com/sdk/oaiq.min.js`; `POST bzr.openai.com/v1/sdk/events?pid=HGLEjFZUbnxib8XXs74jss&st=oaiq-web&sv=0.1.41` in `raw/home.network.json` |
| **Geoapify** (geocoding) | proxied via first-party `/api/bazi/places` | `https://www.geoapify.com/` link + privacy note "only the place name is sent to Geoapify" in `raw/extra-chunks/0qgkc7ioijihs.js` |
| PostHog WebMCP capture | `capture_webmcp`, `$mcp_intent`, `$mcp_llm_model` | library strings in `raw/webapp-js/_next/static/chunks/*.js` |

Analytics consent is explicit: cookie `fatetell_analytics_consent=granted`, set with `Domain=.fatetell.com; SameSite=Lax`, after which a queued PostHog queue is flushed (`…/chunks/2qw56ud3sxl2p.js` @5588). PostHog is initialised with `person_profiles:"never"`, `autocapture:!1`, `capture_pageview:!1`, `disable_session_recording:!0`, `respect_dnt:!0` and registers `source_site:"official"`.

---

## 2. Observed — Routes and product flow

### Routes (from `raw/sitemap.xml`, 81 URLs; verified 200 for `/archive`, `/bazi/methodology`, `/bazi/ten-gods`)
`/` · `/aboutUs` · `/app` · `/shop` · `/ai-fortune-teller` · `/bazi-calculator` · `/bazi/methodology` · `/bazi/day-master` · `/bazi/five-elements` · `/bazi/ten-gods` · `/privacyPolicy` · `/terms`
Additional routes observed only at runtime (never in the sitemap): **`/archive`** (public FateBook sample; prefetched from `/ai-fortune-teller`, `raw/pages.network.json`).

Other hosts discovered from bundle constants (`…/chunks/2ogeogvilp940.js` @20716 `Links` object):
`https://fatebook.fatetell.com` · `https://web.fatetell.com/shop` · `https://post.fatetell.com` · `https://guide.fatetell.com/wiki` (+`/zh-hans/wiki`) · `https://apps.apple.com/app/id6752552096`
Brand doc images live under `/images/brandbook/page-01.webp … page-60.webp` (60-page "brand book" rendered at `/aboutUs`, `raw/final.s3-about_settle.accessibility.txt`).

### User-facing flow (observed publicly)
1. **Landing** `/` — hero "Decode your BaZi, shape your Fate" with two CTAs: `Try It Now` and `Download iOS`; a top banner "A lighter, more immersive journey with our mobile app → App Store" (`raw/home.accessibility.txt` L2–L23).
2. **`Try It Now` is a server-decided redirect.** The CTA handler `handleExperienceClick` does `fetch("/api/chat", {method:"GET", headers:{Accept:"application/json"}})`, then `window.location.href = json.redirectUrl`, falling back to `https://web.fatetell.com`; it also runs `addOpenAIAttributionToWebAppUrl()` which only appends attribution for hosts `fatetell.com`, `www.fatetell.com`, `web.fatetell.com` (dev hosts `localhost/127.0.0.1/[::1]`). Evidence: `raw/scripts/files/origins/aef2162290…/_next/static/chunks/3x341csdr460r.js` @29006.
3. **Free tooling without signup** — `/bazi-calculator` (client-side 排盘) and `/archive` (FateBook sample with fictional data). `/ai-fortune-teller` explicitly advertises "no sign-up needed" and links the free sample.
4. **Web product** `web.fatetell.com` — `/` 307-redirects to `/onboarding?redirect=%2Ffate`; `/shop` 307-redirects to `/onboarding?redirect=%2Fshop` (`raw/webshop-capture.json` network rows `request-1`, `request-2`). Onboarding copy: *"Enter your birth details, then sign in to create and save your personal profile."* Product modules named **Book of Fate**, **Book of Abundance**, **AI Dialogue** (`raw/webapp.s1-onboarding_settle.accessibility.txt` L11–L19).
5. **Auth**: `Register` / `Login` in the marketing header; the web app offers Email, Google and Apple sign-in (`invite_step2_emailLogin` / `googleLogin` / `appleLogin`, `raw/home.i18n.txt`). API endpoints `/auth/login-by-email`, `/auth/oauth-login`, `/auth/email-verification` (`raw/webapp-api-paths.txt`).
6. **Purchase → redeem → retention**: `/shop` offers four "Go to Purchase" CTAs; gift cards are redeemed on-site through a large `redeem_*` flow (163 strings) and influencer `kol_*` offers (52 strings) with email verification; `invite_*` (41 strings) drives friend referrals; `connection_invite_*` implements a two-person chart-comparison invite (`raw/home.i18n.txt`).

---

## 3. Observed — Backend API surface

### 3a. Marketing site (`fatetell.com`)
Only one first-party API route appears anywhere in the exported marketing bundles:
- `GET /api/chat` → `{ redirectUrl: string }` — returns the destination for the "Try It Now" CTA (`…/chunks/3x341csdr460r.js` @29006).
- `GET /api/bazi/places?q=<query>&lang=<lang>` → `{ results: [...] }` — birthplace search proxy for Geoapify; called with `cache:"no-store"` and an `AbortController`, 400 ms debounce, client-side cache capped at 80 entries; **returns HTTP 429 under rate limiting**, which the UI maps to "Please try again shortly…". Evidence: `raw/extra-chunks/0qgkc7ioijihs.js` @1156555.
Otherwise the marketing site is fully server-rendered; its only network calls are RSC prefetches (`/aboutUs?_rsc=…`, `/app?_rsc=…`, `/shop?_rsc=…`, `/archive?_rsc=…`) — `raw/pages.network.json`.

> `/api/` is disallowed by `robots.txt` for all user agents, so no direct `/api/*` request was issued. The two routes above were read from retained JavaScript, not fetched.

### 3b. Web app (`web.fatetell.com`)
Backend config found as a literal in the client bundle (`raw/webapp-js/_next/static/chunks/a4f2c67ee5c9e128.js` @50923):

```
apiUrl:        "https://api.fatetell.com"
apiUrlPrefix:  "/fapi"
chatUrlPrefix: "/capi"
fateUrl:       "https://www.fatetell.com/"
product ids:   bgProductId a323eb6b-21ca-4f43-a132-0eefcd7eeb95
               csProductId 0239417b-8820-4db8-b28f-02fed0805be2
               dtProductId 3b3a9c64-15c1-4801-bd92-41c899d6e177
               fbProductId b42227c6-514d-413a-a00a-ffbecebae6f8
               agentProductId 6436c4a5-0009-4229-8272-996b40c56046
appleClientId: "com.fatetell.fatetell"
isRequestProxy: false
```

21 distinct endpoint paths (`raw/webapp-api-paths.txt`; all relative to the configured prefix):

| Path | Method (wrapper) | Purpose |
|---|---|---|
| `/auth/email-verification` | POST | send verification code |
| `/auth/login-by-email` | POST | email/code login |
| `/auth/oauth-login` | POST | Google/Apple OAuth exchange |
| `/user/user-info` | GET | profile |
| `/user/config` | POST | set language/UI config |
| `/user/deactivate` | POST | close account |
| `/user/get-archive` | GET | list birth profiles |
| `/user/add-archive` | POST | create profile (supports explicit `Authorization` header *and* `withToken:false`) |
| `/user/update-archive` | POST | edit profile |
| `/user/remove-archive` | POST | delete profile |
| `/user/place-complete` | POST | birthplace completion |
| `/user/web-benefits` | GET | **entitlements** |
| `/user/web-benefits/usage/{productId}` | GET | **per-product quota/usage** |
| `/user/fatebook-list` | GET | owned reports |
| `/user/fatebook` | POST | report content |
| `/fatebook/yun` | GET | luck cycles (大运) |
| `/fatebook/day-yun` | GET | daily fortune |
| `/fatebook/luckbook-base-info` | GET | AnnualBook base info |
| `/fatebook/luckbook-yun-info` | GET | AnnualBook cycle info |
| `/pay/product-info` | GET | **product catalogue / prices** |
| `/pay/create-payment` | POST | **create order** (`{retry:false}`) |
| `/pay/order-info` | GET | order status |

### 3c. Auth mechanism
- **Cookie-stored token, sent as `Authorization`.** `setToken`/`getToken`/`clearToken` read and write a cookie; on failure the app throws `"浏览器拒绝保存登录 Cookie"` ("browser refused to save login cookie") — `raw/webapp-js/_next/static/chunks/a4f2c67ee5c9e128.js` @~50905 and @169727.
- Request interceptor: `t.headers.Authorization = e.authenticationScheme ? \`${e.authenticationScheme} ${r}\` : r` with `authenticationScheme: ""` → **raw token, no `Bearer` prefix** (`…/a4f2c67ee5c9e128.js` @168381).
- Default headers: `Content-Type: application/json`, `Origin: window.location.origin`, `Accept-Language`, and custom `X-FT-APP-VERSION: "0.0.0"`, `X-FT-DEVICE-TYPE`, `X-FT-OS`, `X-FT-PLATFORM: "web"` (`…/a4f2c67ee5c9e128.js` @168507).
- Envelope/error handling: app-level code `10011` = login expired, `401` = unauthorized; HTTP 400/403/404/5xx have message handlers; **retry count 2, delay 1000 ms** (`…/a4f2c67ee5c9e128.js` @168893).
- Two prefix styles coexist: `urlPrefix:"/api/v3"` with `isJoinPrefix:true` for the benefit/fatebook calls, and the default `apiUrlPrefix:"/fapi"` (`raw/webapp-js/_next/static/chunks/000b34d5a7d6aa9e.js` @3230).

### 3d. Streaming
- **Not observable.** No `EventSource`, `text/event-stream`, `WebSocket`, `socket.io` or `fetch-event-source` exists in any retained bundle (marketing site, web-app onboarding bundle set, calculator chunks). The only `ReadableStream`/`getReader` code is Next.js RSC decoding and the archived PostHog surveys module.
- A `chatUrlPrefix: "/capi"` constant exists but has **no usage site in the unauthenticated bundles** → the chat client is presumably a lazily-loaded chunk behind `/fate`, which requires completing onboarding/sign-in.

### 3e. Rate limiting observed
- `/api/bazi/places` → `429` handled client-side (`error:"rateLimited"`), UX string "搜索较频繁，请稍后再试" / "Please try again shortly…" (`raw/extra-chunks/0qgkc7ioijihs.js` @1156555 and @8703).
- Cloudflare bot management is active: a `cdn-cgi/challenge-platform` script + `POST …/oneshot/…` handshake fired on every navigation, and `cf_clearance` cookies were set (`raw/home.storage.json`, `raw/webapp.s1-onboarding_settle.storage.json`). A plain `curl` to `/archive` timed out once while the same URL loaded fine in the browser → automated direct fetches are filtered. No server `Retry-After` or `RateLimit-*` headers were observed.

---

## 4. Observed + Derived — The AI layer and the 排盘 (chart arrangement) algorithm

### Chart arrangement runs in the browser, using 6tail's lunar library
`/bazi-calculator` is a **client-side** calculator. Its own copy states: *"Charts and saved details stay in this browser. Place searches send only the place name to Geoapify, never your birth date or time."* (`raw/pages.s7-calc_settle.accessibility.txt`).

Derived (static evidence):
- The three page-specific chunks `0qgkc7ioijihs.js` (1.19 MB), `3ugc9ruw5cj9k.js` (308 KB), `2rwb7r110szkd.js` (22 KB) were downloaded from `/_next/static/chunks/` (robots-allowed) into `raw/extra-chunks/`.
- `raw/extra-chunks/3ugc9ruw5cj9k.js` exports the class surface **`LunarUtil`, `EightChar`, `Yun`, `DaYun`, `LiuNian`, `XiaoYun`, `JieQi`, `getYearInGanZhiExact`** and a `isLeapYear/getDaysOfMonth` calendar helper with the special case `1582===e&&10===n → 21` days (Gregorian reform). This is the API/class naming of **[6tail lunar-javascript](https://6tail.cn/calendar/api.html)**.
- The calculator UI links to that exact documentation page and labels it "历法与胎命身算法文档 / Calendar & palace algorithm docs", and links two further rule references: **问真排盘** (`https://pcbz.iwzwh.com/`, "reference rules") and **《三命通会》卷三** (`https://zh.wikisource.org/zh-hant/三命通會/卷三`). Evidence: `raw/extra-chunks/0qgkc7ioijihs.js` @1155499–@1155845.
- Call sites use the library's exact-立春 boundary APIs: `lunar.getDayGanIndexExact`, `getDayZhiIndexExact`, `getDayInGanZhiExact`, `getMonthInGanZhiExact`, `getYearGanIndexExact`, `getJieQiTable`, `getTimeInGanZhi` (`raw/extra-chunks/0qgkc7ioijihs.js`).

Domain model implemented client-side (Chinese terms counted in the calculator chunk): 排盘, 真太阳时 (true solar time), 十神 (Ten Gods), 藏干 (hidden stems), 纳音, 神煞, 空亡, 节气, 大运/流年/流月, 胎命身 (palace/fetal-body), 旺衰, 格局, 用神, 五行.
User-selectable calculation settings (from the professional-probe i18n table, `raw/extra-chunks/0qgkc7ioijihs.js` @438503):
- true solar time = longitude + historical time zone + equation of time (`按出生地经度、历史时区和均时差校正时间`)
- day-boundary rule: `23:00 子初换日` vs `00:00 午夜换日`
- DST fall-back duplicate instant: auto / first occurrence / second occurrence
- sex used only for the traditional forward/reverse direction of luck cycles (大运顺逆)
- Southern-hemisphere toggle, simple vs professional chart view

### AI interpretation layer
- The FAQ (homepage) describes a deliberate three-stage split: *"professional algorithm plugins solve the 'chart arrangement' problem, expert systems integrate multiple schools of 'chart interpretation', and human fortune tellers provide value-aligned insights"*, and criticises generic LLMs on (a) Gregorian→lunar conversion errors, (b) biased training data favouring certain schools, (c) sycophancy ("tell users what they want to hear") — `raw/home.accessibility.txt` L150.
- `/ai-fortune-teller` renders the same pipeline as I *Construct the chart* → II *Analyze the relationships* ("Day Master, Five Elements, Ten Gods, strength, balance, and interactions") → III *Explain the pattern* (AI translates relationships into readable themes) — `raw/pages.s5-aft_settle.accessibility.txt` L54–L70.
- The public sample at `/archive` shows how the technical layer is productised into English archetypes: hidden stems are labelled `戊·Warrior`, `乙·Creator`, `癸·Contender`, `壬·Ally`, `甲·Artisan`, `丁·Planner`, `己·Anchor`, and pillars are labelled `Year Pillar Sage`, `Month Pillar Planner`, `Day Pillar Day Master`, `Hour Pillar Planner`. Sample chart rendered for fictional details: Gregorian 2000-11-20 14:00 → 庚/丁/壬/丁 over 辰/亥/午/未 (`raw/final.s1-archive_settle.accessibility.txt`).
- **No model provider, model name, system prompt, or tool/function name is observable publicly.** Not in the marketing bundles, not in the web-app onboarding bundles. The only literal `openai`/`claude` hits are the OpenAI *Ads* SDK (`oaiq.min.js`) and Markdown-rendering library code; the `model:`/`llm_model` strings in the web-app bundles belong to PostHog's WebMCP instrumentation, not to FateTell inference. → **Unknown** (see §8).

---

## 5. Observed — Paywall / monetization

Public price list, server-rendered on `/shop` (`raw/pages.s1-shop_settle.accessibility.txt` L28–L115):

| Product | Price | Contents |
|---|---|---|
| FateBook | **$39.99** | all 10 cards, 10,000+ words, 10 Grand Master chats |
| AnnualBook: Year of the Horse | **$29.99** | for one selected profile |
| Grand Master (chat plugin) | **15 uses / $4.99** | Q&A on personal birth charts; requires FateBook |
| AI Divination | **5 uses / $4.99** | 64-hexagram I-Ching short-term reading |
| Yearly Subscription | **$59.99 / year** | 20 Grand Master chats/day, 5 AI Divinations/day, unrestricted Daily Fortune & Daily Reading |

Free tier vs paid (rendered table "Paid Benefits", same file): free = Daily Fortune & Daily Reading **1/day**, AI Divination **3 times**, Grand Master **8 times**, Yin-Yang Reading **1 copy**. Pay-per-use column = `1 copy/$39.99`, `1 copy/$29.99`, `5 uses/$4.99`, `15 uses/$4.99`. Footnote: *"Yearly plan daily credits reset at midnight… Benefits are platform-specific — purchase on one platform, use and view on that platform only."*

What is gated, and how:
- **Preview gating**: `previewGateTitle = "Only part of this chapter is shown"`, `previewGateDescription`, `previewGateCta`, and `pages_tip_unlock_tip = "This content is locked. Purchase the FateBook to view the complete reading"`, `subscription_preview_title = "For more detailed insights, please purchase the complete FateBook"` (`raw/home.i18n.txt`). On `/archive` only the Day Master chapter is fully open; the other nine are collapsed `article` buttons.
- **Entitlement is server-authoritative**: the client calls `GET /user/web-benefits` and `GET /user/web-benefits/usage/{productId}` before unlocking, and purchases go through `POST /pay/create-payment` + `GET /pay/order-info` (`raw/webapp-api-paths.txt`). Product UUIDs are compiled into the client (`fbProductId`, `bgProductId`, `dtProductId`, `csProductId`, `agentProductId`). The **rendering** of gates is client-side, but the benefit/quota data is fetched from the API → derived: gating decisions are server-sourced, gate UI is client-side. *(Not proven end-to-end; no purchase was attempted.)*
- **Gift-code / KOL monetization**: `redeem_*` (163 strings) implements printed-card voucher redemption — single use, non-transferable, bound once to an account/profile, and platform-bound: `redeem_app_consume_warning` ("Once used here, the same voucher cannot unlock a web FateBook"), with a choice between "FateBook on the web" and "Pocket FateBook in the app" (`redeem_candidate_*`). `kol_*` (52 strings) implements influencer offer codes claimed via email verification.
- **Recovery loop**: `invite_*` (41 strings, "Your friend invites you to experience FateTell" → email/Google/Apple login → 4–10 char code), `connection_invite_*` (invite a friend to compare charts), and `subscription_*` renewal copy in `/terms` (45 subscription mentions, refunds routed to Apple's `reportaproblem.apple.com`).
- Legal entity: **© 2026 Hangzhou Yujian Flying Technology Co., Ltd.** (`footer`, `raw/home.accessibility.txt` L184); Privacy updated 08/2026, Terms updated 08/2025.

---

## 6. Observed — Mobile app / iOS relationship

- App Store URL **`https://apps.apple.com/app/id6752552096`**, rendered as a "Download on the App Store" badge on `/app`, `/`, and the blog; the constant in code is `iOSAppLink` (`…/chunks/2ogeogvilp940.js` @20716).
- iOS bundle identifier **`com.fatetell.fatetell`** is compiled into the *web* app as `appleClientId` (`raw/webapp-js/_next/static/chunks/a4f2c67ee5c9e128.js` @50923) — direct evidence of a shared identity/monetization backend between the web app and the iOS shell.
- Marketing claims on `/app`: "Your Eastern AI Fortune Companion", App Store rating **4.9**, **100,000+ users worldwide**, "Featured by" Channel 4, MIT Technology Review, Hong Kong Economic Journal, NHK (`raw/pages.s3-app_settle.accessibility.txt` L20–L35).
- Cross-platform purchase semantics: benefits are explicitly **platform-specific** ("purchase on one platform, use and view on that platform only"), and the web sample page says "You're viewing the web version of the FateBook. To explore the iOS version, visit the FateTell App page." → the iOS app and the web app are separate storefronts over a shared account/product ID space.
- App-only features named on the marketing site: Daily Energy, Jiaobei Blocks readings, Pocket FateBook (`appLanding_description`, `redeem_candidate_pocket_title`).
- The web app is itself installable (PWA manifest + `beforeinstallprompt`).

---

## 7. Observed — What makes this a good "AI agent" product

- **Two-tier funnel with a real free artifact.** A free client-side BaZi calculator (no signup) and a free, fully-rendered sample report (`/archive`) sit in front of the paid report. The sample explicitly declares its data is fictional and that timelines are pinned to a hardcoded reference year 2025 (`raw/final.s1-archive_settle.accessibility.txt`).
- **Structured, card-based report** instead of one wall of text. The FateBook is exactly **10 cards ≡ "Nine connected chapters"**: `pages_card_title_0..9` / `pages_card_subtitle_0..9` (`raw/home.i18n.txt`), rendered as 10 collapsible `article`s with a "Reading progress" element on `/aboutUs` style layouts. Each card has a metaphor name plus a functional name (Red Envelope | Career & Resources; Love Lock | Relationships; Wenchang Brush | Learning & Growth; Safety Talisman | Well-Being).
- **Chart-grounded explainability.** The report shows the raw Four Pillars, hidden stems and the archetype mapping next to the prose, so a sceptical user can audit the derivation ("A useful reading should show how each interpretation connects to the chart").
- **Layered knowledge productisation.** The shop page markets "The five arts behind FateTell" — Mountain, Medicine, Destiny, Physiognomy, Divination — with 6 diagrams and a knowledge-system narrative; the FAQ and `/ai-fortune-teller` both frame the product as algorithmic chart construction + multi-school expert system + value-aligned interpretation (anti-sycophancy positioning).
- **Retention loops**: daily fortune + daily sign-in ("checking in and silently reciting it to start my day's work", testimonial L56), Daily Energy, daily credits that "reset at midnight", a yearly subscription, an in-app shop gated behind onboarding, KOL/offer codes, printed gift cards, referral invites and a two-person "Connection" chart-comparison invite.
- **Personalization surface**: multiple saved birth profiles per account (`/user/add-archive`, `/user/get-archive`, `/user/update-archive`, `/user/remove-archive`), per-profile AnnualBook, "Which profile should receive it?" redemption binding, and `autocapture:false`/`person_profiles:"never"` analytics (privacy-forward).
- **Chrome-level AI shopping integration**: the OpenAI `oaiq` pixel is wired to product-level events with product UUIDs and a pending-purchase key `fatetell:openai-ads:pending-purchase`, and attribution (`oppref`/`__oppref`/`__obref`/`obref`) is propagated from the marketing site into `web.fatetell.com` deep links.

---

## 8. Unknown / not observable publicly

1. **LLM provider, model name/version, and any system prompt or tool schema.** Not present in any unauthenticated bundle. The chat client (`chatUrlPrefix:"/capi"`) has no usage site in what loads publicly.
2. **Streaming transport for chat** (SSE / WebSocket / fetch stream). No streaming primitive exists in the captured bundles; the chat bundle loads behind `/fate` (requires onboarding).
3. **Real request/response bodies for `api.fatetell.com`.** Loading `/onboarding` made **zero** first-party API calls (`raw/webapp.network.json`), so no sample payload, no token, no error envelope was observed. `robots.txt` on `fatetell.com` disallows `/api/` and this was respected.
4. **Whether entitlement enforcement is truly server-side at render time.** The benefits API exists, but no gated asset was requested without entitlement.
5. **The 60-page brand book content beyond page images** (`/images/brandbook/page-NN.webp` are images; only the accessibility text was captured).
6. **`fatebook.fatetell.com` is unreachable**: TLS certificate expired (`curl: (60) SSL certificate problem: certificate has expired`), so its role is unknown.
7. **Blog post bodies** were not fetched (only the sitemap and titles/links were captured from the homepage carousel).
8. **Chat/reading quality, memory/personalization behaviour, and the report's internal prompt structure** — all behind sign-in/purchase.

---

## 9. Limitations

- **No login, no payment, no captcha solving, no personal data submitted.** Every navigation was a plain GET of a public URL. Form fields were never filled, no button was clicked that would create an account, and the onboarding page was loaded and left idle.
- **`robots.txt` respected.** `fatetell.com` disallows `/api/` and `/_vercel/` for all agents; those paths were **not** requested. All bundle downloads were `/_next/static/` assets already referenced by pages that were loaded. `web.fatetell.com` exposes no `robots.txt` rules (it 307-redirects `/robots.txt` to onboarding); `post.fatetell.com` and `guide.fatetell.com` allow `/`.
- **Request volume is bounded**: 7 browser scenario runs (≤ 7 navigations each) plus 4 direct static-asset downloads and 3 one-shot HTTP probes.
- **REA cleanup timeouts**: 4 of 7 capture runs exited non-zero with `cleanup_incomplete` ("Analysis operation timed out after 1000ms: capture_browser_scenario"). Captured data was complete and retained in `details.partial_observation.capture`; only teardown confirmation was missing, so each such capture's `completeness` is reported as partial. This is a tool/environment artifact, not a target behaviour.
- **`analyze-javascript-application` on the bundle directory produced a partial graph**: `statistics.parsed_javascript_files: 5` of 19, `modules: 0`, and it also failed cleanup (`cleanup_incomplete`), returning 97 MB of retained Evidence in `raw/app-graph.json` (71 graph nodes, 24,967 semantic nodes). Findings in this report therefore rest primarily on **direct static reading of the exported bundles**, not on the graph projection.
- One direct `curl` of `https://fatetell.com/archive` timed out (30 s) while the browser loaded it normally — consistent with Cloudflare bot filtering of non-browser clients. Retried via the browser scenario instead; no workaround was attempted.
- No vulnerability probing, no fuzzing, no authenticated or paid surface was touched.

---

## 10. Evidence file map

| Path | Contents |
|---|---|
| `REPORT.md` | this report |
| `scenario-home.json`, `scenario-bodies.json`, `scenario-pages.json`, `scenario-webapp.json`, `scenario-webapp-bodies.json`, `scenario-webshop.json`, `scenario-final.json` | the seven bounded REA scenarios actually run |
| `raw/*.capture.json` | unwrapped capture objects per run |
| `raw/home.dom.txt`, `raw/home.accessibility.txt`, `raw/home.screenshot.png` | homepage DOM (224,640 B), AX tree, PNG |
| `raw/home.flight.txt`, `raw/home.i18n.txt` | decoded RSC flight + 598 i18n pairs |
| `raw/*.network.json`, `raw/*.events.ndjson` | per-run network transactions and console/frame events |
| `raw/pages.s*.dom.txt` / `.accessibility.txt` / `.flight.txt` | /shop, /app, /ai-fortune-teller, /bazi-calculator |
| `raw/final.s*.…` | /archive, /aboutUs, /terms |
| `raw/webapp.*` | web.fatetell.com onboarding |
| `raw/scripts/files/**` | 19 scripts exported by REA `export-web-scripts` from the homepage (manifest: `raw/scripts/manifest.json`) |
| `raw/webapp-js/**` | 29 web-app script bodies decoded from retained response bytes (+ `_manifest.json`) |
| `raw/webapp-api-paths.txt` | 21 endpoint paths extracted from the web app |
| `raw/extra-chunks/*.js` | 4 calculator-specific chunks (incl. the 6tail lunar library + 排盘 code) |
| `raw/sitemap.xml`, `raw/post-sitemap.xml`, `raw/guide-sitemap.xml`, `raw/post-robots.txt` | route and robots inventories |
| `raw/guide-*.html` | two Framer-built wiki articles |
| `raw/app-graph.json` (97 MB), `raw/app-graph.nodes.json`, `raw/app-graph.summary.json` | partial REA static application graph |
| `raw/ctx.js`, `raw/decode-rsc.js`, `raw/extract-capture.js`, `raw/split-capture.js`, `raw/extract-bodies.js` | helper scripts used for all extraction and offset lookup |

---

## 11. Tool errors and environment blockers (verbatim)

1. `export-web-scripts raw/home-bodies-capture.json raw/scripts` →
   `{"error":"Script export failed","code":"invalid_request",…"message":"capture_path and output_directory must be absolute filesystem paths on this host."}`
   **Fix:** passed absolute paths.
2. `export-web-scripts <capture>` on a cleanup-failed run →
   `"Expected a valid inspect_web_page or capture_browser_scenario capture, with retained script sources or response bytes. Evidence envelopes must have a matching operation and semantic identifier."`
   **Workaround:** decoded the retained base64 response bodies directly with `raw/extract-bodies.js` (digest-verified against each body's `sha256`), which recovered 29 of 31 scripts.
3. `analyze-javascript-application <abs dir>` → exit 1, `{"error":"JavaScript application analysis failed","code":"cleanup_incomplete",…}` with the full 97 MB graph inside `details.partial_observation.normalized_result` (`parsed_javascript_files: 5`, `modules: 0`).
4. Four `capture-browser-scenario` runs → exit 1, `code: "cleanup_incomplete"`, `"Browser scenario cleanup could not be confirmed: Analysis operation timed out after 1000ms: capture_browser_scenario"`; complete capture retained in `details.partial_observation.capture`.
5. `curl https://fatetell.com/archive` → `curl: (28) Connection timed out after 30003 milliseconds`.
6. `curl https://fatebook.fatetell.com/robots.txt` → `curl: (60) SSL certificate problem: certificate has expired`.
7. No filesystem write outside `reverse/fatetell/` was attempted; no sandbox denial occurred.
