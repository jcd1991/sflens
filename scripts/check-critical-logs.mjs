import fs from "node:fs";
import { parseLog } from "../packages/core/dist/index.js";

const args = process.argv.slice(2);
const baselineIndex = args.indexOf("--baseline");
const baselineFile = baselineIndex >= 0 ? args[baselineIndex + 1] : undefined;
const files = args.filter((file, index) => file !== "--baseline" && index !== baselineIndex + 1 && fs.existsSync(file));
if (!files.length) process.exit(0);
const baselineRules = new Set(baselineFile && fs.existsSync(baselineFile) ? parseLog(fs.readFileSync(baselineFile, "utf8"), { source: "upload", name: baselineFile }).findings.map((finding) => finding.ruleId) : []);
const findings = files.flatMap((file) => parseLog(fs.readFileSync(file, "utf8"), { source: "upload", name: file }).findings.filter((finding) => finding.severity === "critical" && !baselineRules.has(finding.ruleId)).map((finding) => ({ file, ruleId: finding.ruleId, title: finding.title, line: finding.evidence[0]?.lineStart })));
console.log(JSON.stringify({ files: files.length, baseline: baselineFile || null, newCriticalFindings: findings }, null, 2));
if (findings.length) process.exit(1);
