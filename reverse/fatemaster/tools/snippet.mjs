// Search captured bodies for a regex; emit file:offset: context. Usage:
//   node snippet.mjs <regex> <files...> [--width 200] [--max 40]
import fs from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
let width = 240, max = 30, i = 0;
const pat = args[i++];
const files = [];
for (; i < args.length; i++) {
  if (args[i] === "--width") width = Number(args[++i]);
  else if (args[i] === "--max") max = Number(args[++i]);
  else files.push(args[i]);
}
const re = new RegExp(pat, "g");
let total = 0;
for (const f of files) {
  const s = fs.readFileSync(f, "utf8");
  let m;
  re.lastIndex = 0;
  let n = 0;
  while ((m = re.exec(s)) !== null && n < max) {
    const start = Math.max(0, m.index - Math.floor(width / 3));
    const end = Math.min(s.length, m.index + m[0].length + Math.floor(width * 2 / 3));
    const line = s.slice(0, m.index).split("\n").length;
    console.log(`### ${f}  offset=${m.index} line=${line}`);
    console.log(s.slice(start, end).replace(/\n/g, "\\n"));
    console.log();
    n++; total++;
    if (m.index === re.lastIndex) re.lastIndex++;
  }
}
console.error("matches:", total);
