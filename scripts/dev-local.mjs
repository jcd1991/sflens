import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const children = [
  ["web", ["run", "dev", "-w", "@sflens/web"]],
  ["bridge", ["run", "dev", "-w", "@sflens/bridge"]],
].map(([name, args]) => {
  const child = spawn(npm, args, { cwd: root, stdio: "inherit", env: process.env });
  child.on("error", (error) => console.error(`[${name}] ${error.message}`));
  return child;
});

let shuttingDown = false;
const shutdown = (signal = "SIGTERM") => {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) if (!child.killed) child.kill(signal);
};

for (const child of children) {
  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    shutdown();
    process.exitCode = code ?? (signal ? 1 : 0);
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
