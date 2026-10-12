/**
 * demo-resume.mjs — runnable proof of the resume contract, for the README.
 *
 *   node src/../demo-resume.mjs            # uses http://127.0.0.1:8791
 *
 * It renders only the first 3 frames of a live SSE message, closes the socket
 * the way a browser does when a tab is closed mid-answer, then reconnects with
 * `?from_seq=<last rendered seq>` and prints what came back. The output shows
 * the two halves stitching into a gapless run.
 */
import { SseParser } from './src/frames.mjs';

const BASE = process.env.BASE ?? 'http://127.0.0.1:8791';
const AUTH = { authorization: `Bearer ${process.env.TOKEN ?? 'demo-resume'}` };

function parser() {
  return new SseParser();
}

const post = await fetch(`${BASE}/api/v3/zhouyi-bagua/messages`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...AUTH },
  body: JSON.stringify({ content: 'explain 2000-01-01', conversation_id: 'conv-resume', archive_id: 'a', request_id: 'r' }),
});
if (!post.ok) {
  // Quota is per principal, so a re-run against a long-lived server can be
  // refused before the stream starts. Say so plainly instead of crashing.
  console.error(`POST refused: HTTP ${post.status} ${await post.text()}`);
  console.error('start a fresh server (or use a different authorization token) and retry.');
  process.exit(1);
}
const messageId = post.headers.get('x-message-id');
console.log(`POST  /api/v3/zhouyi-bagua/messages      -> 200, x-message-id: ${messageId}`);

// Render exactly 3 frames, then abandon the connection.
const p = parser();
const rendered = [];
const reader = post.body.getReader();
while (rendered.length < 3) {
  const { value, done } = await reader.read();
  if (done) break;
  rendered.push(...p.push(Buffer.from(value).toString('utf8')));
}
rendered.length = 3;
await reader.cancel().catch(() => {});
const cursor = rendered.at(-1).seq;
console.log(`  rendered seq ${rendered.map((f) => f.seq).join(',')}  (last event: ${rendered.at(-1).msg.event})`);
console.log('  connection abandoned here (this is the part that normally loses the answer)');

await new Promise((r) => setTimeout(r, 50));

const res = await fetch(`${BASE}/api/v3/zhouyi-bagua/messages/${messageId}/stream?from_seq=${cursor}`, { headers: AUTH });
console.log(`GET   .../messages/${messageId}/stream?from_seq=${cursor} -> ${res.status}, x-stream-status: ${res.headers.get('x-stream-status')}`);
const p2 = parser();
const resumed = [];
for await (const chunk of res.body) resumed.push(...p2.push(Buffer.from(chunk).toString('utf8')));
const end = resumed.findIndex((f) => f.msg.event === 'end' || f.msg.event === 'error');
const tail = end === -1 ? resumed : resumed.slice(0, end + 1);
console.log(`  resumed seq ${tail[0].seq}..${tail.at(-1).seq}  (terminal event: ${tail.at(-1).msg.event})`);

const union = [...rendered.map((f) => f.seq), ...tail.map((f) => f.seq)];
const gapless = union.every((s, i) => s === i + 1);
console.log(`  union seq ${union[0]}..${union.at(-1)} — gapless: ${gapless}, duplicates: ${union.length !== new Set(union).size}`);
