// Normalize any REA capture-browser-scenario output into {kind,capture} JSON.
import fs from "node:fs";
const [,, src, dest] = process.argv;
const j = JSON.parse(fs.readFileSync(src, "utf8"));
const cap = j?.normalized_result ?? j?.details?.partial_observation?.capture ?? j?.capture ?? j?.result?.capture;
if (!cap || !cap.steps) { console.error("no capture in " + src + " keys=" + Object.keys(j).join(",")); process.exit(2); }
fs.writeFileSync(dest, JSON.stringify({ kind: "browser-scenario-observation", capture: cap }, null, 1));
console.log(src + " -> " + dest + " steps=" + cap.steps.length + " events=" + (cap.events?.items?.length ?? 0) + " cleanup=" + (cap.browser?.cleanup ?? "?"));
