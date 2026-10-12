// Extract every next-intl `messages` namespace group from Next.js RSC flight payloads in HTML and merge.
import fs from "node:fs";
const [,, file, out] = process.argv;
const s = fs.readFileSync(file, "utf8");
function braceSlice(text, i) {
  let start = i, depth = 0, j = start, inStr = false, esc = false;
  for (; j < text.length; j++) {
    const c = text[j];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; continue; }
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) { j++; break; } }
  }
  return text.slice(start, j);
}
const merged = {};
const collect = (text) => {
  let p = -1;
  while ((p = text.indexOf('"messages":', p + 1)) !== -1) {
    const braceAt = text.indexOf("{", p);
    if (braceAt < 0) break;
    const slice = braceSlice(text, braceAt);
    try {
      const obj = JSON.parse(slice);
      for (const [k, v] of Object.entries(obj)) {
        if (v && typeof v === "object" && !Array.isArray(v)) {
          merged[k] = { ...(merged[k] && typeof merged[k] === "object" ? merged[k] : {}), ...v };
        } else if (!(k in merged)) merged[k] = v;
      }
    } catch {}
  }
};
const re = /self\.__next_f\.push\(\[1,\s*("(?:[^"\\]|\\.)*")\s*\]\)/g;
let m;
while ((m = re.exec(s)) !== null) { try { collect(JSON.parse(m[1])); } catch {} }
if (Object.keys(merged).length === 0) collect(s);
fs.writeFileSync(out, JSON.stringify(merged, null, 1));
console.log("namespaces:", Object.keys(merged).length);
for (const k of Object.keys(merged)) console.log("  -", k, "(" + Object.keys(merged[k] || {}).length + ")");
