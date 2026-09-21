const sessions = new Map();
const pending = new Map();
const sessionTtlMs = 60 * 60 * 1000;
const pendingTtlMs = 10 * 60 * 1000;
const maxFilterLength = 200;
const maxLogBytes = 25 * 1024 * 1024;
const maxJsonBytes = 2 * 1024 * 1024;

function json(data, status = 200, origin = "") {
  const headers = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    pragma: "no-cache",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "access-control-allow-headers": "content-type,x-sflens-session",
    "access-control-allow-methods": "GET,OPTIONS",
    "access-control-max-age": "600",
  };
  if (origin) {
    headers["access-control-allow-origin"] = origin;
    headers.vary = "Origin";
  }
  return new Response(JSON.stringify(data), { status, headers });
}

function redirect(location) {
  return new Response(null, {
    status: 302,
    headers: {
      location,
      "cache-control": "no-store",
      pragma: "no-cache",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
}

function randomToken(bytes = 32) {
  const values = new Uint8Array(bytes);
  crypto.getRandomValues(values);
  let binary = "";
  for (const value of values) binary += String.fromCharCode(value);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64Url(bytes) {
  let binary = "";
  for (const value of bytes) binary += String.fromCharCode(value);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function challenge(verifier) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

function cleanup() {
  const now = Date.now();
  for (const [key, value] of pending) if (value.expiresAt < now) pending.delete(key);
  for (const [key, value] of sessions) if (value.expiresAt < now) sessions.delete(key);
}

function callbackUri(_request, env) {
  return env.SFLENS_CALLBACK_URI || "";
}

function authorizedOrigin(request, env) {
  const origin = request.headers.get("Origin") || "";
  return origin === env.SFLENS_WEB_ORIGIN ? origin : "";
}

function authSession(request) {
  const value = request.headers.get("x-sflens-session") || "";
  cleanup();
  return /^[A-Za-z0-9_-]{32,128}$/.test(value) ? sessions.get(value) : undefined;
}

function safeAlias(value) {
  return `oauth-${String(value || "org").replace(/[^a-zA-Z0-9]/g, "").slice(-12).toLowerCase()}`;
}

function trustedSalesforceUrl(value, pathRequired = false) {
  try {
    const parsed = new URL(String(value));
    if (parsed.protocol !== "https:" || !/(^|\.)salesforce(?:-setup)?\.com$/i.test(parsed.hostname)) return "";
    return pathRequired ? parsed.href : parsed.origin;
  } catch {
    return "";
  }
}

function escapeSoql(value) {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function filterValue(url, key) {
  const value = url.searchParams.get(key) || "";
  return value && value.length <= maxFilterLength ? value : "";
}

function validDateFilter(value) {
  return /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:?\d{2})?)?$/.test(value);
}

function logQuery(url) {
  const rawLimit = Number(url.searchParams.get("limit") || 50);
  const limit = Number.isFinite(rawLimit) ? Math.min(100, Math.max(1, Math.floor(rawLimit))) : 50;
  const where = [];
  const user = filterValue(url, "user");
  const operation = filterValue(url, "operation");
  const status = filterValue(url, "status");
  const from = filterValue(url, "from");
  const to = filterValue(url, "to");
  if (user) where.push(`LogUser.Name LIKE '%${escapeSoql(user)}%'`);
  if (operation) where.push(`Operation LIKE '%${escapeSoql(operation)}%'`);
  if (status) where.push(`Status = '${escapeSoql(status)}'`);
  if (from && validDateFilter(from)) where.push(`StartTime >= ${from}`);
  if (to && validDateFilter(to)) where.push(`StartTime <= ${to}`);
  return `SELECT Id,StartTime,LogUser.Name,Operation,Status,LogLength FROM ApexLog${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY StartTime DESC LIMIT ${limit}`;
}

async function boundedText(response, maxBytes) {
  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (declaredLength > maxBytes) throw new Error("SALESFORCE_RESPONSE_TOO_LARGE");
  if (!response.body) {
    const value = await response.text();
    if (new TextEncoder().encode(value).byteLength > maxBytes) throw new Error("SALESFORCE_RESPONSE_TOO_LARGE");
    return value;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error("SALESFORCE_RESPONSE_TOO_LARGE");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

async function boundedJson(response) {
  return JSON.parse(await boundedText(response, maxJsonBytes));
}

async function salesforce(session, path, init = {}) {
  const response = await fetch(`${session.instanceUrl}/services/data/v${session.apiVersion}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${session.accessToken}`, ...(init.headers || {}) },
  });
  if (!response.ok) throw new Error(`SALESFORCE_${response.status}`);
  return response;
}

async function startOAuth(request, env) {
  if (!env.SFLENS_SALESFORCE_CLIENT_ID || !env.SFLENS_REDIRECT_URI || !env.SFLENS_CALLBACK_URI || !env.SFLENS_WEB_ORIGIN) return json({ error: "OAUTH_NOT_CONFIGURED" }, 503);
  const requestUrl = new URL(request.url);
  const environment = requestUrl.searchParams.get("environment") || "production";
  if (environment !== "production" && environment !== "sandbox") return json({ error: "INVALID_SALESFORCE_ENVIRONMENT" }, 400);
  const loginUrl = environment === "sandbox" ? "https://test.salesforce.com" : (trustedSalesforceUrl(env.SFLENS_SALESFORCE_LOGIN_URL) || "https://login.salesforce.com");
  const redirectUri = callbackUri(request, env);
  const verifier = randomToken(32);
  const state = randomToken(24);
  pending.set(state, { verifier, redirectUri, loginUrl, expiresAt: Date.now() + pendingTtlMs });
  const url = new URL("/services/oauth2/authorize", loginUrl);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: env.SFLENS_SALESFORCE_CLIENT_ID,
    redirect_uri: callbackUri(request, env),
    state,
    code_challenge: await challenge(verifier),
    code_challenge_method: "S256",
    scope: "api",
  }).toString();
  return redirect(url.toString());
}

async function finishOAuth(request, env, url) {
  const state = url.searchParams.get("state") || "";
  const entry = pending.get(state);
  pending.delete(state);
  if (!entry || entry.expiresAt < Date.now()) return json({ error: "OAUTH_STATE_INVALID" }, 400);
  if (url.searchParams.get("error")) return json({ error: "OAUTH_DENIED" }, 400);
  const code = url.searchParams.get("code") || "";
  if (!code) return json({ error: "OAUTH_CODE_MISSING" }, 400);
  const tokenResponse = await fetch(new URL("/services/oauth2/token", entry.loginUrl), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: env.SFLENS_SALESFORCE_CLIENT_ID,
      redirect_uri: entry.redirectUri,
      code_verifier: entry.verifier,
    }),
  });
  if (!tokenResponse.ok) return json({ error: "OAUTH_TOKEN_EXCHANGE_FAILED" }, 502);
  const fields = await boundedJson(tokenResponse);
  const instanceUrl = trustedSalesforceUrl(fields.instance_url);
  const identityUrl = trustedSalesforceUrl(fields.id, true);
  if (!fields.access_token || !instanceUrl || !identityUrl) return json({ error: "OAUTH_TOKEN_INVALID" }, 502);
  const identityResponse = await fetch(identityUrl, { headers: { authorization: `Bearer ${fields.access_token}` } });
  if (!identityResponse.ok) return json({ error: "OAUTH_IDENTITY_FAILED" }, 502);
  const identity = await boundedJson(identityResponse);
  const sessionId = randomToken(32);
  sessions.set(sessionId, {
    accessToken: fields.access_token,
    instanceUrl,
    alias: safeAlias(identity.organization_id || fields.instance_url),
    username: identity.username || "Salesforce user",
    orgId: identity.organization_id || "",
    apiVersion: env.SFLENS_SALESFORCE_API_VERSION || "62.0",
    expiresAt: Date.now() + (() => { const seconds = Number(fields.expires_in); return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, sessionTtlMs) : sessionTtlMs; })(),
  });
  return redirect(`${env.SFLENS_REDIRECT_URI}#sflens_session=${encodeURIComponent(sessionId)}`);
}

