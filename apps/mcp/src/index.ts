import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { comparePerformance, correlateTransactions, demoLog, incidentBundle, parseLog, redact, type ParsedLog, type RemoteLogSummary } from "@sflens/core";

const bridge = process.env.SFLENS_BRIDGE_URL;
const token = process.env.SFLENS_BRIDGE_TOKEN;
const alias = process.env.SFLENS_ORG_ALIAS;
const connected = Boolean(bridge && token && alias);
type Args = Record<string, unknown>;
const schemas: Record<string, object> = {
  list_debug_logs: { type: "object", properties: { limit: { type: "number", description: "Maximum 100 logs" } }, additionalProperties: false },
  get_log_summary: { type: "object", properties: { logId: { type: "string" } }, required: ["logId"], additionalProperties: false },
  get_log_excerpt: { type: "object", properties: { logId: { type: "string" }, query: { type: "string" }, limit: { type: "number" } }, required: ["logId"], additionalProperties: false },
  search_debug_logs: { type: "object", properties: { logId: { type: "string" }, query: { type: "string" }, limit: { type: "number" } }, required: ["query"], additionalProperties: false },
  analyze_debug_log: { type: "object", properties: { logId: { type: "string" } }, required: ["logId"], additionalProperties: false },
  compare_debug_logs: { type: "object", properties: { baselineLogId: { type: "string" }, candidateLogId: { type: "string" } }, required: ["baselineLogId", "candidateLogId"], additionalProperties: false },
  create_reproduction_checklist: { type: "object", properties: { logId: { type: "string" } }, required: ["logId"], additionalProperties: false },
  export_incident_bundle: { type: "object", properties: { logId: { type: "string" }, format: { type: "string", enum: ["json", "html", "sarif"] } }, required: ["logId", "format"], additionalProperties: false },
};
const tools = Object.keys(schemas).map((name) => ({ name, description: `${name.replaceAll("_", " ")} (${connected ? "connected read-only org logs" : "synthetic demo fixture"})`, inputSchema: schemas[name] }));
async function bridgeGet(path: string): Promise<any> { const response = await fetch(`${bridge}${path}`, { headers: { "x-sflens-token": token! } }); if (!response.ok) throw new Error("BRIDGE_REQUEST_FAILED"); return response.json(); }
async function summaries(limit = 50): Promise<RemoteLogSummary[]> { if (!connected) return [{ id: "local-log", name: "demo.log", orgAlias: "fixture" }]; const data = await bridgeGet(`/orgs/${encodeURIComponent(alias!)}/logs?limit=${Math.min(100, Math.max(1, limit))}`); return data.records || []; }
async function load(logId: string): Promise<{ summary: RemoteLogSummary; parsed: ParsedLog }> { if (!connected) return { summary: { id: "local-log", name: "demo.log", orgAlias: "fixture" }, parsed: parseLog(demoLog, { source: "fixture", name: "demo.log" }) }; const list = await summaries(100); const summary = list.find((item) => item.id === logId); if (!summary) throw new Error("LOG_NOT_FOUND"); const data = await bridgeGet(`/orgs/${encodeURIComponent(alias!)}/logs/${encodeURIComponent(logId)}/body`); const raw = typeof data === "string" ? data : data.body || ""; return { summary, parsed: parseLog(raw, { source: "salesforce", id: logId, name: summary.name, user: summary.user, operation: summary.operation, status: summary.status, orgAlias: alias }) }; }
function output(value: unknown) { return { content: [{ type: "text" as const, text: JSON.stringify(value) }] }; }
async function handle(name: string, args: Args) { if (name === "list_debug_logs") return summaries(Number(args.limit || 50)); const current = await load(String(args.logId || "local-log")); if (name === "get_log_summary" || name === "analyze_debug_log") return { metadata: current.parsed.metadata, findings: current.parsed.findings, limits: current.parsed.limits, events: current.parsed.events.slice(0, 100) }; if (name === "get_log_excerpt" || name === "search_debug_logs") return current.parsed.lines.map((line, i) => ({ line: i + 1, text: redact(line, true) })).filter((item) => !args.query || item.text.toLowerCase().includes(String(args.query).toLowerCase())).slice(0, Math.min(200, Number(args.limit || 50))); if (name === "compare_debug_logs") { const base = await load(String(args.baselineLogId)); const comparison = comparePerformance(base.parsed, current.parsed); return { baseline: base.parsed.metadata, candidate: current.parsed.metadata, comparison }; } if (name === "export_incident_bundle") return incidentBundle(current.parsed, (args.format as "json" | "html" | "sarif") || "json"); if (name === "create_reproduction_checklist") return { steps: ["Capture a fresh trace flag for the failing user", "Reproduce with a minimal record set", "Confirm SOQL/DML counts before and after bulkification", "Attach the referenced line ranges"], rules: current.parsed.findings.map((f) => f.ruleId) }; throw new Error("UNKNOWN_TOOL"); }
const server = new Server({ name: "sflens", version: "0.3.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async (request) => { try { return output(await handle(request.params.name, (request.params.arguments || {}) as Args)); } catch (error) { return output({ error: error instanceof Error ? error.message : "MCP_TOOL_FAILED" }); } });
await server.connect(new StdioServerTransport());
