/**
 * server.mjs — `node:http` implementation of the four endpoints.
 *
 *   POST /api/agent/chat                                 NDJSON  (contract A)
 *   POST /api/v3/:channel/messages                       SSE     (contract B)
 *   GET  /api/v3/:channel/messages/:messageId/stream     SSE resume (contract B)
 *   GET  /api/access                                     entitlement snapshot (contract D)
 *   POST /api/bazi-calculate                             kernel only, no model (contract E)
 *
 * Why hand-rolled routing on `node:http` instead of a framework: the whole
 * point of this skeleton is that the *streaming* contract is visible. A
 * framework's `res.write()` sugar is exactly where the frame boundaries,
 * flush timing, and disconnect handling get hidden — and those are the parts
 * that are hard to get right.
 *
 * Three behaviours here are easy to get wrong and are therefore explicit:
 *
 *  1. **Flush per frame.** `res.write()` per frame with no buffering layer. If a
 *     proxy or a buffering shim coalesces frames, `keep-alive` stops proving
 *     liveness and the client's 30s inactivity timer fires on a healthy stream.
 *  2. **Disconnect is normal.** A client that closes mid-stream is the *expected*
 *     path (that is how resume gets exercised). Handlers check `writableEnded`
 *     and an abort flag rather than throwing into the void.
 *  3. **Quota is checked inside the handler, before generation.** Not in a
 *     middleware that trusts a client header — see quota.mjs.
 *
 * @module server
 */

import http from 'node:http';
import { URL } from 'node:url';

import { encodeNdjson, encodeSse, encodeSseDone, AGENT_FRAME, CHAT_EVENT, agentFrames } from './frames.mjs';
import { StreamHub, StreamHubError } from './stream-hub.mjs';
import { SqliteStreamHub } from './store-sqlite.mjs';
import { createSessionVerifier, SESSION_ERROR } from './session.mjs';
import { computeFacts, narrationPrompt, KernelError } from './kernel-active.mjs';
import { buildDefaultRegistry } from './tools.mjs';
import { EntitlementStore, QuotaError, KIND, resolvePrincipal } from './quota.mjs';
import { narrate, toChatEvent } from './narrator.mjs';
import { narrateWithModel, createChatStream } from './llm.mjs';

const MAX_BODY_BYTES = 256 * 1024;

/**
 * Any non-empty bearer acts as a signed-in principal. A real server replaces
 * this with real signature verification; it must not be the client's claim.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {{verify: (token: string) => {ok: boolean}}|null} [verifier] omit only when
 *   the caller genuinely has no session key — an omitted verifier yields anonymous,
 *   never "trusted".
 */
export function isAuthenticated(req, verifier = null) {
  return resolvePrincipal(req, verifier).anonymous === false;
}

/** @param {import('node:http').ServerResponse} res */
function setCommonHeaders(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
}

/**
 * Reads and JSON-parses a request body with a hard size cap.
 *
 * The cap is not paranoia about this app; an unbounded request body is an
 * unbounded allocation, and an idle attacker should not be able to OOM a
 * streaming API with a single socket.
 */
async function readJsonBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) {
      const err = new Error('request body too large');
      // @ts-expect-error attach a code for the caller
      err.code = 'PAYLOAD_TOO_LARGE';
      throw err;
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw.trim() === '') return {};
  try {
    return JSON.parse(raw);
  } catch {
    const err = new Error('request body is not valid JSON');
    // @ts-expect-error attach a code for the caller
    err.code = 'INVALID_JSON';
    throw err;
  }
}

