import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { __setBridgeTestDependencies, route, token } from "../src/index.js";

const org = { alias: "test-org", username: "dev@example.test", instanceUrl: "https://example.test", orgId: "00DTEST" };
const calls: string[] = [];
let traceActive = false;
const tooling = {
  query: async (soql: string) => { calls.push(soql); if (soql.includes("TraceFlag")) return { records: traceActive ? [{ Id: "7tfTEST", ExpirationDate: "2099-01-01T00:00:00Z" }] : [] }; if (soql.includes("DebugLevel")) return { records: [{ Id: "7dlTEST" }] }; if (soql.includes("User")) return { records: [{ Id: "005TEST" }] }; return { records: [{ Id: "07L000000000001", StartTime: "2026-01-01T00:00:00.000Z", LogUser: { Name: "Dev" }, Operation: "/apex/Test", Status: "Success", LogLength: 123 }] }; },
  create: async () => { traceActive = true; return { id: "7tfTEST" }; },
  delete: async (_type: string, id: string) => { traceActive = false; calls.push(`delete:${id}`); },
  retrieve: async () => ({ Id: "07L000000000001" }),
};
const connection = { tooling, getApiVersion: () => "62.0", request: async () => "EXECUTION_STARTED\nUSER_DEBUG|hello" } as any;
let server: http.Server;
let base = "";

async function get(path: string, init: RequestInit = {}) {
  return fetch(`${base}${path}`, { ...init, headers: { "x-sflens-token": token, ...(init.headers || {}) } });
}

beforeAll(async () => {
  __setBridgeTestDependencies({ orgList: async () => [org], connection: async () => connection, currentUser: async () => ({ org, connection }), startCliAuth: () => ({ jobId: "job-test", session: "session-test" }) });
  server = http.createServer(route);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => { const address = server.address() as any; base = `http://127.0.0.1:${address.port}`; resolve(); }));
});
afterAll(async () => { __setBridgeTestDependencies(); await new Promise<void>((resolve) => server.close(() => resolve())); });

describe("bridge routes", () => {
  it("protects routes and responds to health with CORS", async () => {
    const denied = await fetch(`${base}/health`);
    expect(denied.status).toBe(401);
    const response = await get("/health");
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
    const hosted = await fetch(`${base}/health`, { headers: { Origin: "https://jcd1991.github.io" } });
    expect(hosted.headers.get("access-control-allow-origin")).toBeNull();
    expect(hosted.headers.get("access-control-allow-private-network")).toBe("true");
  });
  it("starts browser authorization without exposing a client setup flow", async () => {
    const response = await fetch(`${base}/oauth/start`, { credentials: "include" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ mode: "cli", jobId: "job-test", session: "session-test" });
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
  });
  it("resumes an already authenticated CLI org without a new login", async () => {
    const response = await fetch(`${base}/oauth/resume?alias=test-org`, { credentials: "include" });
    expect(response.status).toBe(200);
    expect((await response.json()).org.alias).toBe("test-org");
    expect(response.headers.get("set-cookie")).toContain("sflens_session=");
  });
  it("binds a session to its authorized org instead of exposing other local orgs", async () => {
    const response = await fetch(`${base}/oauth/resume?alias=test-org`, { credentials: "include" });
    const cookie = response.headers.get("set-cookie")!.split(";")[0];
    const orgs = await fetch(`${base}/orgs`, { headers: { cookie } });
    expect(await orgs.json()).toEqual({ orgs: [org] });
    const denied = await fetch(`${base}/orgs/another-org/logs`, { headers: { cookie } });
    expect(denied.status).toBe(404);
    expect(await denied.json()).toEqual({ error: "ORG_NOT_AUTHENTICATED" });
  });
  it("normalizes orgs and bounds log queries", async () => {
    const orgs = await get("/orgs");
    expect(await orgs.json()).toEqual({ orgs: [org] });
    await get("/orgs/test-org/logs?limit=999&user=Dev&operation=apex&status=Success&from=2026-01-01&to=2026-01-02");
    const soql = calls.at(-1)!;
    expect(soql).toContain("LIMIT 100");
    expect(soql).toContain("LogUser.Name LIKE '%Dev%'");
    expect(soql).toContain("Status = 'Success'");
    await get("/orgs/test-org/logs?limit=not-a-number&from=not-a-date");
    const boundedSoql = calls.at(-1)!;
    expect(boundedSoql).toContain("LIMIT 50");
    expect(boundedSoql).not.toContain("StartTime >= not-a-date");
  });
  it("retrieves a body through the Tooling API and limits async ids", async () => {
    const body = await get("/orgs/test-org/logs/07L000000000001/body");
    expect(await body.json()).toContain("USER_DEBUG");
    const invalidBody = await get("/orgs/test-org/logs/not-a-log-id/body");
    expect(invalidBody.status).toBe(400);
    await get(`/orgs/test-org/async-jobs?ids=${Array.from({ length: 30 }, (_, i) => `00JOB${String(i).padStart(12, "0")}`).join(",")}`);
    expect(calls.some((s) => s.includes("AsyncApexJob") && (s.match(/00JOB/g) || []).length <= 20)).toBe(true);
  });
  it("supports read-only debug logging lifecycle", async () => {
    const enabled = await get("/orgs/test-org/debug-logging", { method: "POST", body: JSON.stringify({ minutes: 999 }), headers: { "content-type": "application/json" } });
    expect((await enabled.json()).enabled).toBe(true);
    const disabled = await get("/orgs/test-org/debug-logging", { method: "DELETE" });
    expect((await disabled.json()).enabled).toBe(false);
    expect(calls).toContain("delete:7tfTEST");
  });
});
