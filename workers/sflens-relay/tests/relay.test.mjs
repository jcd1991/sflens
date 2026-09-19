import assert from "node:assert/strict";
import { test, afterEach } from "node:test";
import { route } from "../src/index.js";

const env = {
  SFLENS_SALESFORCE_CLIENT_ID: "test-public-client",
  SFLENS_SALESFORCE_LOGIN_URL: "https://login.salesforce.com",
  SFLENS_SALESFORCE_API_VERSION: "62.0",
  SFLENS_WEB_ORIGIN: "https://jcd1991.github.io",
  SFLENS_REDIRECT_URI: "https://jcd1991.github.io/sflens/",
  SFLENS_CALLBACK_URI: "https://relay.example.test/oauth/callback",
};

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

async function request(path, init = {}, origin = env.SFLENS_WEB_ORIGIN) {
  const headers = new Headers(init.headers);
  if (origin) headers.set("Origin", origin);
  return route(new Request(`https://relay.example.test${path}`, { ...init, headers }), env);
}

async function establishSession() {
  const start = await request("/oauth/start", {}, "");
  assert.equal(start.status, 302);
  const authorize = new URL(start.headers.get("location"));
  const original = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/services/oauth2/token")) {
      return new Response(JSON.stringify({ access_token: "access-token-never-returned", instance_url: "https://example.my.salesforce.com", id: "https://example.my.salesforce.com/id/00D000000000001/005000000000001", expires_in: 3600 }), { headers: { "content-type": "application/json" } });
    }
    if (url.includes("/id/00D")) {
      return new Response(JSON.stringify({ username: "developer@example.test", organization_id: "00D000000000001" }), { headers: { "content-type": "application/json" } });
    }
    return original(input);
  };
  const callback = await route(new Request(`https://relay.example.test/oauth/callback?code=one-time-code&state=${encodeURIComponent(authorize.searchParams.get("state"))}`), env);
  assert.equal(callback.status, 302);
  const callbackLocation = callback.headers.get("location");
  assert.doesNotMatch(callbackLocation, /access-token-never-returned/);
  const session = new URL(callbackLocation).hash.split("=")[1];
  assert.match(session, /^[A-Za-z0-9_-]{32,128}$/);
  return session;
}

test("refuses OAuth startup when the public configuration is incomplete", async () => {
  const response = await route(new Request("https://relay.example.test/oauth/start"), { ...env, SFLENS_SALESFORCE_CLIENT_ID: "" });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "OAUTH_NOT_CONFIGURED" });
});

test("creates an opaque PKCE session without putting the access token in the redirect", async () => {
  const session = await establishSession();
  assert.ok(session);
  const orgs = await request("/orgs", { headers: { "x-sflens-session": session } });
  assert.equal(orgs.status, 200);
  assert.deepEqual(await orgs.json(), { orgs: [{ alias: "oauth-000000000001", username: "developer@example.test", instanceUrl: "https://example.my.salesforce.com", orgId: "00D000000000001" }] });
});

test("allows only the configured browser origin and rejects stale sessions", async () => {
  const unauthorized = await request("/orgs", { headers: { "x-sflens-session": "not-a-session" } }, "https://evil.example");
  assert.equal(unauthorized.status, 401);
  assert.equal(unauthorized.headers.get("access-control-allow-origin"), null);
  const expired = await request("/orgs", { headers: { "x-sflens-session": "A".repeat(32) } });
  assert.equal(expired.status, 401);
});

test("bounds and validates the ApexLog query before sending it to Salesforce", async () => {
  const session = await establishSession();
  let queriedUrl = "";
  globalThis.fetch = async (input) => {
    queriedUrl = String(input);
    return new Response(JSON.stringify({ records: [] }), { headers: { "content-type": "application/json" } });
  };
  const response = await request("/orgs/oauth-000000000001/logs?limit=not-a-number&from=not-a-date&user=alice", { headers: { "x-sflens-session": session } });
  assert.equal(response.status, 200);
  const query = new URL(queriedUrl).searchParams.get("q");
  assert.match(query, /LIMIT 50$/);
  assert.match(query, /LogUser\.Name LIKE '%alice%'/);
  assert.doesNotMatch(query, /StartTime (?:>=|<=)/);
});

test("rejects invalid log IDs and protects oversized bodies", async () => {
  const session = await establishSession();
  const invalid = await request("/orgs/oauth-000000000001/logs/not-an-id/body", { headers: { "x-sflens-session": session } });
  assert.equal(invalid.status, 400);
  assert.deepEqual(await invalid.json(), { error: "INVALID_LOG_ID" });
  globalThis.fetch = async () => new Response("", { status: 200, headers: { "content-length": String(26 * 1024 * 1024) } });
  const oversized = await request("/orgs/oauth-000000000001/logs/00l000000000001/body", { headers: { "x-sflens-session": session } });
  assert.equal(oversized.status, 502);
  assert.deepEqual(await oversized.json(), { error: "SALESFORCE_RESPONSE_TOO_LARGE" });
});

test("returns security headers and no-store responses", async () => {
  const response = await request("/health");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
});