function sendJson(res, status, body) {
  setCommonHeaders(res);
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

/**
 * Reads and validates the optional structured birth block (PROTOCOL.md §4bis).
 *
 * What matters here is what it REFUSES: an incomplete birth block is a typed
 * 400, never a silent fallback to a date guessed from the message text. A wrong
 * chart is invisible to the user and poisons every downstream claim, so on
 * missing data the only safe behaviour is to stop and ask.
 *
 * @param {object} body
 * @returns {object|null} null when the client sent no birth data at all
 */
function readBirth(body) {
  const birth = body?.birth;
  if (birth === undefined || birth === null) return null;
  if (typeof birth !== 'object' || Array.isArray(birth)) {
    throw new KernelError('INCOMPLETE_INFORMATION', 'birth must be an object');
  }
  const missing = [];
  if (!birth.date) missing.push('date');
  if (!birth.timezone) missing.push('timezone');
  if (missing.length) {
    const err = new KernelError('INCOMPLETE_INFORMATION', `birth is incomplete: ${missing.join(', ')}`);
    // @ts-expect-error attach the field list so the client can focus the form
    err.details = { missing };
    throw err;
  }
  if (birth.time === null || birth.time === undefined) {
    // "I do not know my birth time" is a normal answer, but a kernel that cannot
    // represent an unknown hour pillar must not pretend to know one: defaulting
    // to 12:00 would silently fabricate the hour pillar and everything derived
    // from it. Refusing is the honest option until the real kernel lands.
    throw new KernelError('BIRTH_TIME_REQUIRED', 'birth.time is required by the current kernel (unknown-time charts need the real kernel)');
  }
  return birth;
}

/** Typed error body; `code` is the contract, `message` is a default rendering. */
function sendError(res, status, code, message, extra = {}) {
  sendJson(res, status, { code, message, status, ...extra });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Builds the server plus its stores, so tests can inspect internal state
 * (the ledger, the hub) without reaching into module-level singletons.
 *
 * @param {{frameDelayMs?: number, hub?: StreamHub, quota?: EntitlementStore, registry?: import('./tools.mjs').ToolRegistry, quotaLimits?: object, toolPlan?: object[]}} [opts]
 */
export function createServer(opts = {}) {
  // Storage is swappable: in-memory for tests and demos, SQLite for anything that
  // must survive a restart. Same method surface, so nothing downstream changes.
  // Durability is not cosmetic here — a resumable stream and an idempotent
  // request_id are both promises that outlive the process that made them.
  const hub = opts.hub ?? (process.env.SHENSHA_STORE === 'sqlite'
    ? new SqliteStreamHub(process.env.SHENSHA_DB ?? ':memory:')
    : new StreamHub());
  const quota = opts.quota ?? new EntitlementStore(opts.quotaLimits ? { limits: opts.quotaLimits } : {});
  const registry = opts.registry ?? buildDefaultRegistry();
  const frameDelayMs = opts.frameDelayMs ?? 0;

  // Session signing. With no secret configured the verifier generates an
  // ephemeral key: the demo stays usable, every restart invalidates sessions, and
  // `sessionEphemeral` is surfaced so the startup line can say so out loud rather
  // than leave a random key looking like a configured one.
  const session = opts.session ?? createSessionVerifier({
    secret: opts.sessionSecret ?? process.env.SHENSHA_SESSION_SECRET,
  });
  // Minting a session over HTTP is a development affordance, never a product
  // feature: an open mint endpoint would hand out identities and make every
  // ownership check meaningless again. Off unless explicitly enabled.
  const allowDevSessions = opts.allowDevSessions ?? process.env.SHENSHA_ALLOW_DEV_SESSION === '1';
  /** Identity for a request, using this server's verifier. */
  const authOf = (req) => resolvePrincipal(req, session);
  const authed = (req) => authOf(req).anonymous === false;
  /** 401 that tells the client WHY: expired means sign in again, malformed means a bug. */
  const unauthorized = (res, req) => {
    const { sessionError } = authOf(req);
    const code = sessionError ?? 'UNAUTHENTICATED';
    const message = code === 'SESSION_EXPIRED' ? 'session expired: sign in again' : 'authentication required';
    return sendError(res, 401, code, message);
  };

  // The model seam. With no provider configured the deterministic fixture runs,
  // so the whole product (streaming, resume, tools, quota) is exercisable
  // offline. With `SHENSHA_LLM_KEY` set, the real model drives the same code
  // path — one environment variable away, and nothing else changes.
  const chatStream = opts.chatStream ?? providerFromEnv();
  const narrationMode = chatStream ? (opts.chatStream ? 'model(injected)' : 'model(env)') : 'fixture';
  // Optional override of the narrator's canned tool calls. Production passes
  // nothing (the narrator plans its own calls); tests use it to feed the
  // registry arguments a model would plausibly get wrong.
  const toolPlan = opts.toolPlan;

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      // Last-resort handler: never leave a socket hanging, never leak a stack.
      if (!res.headersSent) sendError(res, err.status ?? 500, err.code ?? 'INTERNAL_SERVER_ERROR', err.message ?? 'unexpected error');
      else res.end();
    });
  });

  /** @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res */
  async function handle(req, res) {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname;
    const method = req.method ?? 'GET';

    if (method === 'POST' && path === '/api/agent/chat') return agentChat(req, res);
    if (method === 'POST' && path === '/api/session') return mintSessionRoute(req, res);
    if (method === 'GET' && path === '/api/access') return access(req, res);
    if (method === 'POST' && path === '/api/bazi-calculate') return baziCalculate(req, res);

    const chatPost = /^\/api\/v3\/([A-Za-z0-9._-]+)\/messages$/.exec(path);
    if (method === 'POST' && chatPost) return chatMessages(req, res, chatPost[1]);

    const chatResume = /^\/api\/v3\/([A-Za-z0-9._-]+)\/messages\/([A-Za-z0-9._-]+)\/stream$/.exec(path);
    if (method === 'GET' && chatResume) return chatResumeStream(req, res, chatResume[1], chatResume[2], url);

    return sendError(res, 404, 'NOT_FOUND', `no route for ${method} ${path}`);
  }

  // -------------------------------------------------------------------------
  // A) POST /api/agent/chat — NDJSON
  // -------------------------------------------------------------------------
  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  async function agentChat(req, res) {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      return sendError(res, err.code === 'PAYLOAD_TOO_LARGE' ? 413 : 400, err.code ?? 'INVALID_JSON', err.message);
    }
    const { conversationId = null, message, timezone = 'UTC', language = 'en' } = body ?? {};
    if (typeof message !== 'string' || message.trim() === '') {
      return sendError(res, 400, 'MESSAGE_REQUIRED', 'message must be a non-empty string');
    }

    // One condition, one answer (PROTOCOL.md §6): the SSE agent route already
    // answers "no credentials" with 401, so this route must too. Answering 403
    // "quota" here would send the user to a paywall when what they need is a
    // sign-in — and the anonymous access snapshot now agrees (signInRequired).
    if (!authed(req)) {
      return unauthorized(res, req);
    }

    // Quota by principal — never by anything the client asserts about its own
    // entitlement. A refusal here is a real HTTP status, because no stream has
    // started yet and a clean 4xx is the cheapest possible "no".
    const { principalId } = authOf(req);
    const verdict = quota.check(principalId, KIND.AGENT);
    if (!verdict.allowed) {
      const err = new QuotaError(/** @type {any} */ (verdict.code), verdict.reason);
      return sendError(res, err.status, err.code, err.message);
    }

    // PROTOCOL.md §4bis order: auth -> quota CHECK -> structure -> kernel -> charge.
    // Structure is validated before `consume` on purpose: a malformed `birth`
    // block must cost the user nothing, and the client should be able to fix the
    // form and retry with the same budget.
    let birth;
    try {
      birth = readBirth(body);
    } catch (err) {
      if (err instanceof KernelError) return sendError(res, err.status, err.code, err.message, err.details ?? {});
      throw err;
    }

    // Presence is not validity. Run the kernel once here so a bad date/time is a
    // clean 400 BEFORE the unit is charged: the user must be able to fix the form
    // and retry with the same budget.
    if (birth) {
      try {
        computeFacts(birth);
      } catch (err) {
        if (err instanceof KernelError) return sendError(res, err.status, err.code, err.message);
        throw err;
      }
    }
    quota.consume(principalId, KIND.AGENT, { messageId: conversationId ?? 'new' });

    // The deterministic kernel runs BEFORE any narration. Facts are resolved
    // once, here, and are the only input the narration layer will see.
    // PROTOCOL.md §4bis: structured `birth` is authoritative when present; when
    // it is absent the chart is an explicit demo placeholder, not a date guessed
    // out of prose that the user cannot audit.
    let facts;
    try {
      facts = computeFacts(birth ?? { date: extractDate(message), time: '12:00', timezone, gender: 'unspecified' });
    } catch (err) {
      if (err instanceof KernelError) {
        // Structured birth is the user's own data, so a kernel error means the
        // input is wrong. Answering from a placeholder here would hide that
        // behind plausible prose — the exact silent-wrong-chart failure that
        // PROTOCOL.md §4bis exists to prevent. Fail loudly instead.
        if (birth) return sendError(res, err.status, err.code, err.message);
        // Demo path only: a bad date guessed from prose should not kill the turn,
        // so the caller gets a clearly-marked placeholder instead of a hard error.
        facts = computeFacts({ date: '2000-01-01', time: '12:00', timezone });
      } else {
        throw err;
      }
    }
    if (!birth) {
      facts.notes = [...(facts.notes ?? []), 'chart source: DEMO placeholder derived from message text; a real client must send `birth` (PROTOCOL.md §4bis)'];
    }

    setCommonHeaders(res);
    // text/plain, NOT text/event-stream: the observed contract. `charset=utf-8`
    // matters because frames are split on '\n' after decoding, and a client that
    // guesses latin-1 will corrupt multi-byte text at a chunk boundary.
    res.writeHead(200, {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no', // tell intermediaries not to coalesce frames
      // Lets a client (and our own tests) tell an authoritative chart from a demo
      // placeholder without parsing prose.
      'x-chart-source': birth ? 'birth' : 'placeholder',
    });

    const abort = new AbortController();
    // Disconnect is expected, not exceptional: mark it and stop producing.
    req.on('aborted', () => abort.abort());
    res.on('close', () => {
      if (!res.writableEnded) abort.abort();
    });

    const frames = [];
    try {
      const stream = chatStream
        ? narrateWithModel({
          facts, registry, surface: 'almanac', chatStream,
          conversationId: conversationId ?? `conv_${Date.now().toString(36)}`,
          question: message,
          signal: abort.signal,
        })
        : narrate(facts, registry, {
          conversationId: conversationId ?? `conv_${Date.now().toString(36)}`,
          surface: 'almanac',
          toolPlan,
          frameDelayMs,
        });
      for await (const frame of stream) {
        if (res.writableEnded || abort.signal.aborted) break;
        frames.push(frame);
        res.write(encodeNdjson(frame));
      }
      // A liveness frame at the end of every response: protocol-legal to ignore,
      // and it distinguishes "server finished cleanly" from "proxy cut me off".
      if (!res.writableEnded && !abort.signal.aborted) res.write(encodeNdjson(agentFrames.keepAlive()));
      res.end();
    } catch (err) {
      // Headers are already sent, so the failure has to travel as a frame.
      // The client renders it instead of hanging on a silent dead socket.
      if (!res.writableEnded) {
        res.write(encodeNdjson(agentFrames.error(err.message ?? 'generation failed', { code: err.code ?? 'INTERNAL_SERVER_ERROR' })));
        res.end();
      }
    }
  }

  // -------------------------------------------------------------------------
  // B) POST /api/v3/:channel/messages — SSE
  // -------------------------------------------------------------------------
  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {string} channel
   */
  async function chatMessages(req, res, channel) {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      return sendError(res, err.code === 'PAYLOAD_TOO_LARGE' ? 413 : 400, err.code ?? 'INVALID_JSON', err.message);
    }
    const { content, conversation_id: conversationId = '', archive_id: archiveId = '', request_id: requestId = '' } = body ?? {};
    if (typeof content !== 'string' || content.trim() === '') {
      return sendError(res, 400, 'CONTENT_REQUIRED', 'content must be a non-empty string');
    }

    // 401 before 403: an unauthenticated chat client must be told to sign in,
    // not told it is out of quota — the remedies are different.
    if (!authed(req)) {
      return unauthorized(res, req);
    }

    const { principalId } = authOf(req);

    // Idempotency BEFORE quota (PROTOCOL.md §5): the original request already paid
    // for this answer, so a retry must replay it even if the budget is now spent.
    // Creating a second message here would both double-charge and hand the user a
    // second, differently-worded answer to the same question.
    const existing = requestId ? hub.findByRequestId(channel, requestId) : null;
    if (existing && existing.principalId === principalId) {
      return chatResumeStream(req, res, channel, existing.messageId, new URL('http://localhost/?from_seq=0'));
    }

    const verdict = quota.check(principalId, KIND.AGENT);
    if (!verdict.allowed) {
      const err = new QuotaError(/** @type {any} */ (verdict.code), verdict.reason);
      return sendError(res, err.status, err.code, err.message);
    }

    // PROTOCOL.md §4bis order: auth -> quota -> STRUCTURE -> kernel. Validating
    // here (after the check, before consume) means a malformed birth block costs
    // the user nothing.
    let birth;
    try {
      birth = readBirth(body);
    } catch (err) {
      if (err instanceof KernelError) return sendError(res, err.status, err.code, err.message, err.details ?? {});
      throw err;
    }

    // Presence is not validity: run the kernel once here so a bad date or time is
    // a clean 400 BEFORE a message row exists or a byte of SSE is written.
    // Otherwise the failure would surface mid-stream, after the unit was charged.
    if (birth) {
      try {
        computeFacts(birth);
      } catch (err) {
        if (err instanceof KernelError) return sendError(res, err.status, err.code, err.message);
        throw err;
      }
    }

    // The message row is created (and the unit charged) exactly once, before the
    // first byte is written. A reconnect resumes this id; it does not create a
    // second message and therefore is not a second charge.
    const message = hub.createMessage({ channel, conversationId, archiveId, requestId, principalId });
    quota.consume(principalId, KIND.AGENT, { messageId: message.messageId });

    setCommonHeaders(res);
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      // The client may not know the messageId until the first frame; the header
      // lets a client that died before frame 1 still resume instead of regenerate.
      'x-message-id': message.messageId,
      'x-chart-source': birth ? 'birth' : 'placeholder',
    });

    const abort = new AbortController();
    req.on('aborted', () => abort.abort());
    res.on('close', () => {
      if (!res.writableEnded) abort.abort();
    });

    try {
      await runChatStream(res, message, { content, conversationId, archiveId, birth }, abort.signal);
    } catch (err) {
      if (message.status === 'open') hub.markError(message.messageId, err.message);
      if (!res.writableEnded) {
        res.write(encodeSse({ messageId: message.messageId, seq: message.frames.length + 1, retryable: true, msg: { event: 'error', code: 'INTERNAL_SERVER_ERROR', message: err.message } }));
        res.write(encodeSseDone());
        res.end();
      }
    }
  }

  /**
   * Drives one message from narration frames into hub-stored SSE frames.
   *
   * Every frame is appended to the hub *before* (well, at the same moment as)
   * it is written, so a resume replays exactly what was sent — there is no
   * window where a frame is on the wire but not in the store.
   */
  async function runChatStream(res, message, request, signal) {
    // Structured birth wins (PROTOCOL.md §4bis). Without it the chart is a demo
    // placeholder and says so in the facts' notes, so no reader can mistake a
    // regex-extracted date for the user's real birth data.
    const facts = request.birth
      ? computeFacts(request.birth)
      : computeFacts({ date: extractDate(request.content), time: '12:00', timezone: 'UTC' });
    if (!request.birth) {
      facts.notes = [...(facts.notes ?? []), 'chart source: DEMO placeholder derived from message text; a real client must send `birth` (PROTOCOL.md §4bis)'];
    }
    // Two narration sources behind one interface: a configured model provider,
    // or the deterministic fixture. Everything downstream — seq, resume, the
    // terminal frame, quota — is identical, which is the point of the seam.
    const source = chatStream
      ? narrateWithModel({
        facts, registry, surface: 'almanac', chatStream,
        conversationId: message.conversationId || 'conv_demo',
        question: request.content ?? '',
        signal,
      })
      : narrate(facts, registry, {
        conversationId: message.conversationId || 'conv_demo', surface: 'almanac', toolPlan, frameDelayMs,
      });

    // start — announces messageId (for reconnect) and the channel's title.
    write(hub.append(message.messageId, { event: 'start', msg: { conversationId: message.conversationId, messageId: message.messageId, channel: message.channel } }));

    // Streamed rather than collected: a long answer must reach the client while
    // it is still being written. The terminal frame still carries the full text,
    // so a client that rejoins mid-message renders the whole answer at once.
    const chunks = [];
    for await (const frame of source) {
      if (signal.aborted || res.writableEnded) {
        // Client left. Record it so a later resume can distinguish "aborted" from
        // "still generating" — but do NOT invent an error frame the client never saw.
        if (message.status === 'open') hub.markError(message.messageId, 'client_disconnected');
        return;
      }
      const mapped = toChatEvent(frame);
      if (!mapped) continue;
      if (mapped.event === CHAT_EVENT.MESSAGE) chunks.push(mapped.msg?.delta ?? '');
      write(hub.append(message.messageId, { event: mapped.event, msg: mapped.msg, retryable: mapped.retryable }));
    }

    if (message.status === 'open') {
      write(hub.append(message.messageId, {
        event: 'end',
        msg: { content: chunks.join(''), state: { ...message.state } },
        retryable: false,
      }));
    }
    res.write(encodeSseDone());
    res.end();

    /** @param {object} frame */
    function write(frame) {
      if (!res.writableEnded) res.write(encodeSse(frame));
    }
  }

  // -------------------------------------------------------------------------
  // B') GET /api/v3/:channel/messages/:messageId/stream?from_seq=N — resume
  // -------------------------------------------------------------------------
  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {string} channel
   * @param {string} messageId
   * @param {URL} url
   */
  async function chatResumeStream(req, res, channel, messageId, url) {
    if (!authed(req)) return unauthorized(res, req);

    const rawFrom = url.searchParams.get('from_seq');
    const fromSeq = rawFrom === null ? 0 : Number(rawFrom);
    if (!Number.isInteger(fromSeq) || fromSeq < 0) {
      return sendError(res, 400, 'INVALID_FROM_SEQ', 'from_seq must be a non-negative integer');
    }

    let result;
    try {
      const described = hub.describe(messageId);
      if (described.channel !== channel) {
        return sendError(res, 404, 'MESSAGE_NOT_FOUND', `message ${messageId} is not on channel ${channel}`);
      }
      // A messageId is a resumable-resource name, not a bearer credential:
      // another account must not be able to read this answer by guessing it.
      const { principalId } = authOf(req);
      if (described.principalId && described.principalId !== principalId) {
        return sendError(res, 404, 'MESSAGE_NOT_FOUND', `message ${messageId} is not on channel ${channel}`);
      }
      result = hub.resumeFrom(messageId, fromSeq);
    } catch (err) {
      if (err instanceof StreamHubError) return sendError(res, err.status, err.code, err.message);
      throw err;
    }

    setCommonHeaders(res);
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'x-message-id': messageId,
      'x-last-seq': String(result.lastSeq),
      'x-stream-status': result.status,
    });

    // Exclusive cursor: the client sends the last seq it *rendered*, so
    // `seq > from_seq` is what guarantees no duplicate. Contiguity of stored
    // frames is what guarantees no gap.
    for (const frame of result.frames) res.write(encodeSse(frame));

    if (result.terminal) {
      // Already finished: replay the tail, re-send the terminal frame (it is in
      // `frames` iff seq > from_seq), then close. The connection must not stay
      // open waiting for a message that can never grow.
      res.write(encodeSseDone());
      res.end();
      return;
    }

    // Still generating. Poll the store rather than keeping a subscriber list:
    // the store is the single source of truth, and a poller that catches up on
    // missed appends is simpler to reason about than a fan-out that can leak.
    const abort = new AbortController();
    req.on('aborted', () => abort.abort());
    res.on('close', () => abort.abort());
    let cursor = result.lastSeq;
    const deadline = Date.now() + 120_000; // matches CHAT_RETRY_POLICY.maxDurationMs
    while (!abort.signal.aborted && Date.now() < deadline) {
      await sleep(25);
      const next = hub.resumeFrom(messageId, cursor);
      for (const frame of next.frames) {
        res.write(encodeSse(frame));
        cursor = frame.seq;
      }
      if (next.terminal) {
        res.write(encodeSseDone());
        res.end();
        return;
      }
      if (next.status !== 'open') {
        // The producer stopped without writing a terminal frame (usually because
        // the first client vanished mid-stream). Persist an explicit terminal
        // frame, then replay it, so this message can never produce a second,
        // different ending.
        hub.appendTerminalIfStranded(messageId, {
          event: CHAT_EVENT.ERROR,
          msg: { code: 'UPSTREAM_ABORTED', message: 'generation ended before completion; retryable' },
          retryable: true,
        });
        for (const frame of hub.resumeFrom(messageId, cursor).frames) {
          res.write(encodeSse(frame));
          cursor = frame.seq;
        }
        res.write(encodeSseDone());
        res.end();
        return;
      }
    }
    if (!res.writableEnded) {
      res.write(encodeSseDone());
      res.end();
    }
  }

  // -------------------------------------------------------------------------
  // C') POST /api/session — development mint, disabled unless asked for.
  //
  // Disabled responses are 404, not 403: a probe should not learn that the route
  // exists, let alone that it is merely switched off.
  async function mintSessionRoute(req, res) {
    if (!allowDevSessions) return sendError(res, 404, 'NOT_FOUND', 'no such endpoint');
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      return sendError(res, err.code === 'PAYLOAD_TOO_LARGE' ? 413 : 400, err.code ?? 'INVALID_JSON', err.message);
    }
    const sub = body?.sub;
    if (typeof sub !== 'string' || sub.trim() === '' || sub.length > 64) {
      return sendError(res, 400, 'SUBJECT_REQUIRED', 'sub must be a non-empty string of at most 64 characters');
    }
    const ttlSeconds = Number.isInteger(body?.ttlSeconds) && body.ttlSeconds > 0 && body.ttlSeconds <= 86400
      ? body.ttlSeconds
      : 3600;
    const token = session.mint({ sub: sub.trim(), ttlSeconds });
    const { exp } = session.verify(token);
    setCommonHeaders(res);
    return sendJson(res, 200, { token, exp, tokenType: 'Bearer' });
  }

  // D) GET /api/access
  // -------------------------------------------------------------------------
  async function access(req, res) {
    const { principalId } = authOf(req);
    // Always re-derived from the store. The client's cached copy is for first
    // paint only and is never an input to this response.
    return sendJson(res, 200, quota.accessSnapshot(principalId));
  }

  // -------------------------------------------------------------------------
  // E) POST /api/bazi-calculate — deterministic path, no model involved
  // -------------------------------------------------------------------------
  async function baziCalculate(req, res) {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      return sendError(res, err.code === 'PAYLOAD_TOO_LARGE' ? 413 : 400, err.code ?? 'INVALID_JSON', err.message);
    }

    const { principalId } = authOf(req);
    const verdict = quota.check(principalId, KIND.CALC);
    if (!verdict.allowed) {
      const err = new QuotaError(/** @type {any} */ (verdict.code), verdict.reason);
      return sendError(res, err.status, err.code, err.message);
    }

    let facts;
    try {
      facts = computeFacts(body);
    } catch (err) {
      if (err instanceof KernelError) return sendError(res, err.status, err.code, err.message);
      throw err;
    }
    quota.consume(principalId, KIND.CALC, { messageId: body?.requestId ?? 'calc' });

    // The prompt block is returned so the deterministic->narration handoff is
    // inspectable: you can see exactly what the model would have been told.
    return sendJson(res, 200, { facts, narrationPrompt: narrationPrompt(facts) });
  }

  return Object.assign(server, { hub, quota, registry, createServer, narrationMode, chatStream, session, sessionEphemeral: session.ephemeral });
}

