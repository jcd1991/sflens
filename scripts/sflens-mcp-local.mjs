import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bridge = spawn("npm", ["run", "dev", "-w", "@sflens/bridge"], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
let buffer = Buffer.alloc(0), child;
const pending = [];
const startMcp = (startupToken) => {
  if (child) return;
  child = spawn("node", [path.join(root, "apps/mcp/dist/index.js")], { cwd: root, env: { ...process.env, SFLENS_BRIDGE_URL: "http://127.0.0.1:8787", SFLENS_BRIDGE_TOKEN: startupToken, SFLENS_ORG_ALIAS: process.env.SFLENS_ORG_ALIAS || "sflens-personal" }, stdio: ["pipe", "pipe", "pipe"] });
  for (const chunk of pending.splice(0)) child.stdin.write(chunk);
  child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
  child.on("exit", (code) => { bridge.kill("SIGTERM"); process.exit(code || 0); });
};
bridge.stdout.on("data", (chunk) => { buffer = Buffer.concat([buffer, chunk]); const match = buffer.toString().match(/token=([a-f0-9-]+)/i); if (match) startMcp(match[1]); });
bridge.stderr.on("data", () => {});
process.stdin.on("data", (chunk) => { if (child) child.stdin.write(chunk); else pending.push(chunk); });
process.on("exit", () => bridge.kill("SIGTERM"));
