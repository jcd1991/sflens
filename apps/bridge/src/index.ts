import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { createHash, randomBytes } from "node:crypto";
import { AuthInfo, Connection } from "@salesforce/core";
const exec = promisify(execFile),
  token = randomUUID(),
  port = Number(process.env.SFLENS_BRIDGE_PORT || 8787),
  origin = process.env.SFLENS_WEB_ORIGIN || "http://localhost:5173";
const allowedOrigins = new Set(
  (process.env.SFLENS_WEB_ORIGINS || `${origin},http://127.0.0.1:5173`)
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);
const oauthClientId = process.env.SFLENS_SALESFORCE_CLIENT_ID || "";
const oauthLoginUrl = process.env.SFLENS_SALESFORCE_LOGIN_URL || "https://login.salesforce.com";
const sessionTtlMs = 60 * 60_000;
const oauthSessions = new Map<string, { org: any; connection: Connection; expiresAt: number }>();
const oauthStates = new Map<string, { verifier: string; createdAt: number }>();
type CliAuthJob = { alias: string; session: string; status: "pending" | "complete" | "error"; error?: string };
const cliAuthJobs = new Map<string, CliAuthJob>();
const cliSessions = new Map<string, { alias: string; expiresAt: number }>();
type BridgeDeps = {
  orgList: typeof orgList;
  connection: typeof connection;
  currentUser: typeof currentUser;
  startCliAuth: typeof startCliAuth;
};
let testDeps: BridgeDeps | undefined;
export function __setBridgeTestDependencies(deps?: Partial<BridgeDeps>) {
  testDeps = deps ? { orgList, connection, currentUser, startCliAuth, ...deps } : undefined;
}
async function cli(args: string[]) {
  try {
    const r = await exec("sf", args, { maxBuffer: 2_000_000 });
    return JSON.parse(r.stdout);
  } catch (e: any) {
    throw new Error(e.code === "ENOENT" ? "SF_CLI_MISSING" : "SF_CLI_ERROR");
  }
}
async function orgList() {
  const data = await cli(["org", "list", "--json"]);
  const all = [
    ...(data.result?.nonScratchOrgs || []),
    ...(data.result?.scratchOrgs || []),
  ];
  return all
    .filter((x: any) => x.alias && x.username)
    .map((x: any) => ({
      alias: x.alias,
      username: x.username,
      instanceUrl: x.instanceUrl,
      orgId: x.orgId,
    }));
}
async function availableOrgList() {
  cleanupSessions();
  const cliOrgs = await orgList();
  const oauthOrgs = [...oauthSessions.values()].map((item) => item.org);
  return [...cliOrgs, ...oauthOrgs.filter((oauth) => !cliOrgs.some((cli) => cli.alias === oauth.alias))];
}
async function sessionOrgList(req: http.IncomingMessage) {
  cleanupSessions();
  const session = oauthCookie(req) || "";
  const cliAlias = cliSessions.get(session)?.alias;
  if (cliAlias) return (await orgList()).filter((item: any) => item.alias === cliAlias);
  const oauthOrg = oauthSessions.get(session)?.org;
  if (oauthOrg) return [oauthOrg];
  return availableOrgList();
}
async function connection(alias: string) {
  cleanupSessions();
  const oauth = [...oauthSessions.values()].find((item) => item.org.alias === alias);
  if (oauth) return oauth.connection;
  const org = (await orgList()).find((x: any) => x.alias === alias);
  if (!org) throw new Error("ORG_NOT_AUTHENTICATED");
  return Connection.create({
    authInfo: await AuthInfo.create({ username: org.username }),
  });
}
function oauthCookie(req: http.IncomingMessage) {
  return String(req.headers.cookie || "").split(";").map((part) => part.trim()).find((part) => part.startsWith("sflens_session="))?.split("=")[1] || String(req.headers["x-sflens-session"] || "");
}
function oauthAuth(req: http.IncomingMessage) {
  cleanupSessions();
  const session = oauthCookie(req);
  return session && (oauthSessions.has(session) || cliSessions.has(session));
}
function canAccessOrg(req: http.IncomingMessage, alias: string) {
  if (req.headers["x-sflens-token"] === token) return true;
  const session = oauthCookie(req) || "";
  return cliSessions.get(session)?.alias === alias || oauthSessions.get(session)?.org.alias === alias;
}
function rememberCliSession(session: string, alias: string) {
  cliSessions.set(session, { alias, expiresAt: Date.now() + sessionTtlMs });
}
function cleanupSessions() {
  const now = Date.now();
  for (const [key, value] of cliSessions) if (value.expiresAt < now) cliSessions.delete(key);
  for (const [key, value] of oauthSessions) if (value.expiresAt < now) oauthSessions.delete(key);
  for (const [key, value] of oauthStates) if (now - value.createdAt > 10 * 60_000) oauthStates.delete(key);
}
function startCliAuth() {
  const jobId = randomUUID();
  const alias = `sflens-browser-${randomBytes(6).toString("hex")}`;
  const session = randomUUID();
  const job: CliAuthJob = { alias, session, status: "pending" };
  cliAuthJobs.set(jobId, job);
  rememberCliSession(session, alias);
  execFile("sf", ["org", "login", "web", "--alias", alias, "--json"], { maxBuffer: 2_000_000 }, (error) => {
    if (error) {
      job.status = "error";
      job.error = "Salesforce authorization did not complete.";
    } else {
      job.status = "complete";
    }
  });
  return { jobId, session };
}
async function resumeCliSession(alias: string) {
  const org = (await (testDeps?.orgList || orgList)()).find((item: any) => item.alias === alias);
  if (!org) throw new Error("ORG_NOT_AUTHENTICATED");
  const session = randomUUID();
  rememberCliSession(session, alias);
  return { session, org };
}
async function oauthStart() {
  if (!oauthClientId) return { mode: "cli", ...((testDeps?.startCliAuth || startCliAuth)()) };
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(24).toString("base64url");
  oauthStates.set(state, { verifier, createdAt: Date.now() });
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const url = new URL("/services/oauth2/authorize", oauthLoginUrl);
  url.search = new URLSearchParams({ response_type: "code", client_id: oauthClientId, redirect_uri: `http://127.0.0.1:${port}/oauth/callback`, state, code_challenge: challenge, code_challenge_method: "S256", scope: "api refresh_token" }).toString();
  return { mode: "oauth", authorizationUrl: url.toString() };
}
async function oauthCallback(url: URL) {
  const state = url.searchParams.get("state") || "";
  const pending = oauthStates.get(state);
  oauthStates.delete(state);
  if (!pending || Date.now() - pending.createdAt > 10 * 60_000) throw new Error("OAUTH_STATE_INVALID");
  const code = url.searchParams.get("code");
  if (!code) throw new Error("OAUTH_CODE_MISSING");
  const response = await fetch(new URL("/services/oauth2/token", oauthLoginUrl), { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: oauthClientId, redirect_uri: `http://127.0.0.1:${port}/oauth/callback`, code_verifier: pending.verifier }) });
  if (!response.ok) throw new Error("OAUTH_TOKEN_EXCHANGE_FAILED");
  const fields: any = await response.json();
  const instanceUrl = trustedSalesforceUrl(fields.instance_url);
  const identityUrl = trustedSalesforceUrl(fields.id, true);
  if (!fields.access_token || !instanceUrl || !identityUrl) throw new Error("OAUTH_TOKEN_INVALID");
  const identity = await fetch(identityUrl, { headers: { authorization: `Bearer ${fields.access_token}` } });
  if (!identity.ok) throw new Error("OAUTH_IDENTITY_FAILED");
  const who: any = await identity.json();
  const alias = `oauth-${String(who.organization_id || fields.instance_url).replace(/[^a-zA-Z0-9]/g, "").slice(-12)}`;
  const authInfo = await AuthInfo.create({ username: who.username, accessTokenOptions: { accessToken: fields.access_token, instanceUrl, loginUrl: oauthLoginUrl } });
  const c = await Connection.create({ authInfo });
  const session = randomUUID();
  oauthSessions.set(session, { org: { alias, username: who.username, instanceUrl, orgId: who.organization_id }, connection: c, expiresAt: Date.now() + sessionTtlMs });
  return session;
}
function trustedSalesforceUrl(value: unknown, pathRequired = false) {
  try {
    const parsed = new URL(String(value));
    if (parsed.protocol !== "https:" || !/(^|\.)salesforce(?:-setup)?\.com$/i.test(parsed.hostname)) return "";
    return pathRequired ? parsed.href : parsed.origin;
  } catch {
    return "";
  }
}
async function currentUser(alias: string) {
  const org = (await orgList()).find((item: any) => item.alias === alias);
  if (!org) throw new Error("ORG_NOT_AUTHENTICATED");
  return { org, connection: await connection(alias) };
}
async function body(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => { let value = ""; let size = 0; req.on("data", (chunk) => { size += Buffer.byteLength(chunk); if (size > 16_384) { reject(new Error("REQUEST_TOO_LARGE")); req.destroy(); return; } value += chunk; }); req.on("end", () => { try { resolve(value ? JSON.parse(value) : {}); } catch { reject(new Error("INVALID_JSON")); } }); req.on("error", reject); });
}
function send(res: http.ServerResponse, status: number, data: unknown) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store");
  res.setHeader("x-content-type-options", "nosniff");
  res.end(JSON.stringify(data));
}
function clientError(error: unknown) {
  const code = error instanceof Error ? error.message : "";
  if (code === "SF_CLI_MISSING") return { status: 503, error: code };
  if (code === "SF_CLI_ERROR") return { status: 502, error: "Salesforce CLI could not complete the request." };
  if (/^[A-Z][A-Z0-9_]{2,64}$/.test(code)) return { status: 400, error: code };
  return { status: 400, error: "BRIDGE_REQUEST_FAILED" };
}
function logQuery(url: URL) {
  const rawLimit = Number(url.searchParams.get("limit") || 50);
  const limit = Number.isFinite(rawLimit) ? Math.min(100, Math.max(1, Math.floor(rawLimit))) : 50;
  const bounded = (key: string) => { const value = url.searchParams.get(key) || ""; return value.length <= 200 ? value : ""; };
  const validDate = (value: string) => /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:?\d{2})?)?$/.test(value);
  const where: string[] = [];
  const esc = (v: string) => v.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const user = bounded("user"), operation = bounded("operation"), status = bounded("status"), from = bounded("from"), to = bounded("to");
  if (user) where.push(`LogUser.Name LIKE '%${esc(user)}%'`);
  if (operation) where.push(`Operation LIKE '%${esc(operation)}%'`);
  if (status) where.push(`Status = '${esc(status)}'`);
  if (from && validDate(from)) where.push(`StartTime >= ${from}`);
  if (to && validDate(to)) where.push(`StartTime <= ${to}`);
  return `SELECT Id,StartTime,LogUser.Name,Operation,Status,LogLength FROM ApexLog${where.length ? " WHERE " + where.join(" AND ") : ""} ORDER BY StartTime DESC LIMIT ${limit}`;
}
async function route(req: http.IncomingMessage, res: http.ServerResponse) {
  const requestOrigin = String(req.headers.origin || "");
  if (allowedOrigins.has(requestOrigin)) res.setHeader("Access-Control-Allow-Origin", requestOrigin);
  else if (!requestOrigin) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Headers", "x-sflens-token,x-sflens-session,content-type");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Private-Network", "true");
  if (req.method === "OPTIONS") return send(res, 204, {});
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  if (url.pathname === "/oauth/start" && req.method === "GET") {
    try {
      const result: any = await oauthStart();
      if (result.session) res.setHeader("set-cookie", `sflens_session=${result.session}; HttpOnly; SameSite=Lax; Path=/; Max-Age=3600`);
      return send(res, 200, result);
    } catch (e: any) { const result = clientError(e); return send(res, result.status === 400 ? 503 : result.status, { error: result.error }); }
  }
  const oauthStatus = req.method === "GET" && url.pathname.match(/^\/oauth\/status\/([^/]+)$/);
  if (oauthStatus) {
    const job = cliAuthJobs.get(decodeURIComponent(oauthStatus[1]));
    if (!job || job.session !== oauthCookie(req)) return send(res, 404, { error: "AUTHORIZATION_NOT_FOUND" });
    if (job.status === "error") {
      const authenticated = await (testDeps?.orgList || orgList)();
      if (authenticated.some((item: any) => item.alias === job.alias)) job.status = "complete";
    }
    return send(res, 200, { status: job.status, ...(job.status === "complete" ? { alias: job.alias } : {}), ...(job.status === "error" ? { error: job.error } : {}) });
  }
  if (url.pathname === "/oauth/resume" && req.method === "GET") {
    try {
      const resumed: any = await resumeCliSession(url.searchParams.get("alias") || "");
      res.setHeader("set-cookie", `sflens_session=${resumed.session}; HttpOnly; SameSite=Lax; Path=/; Max-Age=3600`);
      return send(res, 200, resumed);
    } catch { return send(res, 401, { error: "ORG_NOT_AUTHENTICATED" }); }
  }
  if (url.pathname === "/oauth/callback" && req.method === "GET") {
    try { const session = await oauthCallback(url); res.setHeader("set-cookie", `sflens_session=${session}; HttpOnly; SameSite=Lax; Path=/; Max-Age=3600`); res.statusCode = 302; res.setHeader("location", `${origin}/sflens/?oauth=success`); return res.end(); } catch { res.statusCode = 302; res.setHeader("location", `${origin}/sflens/?oauth=error`); return res.end(); }
  }
  if (req.headers["x-sflens-token"] !== token && !oauthAuth(req))
    return send(res, 401, { error: "INVALID_STARTUP_TOKEN" });
  try {
    if (url.pathname === "/health")
      return send(res, 200, { ok: true, version: "0.2.0" });
    if (url.pathname === "/orgs" && req.method === "GET")
      return send(res, 200, { orgs: await (testDeps?.orgList || sessionOrgList)(req) });
    const debugMatch = url.pathname.match(/^\/orgs\/([^/]+)\/debug-logging$/);
    if (debugMatch) {
      if (!["GET", "POST", "DELETE"].includes(req.method || "")) return send(res, 405, { error: "METHOD_NOT_ALLOWED" });
      let alias = "";
      try { alias = decodeURIComponent(debugMatch[1]); } catch { return send(res, 400, { error: "INVALID_ORG_ALIAS" }); }
      if (!canAccessOrg(req, alias)) return send(res, 404, { error: "ORG_NOT_AUTHENTICATED" });
      const { org, connection: c } = await (testDeps?.currentUser || currentUser)(alias);
      const user = (await c.tooling.query(`SELECT Id FROM User WHERE Username = '${org.username.replace(/'/g, "\\'")}' LIMIT 1`)).records?.[0];
      if (!user) throw new Error("CURRENT_USER_NOT_FOUND");
      if (req.method === "GET") {
        const active = await c.tooling.query(`SELECT Id,ExpirationDate,DebugLevelId FROM TraceFlag WHERE TracedEntityId = '${user.Id}' AND ExpirationDate > ${new Date().toISOString()}`);
        return send(res, 200, { enabled: Boolean(active.records?.length), flags: active.records || [] });
      }
      if (req.method === "POST") {
        const input = await body(req); const rawMinutes = Number(input.minutes || 15); const minutes = Number.isFinite(rawMinutes) ? Math.min(60, Math.max(1, rawMinutes)) : 15;
        const levels = await c.tooling.query("SELECT Id FROM DebugLevel ORDER BY DeveloperName LIMIT 1");
        const level = levels.records?.[0]; if (!level) throw new Error("DEBUG_LEVEL_NOT_FOUND");
        const start = new Date(), expiration = new Date(start.getTime() + minutes * 60_000);
        const created = await c.tooling.create("TraceFlag", { TracedEntityId: user.Id, DebugLevelId: level.Id, LogType: "USER_DEBUG", StartDate: start.toISOString(), ExpirationDate: expiration.toISOString() });
        return send(res, 200, { enabled: true, expiresAt: expiration.toISOString(), id: created.id });
      }
      if (req.method === "DELETE") {
        const active = await c.tooling.query(`SELECT Id FROM TraceFlag WHERE TracedEntityId = '${user.Id}' AND ExpirationDate > ${new Date().toISOString()}`);
        for (const flag of active.records || []) if (flag.Id) await c.tooling.delete("TraceFlag", flag.Id);
        return send(res, 200, { enabled: false, removed: active.records?.length || 0 });
      }
    }
    const asyncMatch = url.pathname.match(/^\/orgs\/([^/]+)\/async-jobs$/);
    if (asyncMatch) {
      if (req.method !== "GET") return send(res, 405, { error: "METHOD_NOT_ALLOWED" });
      const ids = (url.searchParams.get("ids") || "")
        .split(",")
        .filter(Boolean)
        .slice(0, 20);
      if (!ids.length) return send(res, 200, { records: [] });
      let alias = "";
      try { alias = decodeURIComponent(asyncMatch[1]); } catch { return send(res, 400, { error: "INVALID_ORG_ALIAS" }); }
      if (!canAccessOrg(req, alias)) return send(res, 404, { error: "ORG_NOT_AUTHENTICATED" });
      const c = await (testDeps?.connection || connection)(alias);
      const safe = ids.filter((id) => /^[a-zA-Z0-9]{15,18}$/.test(id));
      if (!safe.length) return send(res, 200, { records: [] });
      return send(
        res,
        200,
        await c.tooling.query(
          `SELECT Id,Status,JobType,CreatedDate,CompletedDate,NumberOfErrors,ParentJobId FROM AsyncApexJob WHERE Id IN ('${safe.join("','")}')`,
        ),
      );
    }
    const m = url.pathname.match(
      /^\/orgs\/([^/]+)\/logs(?:\/([^/]+)(?:\/body)?)?$/,
    );
    if (!m) return send(res, 404, { error: "NOT_FOUND" });
    if (req.method !== "GET") return send(res, 405, { error: "METHOD_NOT_ALLOWED" });
    let alias = "";
    try { alias = decodeURIComponent(m[1]); } catch { return send(res, 400, { error: "INVALID_ORG_ALIAS" }); }
    if (!canAccessOrg(req, alias)) return send(res, 404, { error: "ORG_NOT_AUTHENTICATED" });
    const c = await (testDeps?.connection || connection)(alias);
    if (!m[2]) {
      const result: any = await c.tooling.query(logQuery(url));
      return send(res, 200, {
        records: (result.records || []).map((x: any) => ({
          id: x.Id,
          name: `${x.Operation || "Apex"} · ${x.StartTime || x.Id}`,
          startTime: x.StartTime,
          user: x.LogUser?.Name,
          operation: x.Operation,
          status: x.Status,
          size: x.LogLength,
          orgAlias: alias,
        })),
      });
    }
    if (url.pathname.endsWith("/body")) {
      if (!/^[a-zA-Z0-9]{15,18}$/.test(m[2])) return send(res, 400, { error: "INVALID_LOG_ID" });
      const rawBody = await c.request(
        `/services/data/v${c.getApiVersion()}/tooling/sobjects/ApexLog/${m[2]}/Body`,
      );
      if (Buffer.byteLength(String(rawBody), "utf8") > 25 * 1024 * 1024) throw new Error("SALESFORCE_RESPONSE_TOO_LARGE");
      return send(
        res,
        200,
        rawBody,
      );
    }
    if (!/^[a-zA-Z0-9]{15,18}$/.test(m[2])) return send(res, 400, { error: "INVALID_LOG_ID" });
    return send(res, 200, await c.tooling.retrieve("ApexLog", m[2]));
  } catch (e: any) {
    const result = clientError(e);
    return send(res, result.status, { error: result.error });
  }
}
if (process.env.NODE_ENV !== "test") {
  http
    .createServer(route)
    .listen(port, "127.0.0.1", () =>
      console.log(
        `SFLens bridge listening on http://127.0.0.1:${port} token=${token}`,
      ),
    );
}

export { route, token };
