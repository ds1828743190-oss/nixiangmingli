// Minimal MCP stdio probe: initialize -> tools/list against the REA server.
// Independent of DSH, so a failure here is REA's, and a success here is not
// yet proof that DSH registered it.
import { spawn } from "node:child_process";

const NODE = "/Users/xiaolv/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node";
const REA = "/Users/xiaolv/Documents/deepseek-harness/default-workspace/rea/toolchain/node_modules/rea-agents/scripts/rea.mjs";

const child = spawn(NODE, [REA, "mcp"], {
  stdio: ["pipe", "pipe", "pipe"],
  env: {
    ...process.env,
    REA_MCP_INPUT_SCHEMA_PROFILE: process.env.REA_MCP_INPUT_SCHEMA_PROFILE ?? "compact",
    REA_LOG_LEVEL: "warn",
    REA_BROWSER_EXECUTABLE: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  },
});

const pending = new Map();
let buf = "";
let stderrTail = "";
child.stdout.on("data", (d) => {
  buf += d.toString("utf8");
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});
child.stderr.on("data", (d) => { stderrTail = (stderrTail + d.toString("utf8")).slice(-4000); });
child.on("exit", (code, sig) => {
  if ([...pending.keys()].length) console.log(JSON.stringify({ event: "server_exit", code, sig, stderrTail }));
});

function request(id, method, params) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 60000);
    pending.set(id, (m) => { clearTimeout(t); resolve(m); });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

const init = await request(1, "initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "dsh-rea-probe", version: "1.0.0" },
});
child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

const list = await request(2, "tools/list", {});
const tools = list.result?.tools ?? [];

console.log(JSON.stringify({
  probe: "ok",
  protocolVersion: init.result?.protocolVersion,
  serverInfo: init.result?.serverInfo,
  instructionsBytes: init.result?.instructions ? Buffer.byteLength(init.result.instructions) : 0,
  toolCount: tools.length,
  browserTools: tools.map((t) => t.name).filter((n) => /web|browser|script|capture/i.test(n)).sort(),
}, null, 2));

child.kill("SIGTERM");
setTimeout(() => process.exit(0), 500);
