# Reference skeleton — Chinese-metaphysics AI assistant

A **zero-dependency, runnable pattern reference** for the four contracts that two
live products converged on independently: a resumable chat stream, a
tool-calling agent stream, per-surface tool scoping, and server-authoritative
quota with machine-readable error codes.

This is a *pattern reference*, not a product. There is no business logic, no
copied proprietary text, no brand names, no network calls and no API keys. The
narration "model" is a deterministic fake, so tests never depend on a provider.

**The one idea worth taking away:** the deterministic kernel computes, the model
only explains. That is enforced structurally — the narration layer receives a
resolved `Facts` object and has no clock, no timezone database and no calendar
functions, so it cannot re-derive a pillar even by accident.

---

## Layout

```
build/skeleton/
├── README.md
├── demo-resume.mjs        runnable proof of the resume contract
├── src/
│   ├── frames.mjs         frame constructors + NDJSON/SSE encode + chunk-safe parsers
│   ├── stream-hub.mjs     message store with monotonic seq + resumeFrom(messageId, fromSeq)
│   ├── kernel.mjs         computeFacts() -> Facts, narrationPrompt(facts)   [stub kernel]
│   ├── tools.mjs          per-surface registry + minimal JSON-Schema validator + dispatch
│   ├── quota.mjs          entitlement store + check()/consume() + typed errors
│   ├── narrator.mjs       deterministic fake narration driver (no network)
│   └── server.mjs         node:http server exposing all four endpoints
└── test/
    ├── frames.test.mjs
    ├── stream-hub.test.mjs
    ├── tools.test.mjs
    ├── quota.test.mjs
    └── e2e.test.mjs       boots a real server on an ephemeral port
```

Node only — no `npm install`, no dependencies, no build step.

```bash
NODE=/Users/xiaolv/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node
```

## Run the tests

```bash
cd build/skeleton
"$NODE" --test 'test/*.test.mjs'
```

> `node --test build/skeleton/test/` (a bare directory) is **not** accepted by
> Node 24 — the argument is resolved as a module, not scanned as a directory.
> Pass a glob or the file list instead, as above.

## Run the server

```bash
cd build/skeleton
"$NODE" src/server.mjs              # listens on 127.0.0.1:8787
PORT=8793 "$NODE" src/server.mjs    # or pick a port
```

`frameDelayMs` (env `FRAME_DELAY_MS`, default 40 when run directly) paces the
stream. It exists so a client can genuinely be interrupted mid-answer — set it to
`0` for maximum throughput.

**Auth in this skeleton:** any non-empty `Authorization: Bearer <token>` acts as
a signed-in principal, and the token *is* the account id (`user:<token>`). There
is no verification — that is the deliberate stub (see *What a real implementation
must add*). `GET /api/access` is readable anonymously; both agent routes require
a principal and answer `401 UNAUTHENTICATED` without one.

Quota is **per principal**, so use a different token for each experiment, or
restart the server.

---

## Endpoint evidence

### 1. `POST /api/agent/chat` — NDJSON agent stream (contract A)

```bash
curl -sS -D- -X POST http://127.0.0.1:8793/api/agent/chat \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer demo-a' \
  --data '{"conversationId":null,"message":"tell me about 2000-01-01","timezone":"Asia/Shanghai","language":"zh"}'
```

```
HTTP/1.1 200 OK
content-type: text/plain; charset=utf-8        # NOT text/event-stream

{"type":"conversation_id","conversationId":"conv_mv55eqrr"}
{"type":"reasoning","content":"Reading the deterministic input for 2000-01-01 12:00 (Asia/Shanghai)."}
{"type":"reasoning","content":"Kernel stub-0.1.0 returned four resolved pillars; I will explain them as given."}
{"type":"reasoning","content":"Surface \"almanac\" exposes 3 tool(s): almanac.day_info, almanac.range_summary, almanac.save_note."}
{"type":"phase_change"}
{"type":"tool_call","toolCall":{"name":"almanac.day_info","arguments":{"date":"2000-01-01","timezone":"UTC","fields":["ganzhi"]}}}
{"type":"tool_result","index":0,"result":{"ok":true,"result":{...},"durationMs":0.2}}
{"type":"content","content":"Chart for 2000-01-01 12:"}
...                                            # 30 frames total
{"type":"keep-alive"}
```

Frame census: `conversation_id 1, reasoning 3, phase_change 1, tool_call 1, tool_result 1, content 22, keep-alive 1`.

Reader semantics the client must implement: `getReader()` → `decode({stream:true})`
→ accumulate → `split("\n")` → `JSON.parse`; 30 s inactivity timeout polled every
5 s → abort; retry ≤ 3 with 2 s backoff (`AGENT_READER_POLICY` in
[src/frames.mjs](src/frames.mjs)).

