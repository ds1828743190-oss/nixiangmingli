// Summarize a REA browser-scenario capture JSON.
// Usage: node summarize.mjs <capture.json> <outDir>
import fs from "node:fs";
import path from "node:path";

const file = process.argv[2];
const outDir = process.argv[3] || ".";
fs.mkdirSync(outDir, { recursive: true });
const raw = JSON.parse(fs.readFileSync(file, "utf8"));
const cap = raw?.details?.partial_observation?.capture ?? raw?.capture ?? raw;
const ev = cap.events?.items ?? [];
const L = [];
const P = (s = "") => L.push(s);

P("# capture summary: " + path.basename(file));
const b = cap.browser ?? {};
P("- browser: " + b.product + " " + b.version + " mode=" + b.mode + " cleanup=" + JSON.stringify(b.cleanup));
P("- duration_ms: " + cap.duration_ms);
P("- scenario: " + JSON.stringify(cap.scenario));
P("- events retained=" + cap.events?.retained + " dropped=" + cap.events?.dropped);
P("- limitations:");
for (const x of cap.limitations ?? []) P("  - " + x);
P();

P("## steps");
for (const s of cap.steps ?? []) {
  P(`- [${s.step_index}] ${s.action} ${s.step_id} status=${s.status} elapsed=${s.elapsed_ms}ms`);
  P(`    before=${s.before_url}`);
  P(`    after =${s.after_url}`);
  if (s.error) P("    error=" + JSON.stringify(s.error).slice(0, 400));
  P("    artifacts: " + Object.entries(s.artifacts ?? {}).map(([k, v]) => `${k}=${v?.state}`).join(", "));
  for (const [kind, a] of Object.entries(s.artifacts ?? {})) {
    if (a?.state !== "captured") continue;
    const v = a.value ?? a;
    const base = path.join(outDir, `artifact-step${s.step_index}-${kind}`);
    if (typeof v === "string") { fs.writeFileSync(base + ".txt", v); P(`      -> ${base}.txt (${v.length} chars)`); }
    else if (v?.data_base64) {
      const mt = v.media_type ?? a.media_type ?? "";
      const ext = mt.includes("png") ? "png" : mt.includes("json") ? "json" : "bin";
      fs.writeFileSync(base + "." + ext, Buffer.from(v.data_base64, "base64"));
      P(`      -> ${base}.${ext} (${v.bytes} bytes ${mt})`);
    } else { fs.writeFileSync(base + ".json", JSON.stringify(v, null, 1)); P(`      -> ${base}.json`); }
  }
}

// network pairing
const byId = new Map();
for (const e of ev) {
  const id = e.transaction_id;
  if (!id) continue;
  if (!byId.has(id)) byId.set(id, {});
  const s = byId.get(id);
  s[e.kind === "network-content" ? "content_" + e.phase : e.kind] = e;
}
P();
P("## network transactions: " + byId.size);
const rows = [];
const bodyDir = path.join(outDir, "bodies");
fs.mkdirSync(bodyDir, { recursive: true });
let n = 0;
for (const [id, s] of byId) {
  const req = s.request, res = s.response, fin = s["request-finished"], fail = s["request-failed"];
  const url = req?.url?.url ?? res?.url?.url ?? "";
  const status = res?.status ?? fin?.status ?? (fail ? "FAILED" : "");
  const rc = s.content_response?.body, qc = s.content_request?.body;
  const mediaType = rc?.media_type ?? "";
  const ct = mediaType || res?.header_values?.["content-type"] || "";
  let bp = "";
  const rawBytes = (bd) => {
    if (!bd) return null;
    if (bd.state !== "captured") return null;
    if (bd.encoding === "base64" && typeof bd.content === "string") return Buffer.from(bd.content, "base64");
    if (bd.encoding === "utf8" && typeof bd.content === "string") return Buffer.from(bd.content, "utf8");
    if (typeof bd.text === "string") return Buffer.from(bd.text, "utf8");
    return null;
  };
  const buf = rawBytes(rc);
  if (buf) {
    const mt = rc.media_type || "";
    const ext = mt.includes("json") ? "json" : mt.includes("javascript") || mt.includes("ecmascript") ? "js"
      : mt.includes("css") ? "css" : mt.includes("html") ? "html" : mt.includes("text") ? "txt" : "bin";
    const name = `${String(n++).padStart(3, "0")}-${id.replace(/[^\w.-]/g, "_")}.${ext}`;
    fs.writeFileSync(path.join(bodyDir, name), buf);
    bp = "bodies/" + name;
  } else bp = rc ? rc.state : "not_requested";
  rows.push({ id, method: req?.method ?? "", status, resource_type: req?.resource_type ?? "", content_type: ct, media_type: mediaType, url, response_body: bp, request_body_state: qc?.state ?? "not_requested" });
}
rows.sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
P("| method | status | type | content-type | resp-body | url |");
P("|---|---|---|---|---|---|");
for (const r of rows) P(`| ${r.method} | ${r.status} | ${r.resource_type} | ${r.content_type} | ${r.response_body} | ${r.url} |`);
fs.writeFileSync(path.join(outDir, "network.json"), JSON.stringify(rows, null, 1));

P();
P("## console / page errors");
for (const e of ev.filter(x => x.kind === "console" || x.kind === "page-error" || x.kind === "pageerror")) P("- " + JSON.stringify(e).slice(0, 500));

P();
P("## websockets / workers / frames");
for (const e of ev.filter(x => ["websocket", "worker", "frame-navigated", "popup", "download"].includes(x.kind))) P("- " + e.kind + " " + JSON.stringify(e).slice(0, 400));

fs.writeFileSync(path.join(outDir, "summary.md"), L.join("\n"));
console.log("ok -> " + path.join(outDir, "summary.md"));
