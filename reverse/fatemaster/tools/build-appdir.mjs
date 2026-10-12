// Map captured response bodies (raw/<page>/bodies/*) back to their URLs and copy
// JavaScript payloads into a flat "app" directory for analyze-javascript-application.
import fs from "node:fs";
import path from "node:path";
const [,, pageDir, outDir] = process.argv;
fs.mkdirSync(outDir, { recursive: true });
const net = JSON.parse(fs.readFileSync(path.join(pageDir, "network.json"), "utf8"));
const manifest = [];
const seen = new Set();
for (const r of net) {
  if (!r.response_body || !r.response_body.startsWith("bodies/")) continue;
  const src = path.join(pageDir, r.response_body);
  if (!fs.existsSync(src)) continue;
  const u = new URL(r.url);
  let p = decodeURIComponent(u.pathname);
  if (!/\.(m?js|json|txt)$/.test(p)) continue;
  let name = p.replace(/^\/+/, "").replace(/[?&=]/g, "_");
  if (seen.has(name)) name = name.replace(/(\.\w+)$/, "-dup$1");
  seen.add(name);
  const dest = path.join(outDir, name);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  manifest.push({ url: r.url, file: path.relative(outDir, dest), bytes: fs.statSync(dest).size });
}
fs.writeFileSync(path.join(outDir, "_manifest.json"), JSON.stringify(manifest, null, 1));
console.log("files:", manifest.length);