### 2. `POST /api/v3/:channel/messages` — SSE chat stream (contract B)

```bash
curl -sS -D- -N -X POST http://127.0.0.1:8793/api/v3/zhouyi-bagua/messages \
  -H 'content-type: application/json' \
  -H 'accept: text/event-stream' \
  -H 'authorization: Bearer demo-b' \
  --data '{"content":"explain 2000-01-01","conversation_id":"conv-b","archive_id":"arch-1","request_id":"req-1"}'
```

```
HTTP/1.1 200 OK
content-type: text/event-stream; charset=utf-8
x-message-id: msg_mv55eu2w_1        # resume handle, known before frame 1

data: {"messageId":"msg_mv55eu2w_1","seq":1,"retryable":false,"msg":{"event":"start","conversationId":"conv-b","messageId":"msg_mv55eu2w_1","channel":"zhouyi-bagua"}}

data: {"messageId":"msg_mv55eu2w_1","seq":2,"retryable":false,"msg":{"event":"action","action":"reasoning","content":"Reading the deterministic input for 2000-01-01 12:00 (UTC)."}}
...
data: {"messageId":"msg_mv55eu2w_1","seq":29,"retryable":false,"msg":{"event":"end","content":"Chart for 2000-01-01 12:00 (UTC). ...","state":{"frameCount":28,"contentChunks":21}}}

data: [DONE]
```

Event kinds inside the frame: `start | message | action | end | error`. `seq` is
monotonic and gapless per message.

### 3. `GET /api/v3/:channel/messages/:messageId/stream?from_seq=N` — resume

The cursor is **exclusive**: send the last `seq` you actually rendered, and you
get exactly the frames after it — no gap, no duplicate.

```bash
curl -sS -N "http://127.0.0.1:8793/api/v3/zhouyi-bagua/messages/msg_mv55eu2w_1/stream?from_seq=28" \
  -H 'authorization: Bearer demo-b'
```

```
data: {"messageId":"msg_mv55eu2w_1","seq":29,"retryable":false,"msg":{"event":"end","content":"Chart for 2000-01-01 12:00 (UTC). ..."}}

data: [DONE]
```

`demo-resume.mjs` proves the hard case — abandoning a live stream and stitching
it back together:

```bash
BASE=http://127.0.0.1:8793 TOKEN=demo-r "$NODE" demo-resume.mjs
```

```
POST  /api/v3/zhouyi-bagua/messages      -> 200, x-message-id: msg_mv55ewfb_2
  rendered seq 1,2,3  (last event: action)
  connection abandoned here (this is the part that normally loses the answer)
GET   .../messages/msg_mv55ewfb_2/stream?from_seq=3 -> 200, x-stream-status: complete
  resumed seq 4..29  (terminal event: end)
  union seq 1..29 — gapless: true, duplicates: false
```

If the message already completed, the replay returns the remaining frames ending
with the terminal frame, then ends — a late reconnect gets the tail it missed and
a clean close instead of a socket that waits forever.

### 4. `GET /api/access` — entitlement snapshot (contract D)

```bash
curl -sS http://127.0.0.1:8793/api/access -H 'authorization: Bearer demo-a'
```

```json
{"hasSubscription":false,"hasPurchase":false,"accessType":"trial","signInRequired":false,
 "accessEndDate":null,"remainingTime":null,
 "agentTrial":{"limit":2,"used":1,"remaining":1,"hasRemaining":true}}
```

The client may cache this for first paint. It is **never** the authority: every
generation call re-checks on the server.

### 5. `POST /api/bazi-calculate` — deterministic path, no model (contract E)

```bash
curl -sS -X POST http://127.0.0.1:8793/api/bazi-calculate \
  -H 'content-type: application/json' -H 'x-anon-id: demo-k' \
  --data '{"date":"1990-06-15","time":"08:30","timezone":"Asia/Shanghai","gender":"female"}'
```

```json
{"facts":{"input":{...},"calendar":{"trueSolarTime":false,"dayBoundaryConvention":"stub:not-applied",...},
 "fourPillars":{"year":{"stem":"jia","branch":"wei","ganzhi":"jia-wei"},...},
 "derived":{"elementCounts":{...}},"kernelVersion":"stub-0.1.0","todos":[...]},
 "narrationPrompt":"## FACTS (authoritative, do not recompute)\n\n### Input\n- date: 1990-06-15\n..."}
```

`narrationPrompt` is returned alongside the facts so the deterministic→narration
handoff is inspectable: you can see exactly what the model would have been told,
and confirm that no rule or formula is in it.