async function route(request, env) {
  const url = new URL(request.url);
  const origin = authorizedOrigin(request, env);
  if (request.method === "OPTIONS") return json({}, 204, origin);
  if (url.pathname === "/health") return json({ ok: true, service: "sflens-relay", readOnly: true }, 200, origin);
  if (url.pathname === "/oauth/start") return request.method === "GET" ? startOAuth(request, env) : json({ error: "METHOD_NOT_ALLOWED" }, 405, origin);
  if (url.pathname === "/oauth/callback") {
    try { return await finishOAuth(request, env, url); } catch { return json({ error: "OAUTH_CALLBACK_FAILED" }, 502); }
  }
  const session = authSession(request);
  if (!session) return json({ error: "SESSION_EXPIRED" }, 401, origin);
  if (url.pathname === "/orgs") return json({ orgs: [{ alias: session.alias, username: session.username, instanceUrl: session.instanceUrl, orgId: session.orgId }] }, 200, origin);
  const logMatch = url.pathname.match(/^\/orgs\/([^/]+)\/logs(?:\/([^/]+)\/body)?$/);
  let requestedAlias = "";
  try { requestedAlias = decodeURIComponent(logMatch?.[1] || ""); } catch { return json({ error: "INVALID_PATH" }, 400, origin); }
  if (!logMatch || requestedAlias !== session.alias) return json({ error: "NOT_FOUND" }, 404, origin);
  try {
    if (!logMatch[2]) {
      const response = await salesforce(session, `/tooling/query?q=${encodeURIComponent(logQuery(url))}`);
      const result = await boundedJson(response);
      return json({ records: (result.records || []).map((item) => ({
        id: item.Id,
        name: `${item.Operation || "Apex"} · ${item.StartTime || item.Id}`,
        startTime: item.StartTime,
        user: item.LogUser?.Name,
        operation: item.Operation,
        status: item.Status,
        size: item.LogLength,
        orgAlias: session.alias,
      })) }, 200, origin);
    }
    let id = "";
    try { id = decodeURIComponent(logMatch[2]); } catch { return json({ error: "INVALID_LOG_ID" }, 400, origin); }
    if (!/^[A-Za-z0-9]{15,18}$/.test(id)) return json({ error: "INVALID_LOG_ID" }, 400, origin);
    const response = await salesforce(session, `/tooling/sobjects/ApexLog/${encodeURIComponent(id)}/Body`);
    return new Response(await boundedText(response, maxLogBytes), { status: 200, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", pragma: "no-cache", "x-content-type-options": "nosniff", ...(origin ? { "access-control-allow-origin": origin, vary: "Origin" } : {}) } });
  } catch (error) {
    const safeError = error instanceof Error && /^SALESFORCE_[A-Z0-9_]+$/.test(error.message) ? error.message : "SALESFORCE_REQUEST_FAILED";
    return json({ error: safeError }, 502, origin);
  }
}

export default { fetch: route };
export { route };