/**
 * Builds a model provider from the environment, or returns null for fixture mode.
 *
 * The key is read here and nowhere else, and it is never logged: a missing key
 * means "run the deterministic fixture", not "crash", so the product stays
 * demonstrable without credentials.
 */
export function providerFromEnv(env = process.env) {
  const apiKey = env.SHENSHA_LLM_KEY;
  if (!apiKey) return null;
  return createChatStream({
    baseUrl: env.SHENSHA_LLM_BASE_URL ?? 'https://api.deepseek.com/v1',
    apiKey,
    model: env.SHENSHA_LLM_MODEL ?? 'deepseek-chat',
  });
}

/**
 * Best-effort date extraction from a free-text message.
 *
 * Explicitly the *only* text interpretation this skeleton does, and it is
 * deliberately dumb: a real implementation asks the model for structured
 * arguments (a tool call) or asks the user, then runs the kernel on those. It
 * must never let the model's guess become the authoritative date.
 *
 * @param {string} message
 * @returns {string} YYYY-MM-DD
 */
export function extractDate(message) {
  const m = /(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(message ?? '');
  if (!m) return '2000-01-01';
  const [, y, mo, d] = m;
  return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

/** Starts a server on an ephemeral port and resolves once it is listening. */
export function listen(opts = {}) {
  const server = createServer(opts);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ server, port, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

// Started directly (not imported by a test): listen on a fixed port.
if (process.argv[1] && import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`) {
  const port = Number(process.env.PORT ?? 8787);
  const { frameDelayMs = '40' } = process.env;
  const server = createServer({ frameDelayMs: Number(frameDelayMs) });
  server.listen(port, '127.0.0.1', () => {
    console.log(`reference skeleton listening on http://127.0.0.1:${port}`);
  });
}

export { AGENT_FRAME, agentFrames };
export default { createServer, listen };