### Typed error codes

| code | HTTP | trigger |
|---|---|---|
| `UNAUTHENTICATED` | 401 | agent route without a principal |
| `ANON_CALC_LIMIT` | 403 | 4th anonymous `bazi-calculate` |
| `ANON_LIMIT_REACHED` | 403 | anonymous agent generation (quota layer) |
| `AGENT_TRIAL_EXHAUSTED` | 403 | trial spent, no subscription or purchase |
| `DAILY_LIMIT_REACHED` | 403 | subscriber's daily allowance spent |
| `INVALID_DATE` / `INVALID_TIME` / `INVALID_LUNAR_DATE` | 400 | kernel input rejected |
| `MESSAGE_REQUIRED` / `CONTENT_REQUIRED` | 400 | empty message |
| `INVALID_FROM_SEQ` | 400 | bad `from_seq` cursor |
| `MESSAGE_NOT_FOUND` | 404 | unknown `messageId`, or channel mismatch |
| `PAYLOAD_TOO_LARGE` | 413 | body over 256 KiB |
| `INTERNAL_SERVER_ERROR` | 500 | unexpected failure |

```bash
# 401 for a missing principal
curl -sS -w ' [HTTP %{http_code}]\n' -X POST http://127.0.0.1:8793/api/agent/chat \
  -H 'content-type: application/json' --data '{"message":"hi"}'
# {"code":"UNAUTHENTICATED","message":"authentication required","status":401} [HTTP 401]

# 403 for a spent anonymous calculation allowance (4th call)
curl -sS -w ' [HTTP %{http_code}]\n' -X POST http://127.0.0.1:8793/api/bazi-calculate \
  -H 'content-type: application/json' -H 'x-anon-id: readme-x' --data '{"date":"2000-01-01"}'
# {"code":"ANON_CALC_LIMIT","message":"Anonymous calculation limit reached.","status":403} [HTTP 403]

# 403 for a spent agent trial with no purchase (3rd message on a fresh token)
curl -sS -w ' [HTTP %{http_code}]\n' -X POST http://127.0.0.1:8793/api/v3/zhouyi-bagua/messages \
  -H 'content-type: application/json' -H 'authorization: Bearer readme-y' \
  --data '{"content":"x","conversation_id":"c","archive_id":"a","request_id":"r3"}'
# {"code":"AGENT_TRIAL_EXHAUSTED","message":"Agent trial exhausted.","status":403} [HTTP 403]
```

Requests carrying a `request_id` already seen are idempotent: the original
already paid, so a transport retry replays the stored message instead of
generating — and charging — a second time.

The client renders copy from `code`. It must never match on `message` — that is
how quotas get re-worded, localised and A/B tested without a client release.

---

## The rules worth reading the source for

- **`seq` is what makes a stream resumable.** Assigned by the store, never by the
  producer; frames are replayed verbatim rather than regenerated, so a reconnecting
  user does not watch their answer rewrite itself mid-sentence.
- **Billing keys on `messageId`, not on requests.** A reconnect or a resume is not
  a second charge. Getting this wrong double-bills users on flaky networks.
- **Validation happens before the handler, always.** A rejected tool call is a
  typed `tool_result` in-band, so the model learns *why* and can retry, while the
  user's text keeps flowing.
- **Scopes are not tags.** `listForSurface('almanac')` cannot leak a chart tool: a
  leaked tool is one the model can be talked into calling from the wrong screen.
- **`check()` never consumes.** It is a pure predicate, so the UI can pre-check on
  page load, on focus and on submit without spending anything.
- **A disconnect is a normal path, not an exception.** The client closing
  mid-answer is how resume gets exercised.

## What this skeleton deliberately stubs

| Stub | What a real implementation adds |
|---|---|
| `computeFacts` pillar values | A real calendar engine: solar terms, true-solar-time longitude correction, DST/timezone history, the 23:00-vs-00:00 day boundary, hidden stems, ten gods, luck cycles. Every gap is listed in `Facts.todos`. |
| `narrator.mjs` | A real model call with `narrationPrompt(facts)` as the only fact source, plus a refusal path when the facts look wrong. |
| `StreamHub` (in-memory) | Redis/Postgres append-only table keyed `(message_id, seq)` with a unique constraint — that constraint is what actually enforces monotonic seq under concurrency. |
| `resolvePrincipal` | Signed session/token verification. |
| `EntitlementStore.setEntitlement` | Billing-provider reads (subscription, purchase, access window). |
| No persistence, no rate limiting, no metrics | Durable message store, per-IP/principal rate limits, tracing. |
| `extractDate(message)` | Structured date capture via a tool call or an explicit field — never the model's guess as the authoritative date. |
