import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  correlateTransactions,
  comparePerformance,
  demoLog,
  incidentBundle,
  remediationForFinding,
  parseLog,
  redact,
  type ParsedLog,
  type RemoteLogSummary,
  type TransactionGroup,
  type OrgSummary,
  type PerformanceComparison,
} from "@sflens/core";
import {
  createSalesforceOAuthStart,
  salesforceOAuthError,
  salesforceOrgAlias,
  salesforceRedirectUri,
  type SalesforceOAuthConfig,
} from "./salesforce-oauth";
import "./style.css";
const bridgeDefault = "http://127.0.0.1:8787";
const browserClientId = import.meta.env.VITE_SALESFORCE_CLIENT_ID || "";
const browserLoginUrl = import.meta.env.VITE_SALESFORCE_LOGIN_URL || "https://login.salesforce.com";
const browserApiVersion = import.meta.env.VITE_SALESFORCE_API_VERSION || "62.0";
const hostedRelayUrl = (import.meta.env.VITE_SFLENS_RELAY_URL || "").replace(/\/$/, "");
const browserOAuthConfig: SalesforceOAuthConfig = {
  clientId: browserClientId,
  loginUrl: browserLoginUrl,
  redirectUri: typeof window === "undefined" ? "" : salesforceRedirectUri(),
};
function isHostedPage() {
  return typeof window !== "undefined" && !["localhost", "127.0.0.1"].includes(window.location.hostname);
}
function browserStorage(kind: "session" | "local") {
  try { return kind === "local" ? window.localStorage : window.sessionStorage; } catch { return undefined; }
}
function stored(kind: "session" | "local", key: string) { return browserStorage(kind)?.getItem(key) || null; }
function remember(kind: "session" | "local", key: string, value: string) { try { browserStorage(kind)?.setItem(key, value); } catch { /* storage is optional */ } }
function forget(kind: "session" | "local", key: string) { try { browserStorage(kind)?.removeItem(key); } catch { /* storage is optional */ } }
type Mode = "Demo" | "Upload" | "Connected";
type LogKind = "Apex" | "Flow" | "Aura" | "API" | "Visualforce" | "Other";
type GlobalMatch = { summary: RemoteLogSummary; lines: number[] };
type BrowserConnection = {
  accessToken: string;
  instanceUrl: string;
  alias: string;
  username: string;
  orgId: string;
};
function logKind(operation = "", name = ""): LogKind {
  const value = `${operation} ${name}`.toLowerCase();
  if (/flow|interview/.test(value)) return "Flow";
  if (/aura|lightning/.test(value)) return "Aura";
  if (/api|rest|soap|bulk|composite|connect/.test(value)) return "API";
  if (/visualforce|vf\//.test(value)) return "Visualforce";
  if (/apex|trigger|class|anonymous/.test(value)) return "Apex";
  return "Other";
}
function logTime(value?: string) {
  if (!value) return "Unknown time";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
function bridgeError(error: unknown, fallback: string) {
  const message = error instanceof Error ? error.message : "";
  if (/failed to fetch|load failed|networkerror/i.test(message)) {
    return "Local Salesforce bridge unavailable. Start `npm run dev -w @sflens/bridge` or continue in Demo mode.";
  }
  return message || fallback;
}
export function App() {
  const [raw, setRaw] = useState(demoLog),
    [mode, setMode] = useState<Mode>("Demo"),
    [query, setQuery] = useState(""),
    [selected, setSelected] = useState(1),
    [selectedLines, setSelectedLines] = useState<number[]>([]),
    [tab, setTab] = useState<"Findings" | "Limits" | "Compare" | "Related">("Findings"),
    [remote, setRemote] = useState<RemoteLogSummary[]>([]),
    [orgs, setOrgs] = useState<OrgSummary[]>([]),
    [org, setOrg] = useState(""),
    [bridge] = useState(bridgeDefault),
    authSession = useRef(""),
    relaySession = useRef(""),
    browserConnection = useRef<BrowserConnection | null>(null),
    autoSelected = useRef(false),
    [connectOpen, setConnectOpen] = useState(false),
    [status, setStatus] = useState(""),
    [loading, setLoading] = useState(false),
    [globalQuery, setGlobalQuery] = useState(""),
    [globalMatches, setGlobalMatches] = useState<GlobalMatch[]>([]),
    [globalSearched, setGlobalSearched] = useState(false),
    [globalSearching, setGlobalSearching] = useState(false),
    [filters, setFilters] = useState({ user: "", operation: "", status: "" }),
    [relatedGroups, setRelatedGroups] = useState<TransactionGroup[]>([]),
    [baseline, setBaseline] = useState<ParsedLog | null>(null),
    [comparison, setComparison] = useState<PerformanceComparison | null>(null),
    [debugEnabled, setDebugEnabled] = useState(false),
    [debugExpires, setDebugExpires] = useState<string | undefined>(),
    [ciOpen, setCiOpen] = useState(false),
    [moreOpen, setMoreOpen] = useState(false),
    [copied, setCopied] = useState(""),
    [hostedReadOnly, setHostedReadOnly] = useState(false);
  const parsed = useMemo(
    () =>
      parseLog(raw, {
        source:
          mode === "Demo"
            ? "fixture"
            : mode === "Connected"
              ? "salesforce"
              : "upload",
        name:
          mode === "Demo"
            ? "Curated N+1 + governor failure"
            : mode === "Connected"
              ? "Salesforce Apex log"
              : "Uploaded log",
        orgAlias: mode === "Connected" ? org : undefined,
      }),
    [raw, mode, org],
  );
  const visible = parsed.lines
    .map((line, i) => ({ line, i }))
    .filter(
      (x) => !query || x.line.toLowerCase().includes(query.toLowerCase()),
    );
  const api = async (path: string, init: RequestInit = {}) => {
    if (relaySession.current && hostedRelayUrl) {
      const response = await fetch(`${hostedRelayUrl}${path}`, {
        ...init,
        credentials: "omit",
        headers: { "x-sflens-session": relaySession.current, ...(init.headers || {}) },
      });
      if (!response.ok) {
        if (response.status === 401) relaySession.current = "";
        const error = await response.json().catch(() => ({}));
        throw Error(error.error || `SF Lens relay request failed (${response.status})`);
      }
      if (path.endsWith("/body")) return response.text();
      return response.json();
    }
    const browser = browserConnection.current;
    if (browser) {
      const logMatch = path.match(/^\/orgs\/([^/]+)\/logs(?:\/([^/]+)(?:\/body)?)?\??(.*)$/);
      const orgAlias = logMatch?.[1] ? decodeURIComponent(logMatch[1]) : "";
      const bodyId = logMatch?.[2] ? decodeURIComponent(logMatch[2]) : "";
      const query = logMatch?.[3] || "";
      if (path === "/orgs") return { orgs: [{ alias: browser.alias, username: browser.username, instanceUrl: browser.instanceUrl, orgId: browser.orgId }] };
      if (orgAlias && orgAlias !== browser.alias) throw Error("ORG_NOT_AUTHENTICATED");
      if (path.startsWith(`/orgs/${encodeURIComponent(browser.alias)}/debug-logging`)) throw Error("Hosted Salesforce connections are read-only. Use local mode to manage trace flags.");
      const endpoint = bodyId
        ? `/services/data/v${browserApiVersion}/tooling/sobjects/ApexLog/${encodeURIComponent(bodyId)}/Body`
        : `/services/data/v${browserApiVersion}/tooling/query?q=${encodeURIComponent(buildBrowserLogQuery(new URLSearchParams(query)))}`;
      const response = await fetch(`${browser.instanceUrl}${endpoint}`, {
        ...init,
        headers: { authorization: `Bearer ${browser.accessToken}`, ...(init.headers || {}) },
      });
      if (!response.ok) {
        if (response.status === 401) browserConnection.current = null;
        throw Error(`Salesforce request failed (${response.status})`);
      }
      if (bodyId) return response.text();
      const result = await response.json();
      return { records: (result.records || []).map((item: any) => ({
        id: item.Id,
        name: `${item.Operation || "Apex"} · ${item.StartTime || item.Id}`,
        startTime: item.StartTime,
        user: item.LogUser?.Name,
        operation: item.Operation,
        status: item.Status,
        size: item.LogLength,
        orgAlias: browser.alias,
      })) };
    }
    const r = await fetch(`${bridge}${path}`, {
      ...init,
      credentials: "include",
      headers: { ...(authSession.current ? { "x-sflens-session": authSession.current } : {}), ...(init.headers || {}) },
    });
    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      throw Error(e.error || `Bridge request failed (${r.status})`);
    }
    return r.json();
  };
  const buildBrowserLogQuery = (params: URLSearchParams) => {
    const limit = Math.min(100, Math.max(1, Number(params.get("limit") || 50)));
    const escapeSoql = (value: string) => value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    const where: string[] = [];
    if (params.get("user")) where.push(`LogUser.Name LIKE '%${escapeSoql(params.get("user")!)}%'`);
    if (params.get("operation")) where.push(`Operation LIKE '%${escapeSoql(params.get("operation")!)}%'`);
    if (params.get("status")) where.push(`Status = '${escapeSoql(params.get("status")!)}'`);
    if (params.get("from")) where.push(`StartTime >= ${escapeSoql(params.get("from")!)}`);
    if (params.get("to")) where.push(`StartTime <= ${escapeSoql(params.get("to")!)}`);
    return `SELECT Id,StartTime,LogUser.Name,Operation,Status,LogLength FROM ApexLog${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY StartTime DESC LIMIT ${limit}`;
  };
  const loadDebugStatus = async (alias = org) => {
    if (!alias) return;
    if (browserConnection.current) {
      setDebugEnabled(false);
      setDebugExpires(undefined);
      return;
    }
    try { const d = await api(`/orgs/${encodeURIComponent(alias)}/debug-logging`); setDebugEnabled(Boolean(d.enabled)); setDebugExpires(d.flags?.[0]?.ExpirationDate); } catch { setDebugEnabled(false); }
  };
  const ensureDebugLogging = async (alias: string) => {
    const current = await api(`/orgs/${encodeURIComponent(alias)}/debug-logging`);
    if (current.enabled) {
      setDebugEnabled(true);
      setDebugExpires(current.flags?.[0]?.ExpirationDate);
      return false;
    }
    const created = await api(`/orgs/${encodeURIComponent(alias)}/debug-logging`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ minutes: 15 }),
    });
    setDebugEnabled(Boolean(created.enabled));
    setDebugExpires(created.expiresAt);
    return true;
  };
  const toggleDebug = async () => {
    if (browserConnection.current) {
      setStatus("Hosted Salesforce access is read-only · use local mode to manage debug logging");
      return;
    }
    setLoading(true);
    try { const d = await api(`/orgs/${encodeURIComponent(org)}/debug-logging`, debugEnabled ? { method: "DELETE" } : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ minutes: 15 }) }); setDebugEnabled(Boolean(d.enabled)); setDebugExpires(d.expiresAt); setStatus(d.enabled ? "Debug logging enabled for 15 minutes" : "Debug logging disabled"); }
    catch (e) { setStatus(bridgeError(e, "Could not change debug logging.")); } finally { setLoading(false); }
  };
  const refresh = async (alias = org, silent = false) => {
    if (!alias) return;
    if (!silent) setLoading(true);
    try {
      const p = new URLSearchParams({ limit: "50" });
      Object.entries(filters).forEach(([k, v]) => v && p.set(k, v));
      const d = await api(`/orgs/${encodeURIComponent(alias)}/logs?${p}`);
      setRemote(d.records || []);
      if (!autoSelected.current && d.records?.length) {
        autoSelected.current = true;
        const newest = d.records[0] as RemoteLogSummary;
        try {
          const body = await api(`/orgs/${encodeURIComponent(newest.orgAlias)}/logs/${encodeURIComponent(newest.id)}/body`);
          setRaw(typeof body === "string" ? body : body.body || "");
          setSelected(1);
          setSelectedLines([]);
        } catch { /* the list remains usable if the newest body is unavailable */ }
      }
      if (!silent) setStatus(`${d.records?.length || 0} logs loaded`);
    } catch (e) {
      setStatus(bridgeError(e, "Could not load logs."));
    } finally {
      if (!silent) setLoading(false);
    }
  };
  const searchAllLogs = async () => {
    const term = globalQuery.trim().toLowerCase();
    if (!term || !org) return;
    setGlobalSearching(true);
    try {
      const params = new URLSearchParams({ limit: "100" });
      Object.entries(filters).forEach(([key, value]) => { if (value) params.set(key, value); });
      const listed = await api(`/orgs/${encodeURIComponent(org)}/logs?${params}`);
      const queue: RemoteLogSummary[] = listed.records || [];
      setRemote(queue);
      const matches: GlobalMatch[] = [];
      let cursor = 0;
      const worker = async () => {
        while (cursor < queue.length) {
          const summary = queue[cursor++];
          try {
            const d = await api(`/orgs/${encodeURIComponent(summary.orgAlias)}/logs/${encodeURIComponent(summary.id)}/body`);
            const text = typeof d === "string" ? d : d.body || "";
            const lines = text.split(/\r?\n/);
            const found = lines.flatMap((line: string, index: number) => line.toLowerCase().includes(term) ? [index + 1] : []);
            if (found.length) matches.push({ summary, lines: found.slice(0, 20) });
          } catch { /* an unavailable body should not block the other logs */ }
        }
      };
      await Promise.all([worker(), worker(), worker()]);
      setGlobalMatches(matches.sort((a, b) => (b.summary.startTime || "").localeCompare(a.summary.startTime || "")));
      setGlobalSearched(true);
      setStatus(`${matches.length} matching log${matches.length === 1 ? "" : "s"} · searched ${queue.length}`);
    } finally { setGlobalSearching(false); }
  };
  const startBrowserOAuth = async () => {
    if (!browserClientId) throw Error("Hosted Salesforce authorization is not configured yet. Continue in Demo mode or run SF Lens locally.");
    const start = await createSalesforceOAuthStart(browserOAuthConfig);
    remember("session", "sflens.oauth.state", start.state);
    remember("session", "sflens.oauth.verifier", start.verifier);
    window.location.assign(start.authorizationUrl);
  };
  const finishRelayConnection = async (session: string) => {
    if (!hostedRelayUrl || !session) throw Error("The hosted Salesforce session was missing.");
    relaySession.current = session;
    remember("session", "sflens.relay.session", session);
    window.history.replaceState({}, "", window.location.pathname);
    const d = await api("/orgs");
    if (!d.orgs?.length) throw Error("No Salesforce org was authorized.");
    setOrgs(d.orgs);
    setOrg(d.orgs[0].alias);
    setHostedReadOnly(true);
    setMode("Connected");
    setConnectOpen(false);
    autoSelected.current = false;
    setStatus("Connected · hosted read-only session");
    await refresh(d.orgs[0].alias);
    setStatus("Connected · hosted read-only session");
  };
  const finishBrowserConnection = async (code: string, state: string) => {
    const expectedState = stored("session", "sflens.oauth.state");
    const verifier = stored("session", "sflens.oauth.verifier");
    forget("session", "sflens.oauth.state");
    forget("session", "sflens.oauth.verifier");
    window.history.replaceState({}, "", window.location.pathname);
    if (!expectedState || !verifier || !state || state !== expectedState) throw Error("Salesforce authorization state was invalid. Start again.");
    if (!browserClientId) throw Error("Hosted Salesforce authorization is not configured yet.");
    const response = await fetch(new URL("/services/oauth2/token", browserLoginUrl), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: browserClientId,
        redirect_uri: browserOAuthConfig.redirectUri,
        code_verifier: verifier,
      }),
    });
    if (!response.ok) throw Error("Salesforce token exchange failed.");
    const fields: any = await response.json();
    if (!fields.access_token || !fields.instance_url || !fields.id) throw Error("Salesforce did not return a usable authorization.");
    const identity = await fetch(fields.id, { headers: { authorization: `Bearer ${fields.access_token}` } });
    if (!identity.ok) throw Error("Salesforce identity lookup failed.");
    const who: any = await identity.json();
    const connection: BrowserConnection = {
      accessToken: fields.access_token,
      instanceUrl: String(fields.instance_url).replace(/\/$/, ""),
      alias: salesforceOrgAlias(String(who.organization_id || ""), String(fields.instance_url)),
      username: who.username || "Salesforce user",
      orgId: who.organization_id || "",
    };
    browserConnection.current = connection;
    setHostedReadOnly(true);
    setOrgs([{ alias: connection.alias, username: connection.username, instanceUrl: connection.instanceUrl, orgId: connection.orgId }]);
    setOrg(connection.alias);
    autoSelected.current = false;
    setMode("Connected");
    setConnectOpen(false);
    setStatus("Connected · hosted read-only session");
    await refresh(connection.alias);
    setStatus("Connected · hosted read-only session");
  };
  const connect = async () => {
    setStatus("Opening Salesforce authorization…");
    try {
      if (isHostedPage()) {
        setConnectOpen(false);
        if (hostedRelayUrl) {
          window.location.assign(`${hostedRelayUrl}/oauth/start`);
          return;
        }
        await startBrowserOAuth();
        return;
      }
      const response = await fetch(`${bridge}/oauth/start`, { credentials: "include" });
      const data = await response.json();
      if (!response.ok) throw Error(data.error || "Salesforce authorization is not configured.");
      if (data.mode === "cli" && data.jobId) {
        authSession.current = data.session || "";
        setConnectOpen(false);
        setStatus("Salesforce opened in your browser. Finish authorization there…");
        for (let attempt = 0; attempt < 300; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          const poll = await fetch(`${bridge}/oauth/status/${encodeURIComponent(data.jobId)}`, { credentials: "include", headers: { "x-sflens-session": authSession.current } });
          const result = await poll.json();
          if (!poll.ok) throw Error(result.error || "Salesforce authorization could not be found.");
          if (result.status === "complete") {
            await finishConnection();
            return;
          }
          if (result.status === "error") throw Error(result.error || "Salesforce authorization did not complete.");
        }
        throw Error("Salesforce authorization timed out. Try again when the Salesforce window is ready.");
      }
      if (data.authorizationUrl) window.location.assign(data.authorizationUrl);
      else throw Error("Salesforce authorization could not be started.");
    } catch (e) { setStatus(bridgeError(e, "Could not start Salesforce authorization.")); setConnectOpen(true); }
  };
  const finishConnection = async () => {
    try {
      const d = await api("/orgs");
      if (!d.orgs?.length) throw Error("No Salesforce org was authorized.");
      setOrgs(d.orgs);
      setOrg(d.orgs[0].alias);
      setHostedReadOnly(false);
      autoSelected.current = false;
      remember("session", "sflens.orgAlias", d.orgs[0].alias);
      remember("local", "sflens.orgAlias", d.orgs[0].alias);
      if (authSession.current) remember("session", "sflens.authSession", authSession.current);
      setMode("Connected");
      setStatus("Connected · preparing debug logging…");
      const enabled = await ensureDebugLogging(d.orgs[0].alias);
      await refresh(d.orgs[0].alias);
      setStatus(enabled ? "Connected · debug logging enabled for 15 minutes" : "Connected · debug logging already enabled");
      window.history.replaceState({}, "", window.location.pathname);
    } catch (e) { setStatus(bridgeError(e, "Could not finish Salesforce authorization.")); setMode("Demo"); setConnectOpen(true); }
  };
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const oauthResult = params.get("oauth");
    const code = params.get("code");
    const state = params.get("state") || "";
    const relayHashSession = hashParams.get("sflens_session");
    if (isHostedPage() && hostedRelayUrl && relayHashSession) {
      void finishRelayConnection(relayHashSession).catch((error) => {
        forget("session", "sflens.relay.session");
        relaySession.current = "";
        setMode("Demo");
        setStatus(salesforceOAuthError(error, { hosted: true }));
        setConnectOpen(true);
      });
      return;
    }
    if (code && isHostedPage() && !hostedRelayUrl) {
      void finishBrowserConnection(code, state).catch((error) => {
        setMode("Demo");
        setStatus(salesforceOAuthError(error, { hosted: true }));
        setConnectOpen(true);
      });
      return;
    }
    if (oauthResult === "success") void finishConnection();
    else if (!oauthResult && !code) {
      if (isHostedPage()) {
        if (hostedRelayUrl) {
          const savedSession = stored("session", "sflens.relay.session");
          if (savedSession) {
            void finishRelayConnection(savedSession).catch(() => {
              forget("session", "sflens.relay.session");
              relaySession.current = "";
              setConnectOpen(true);
            });
          } else {
            setConnectOpen(true);
          }
          return;
        }
        setConnectOpen(true);
        return;
      }
      const savedAlias = stored("session", "sflens.orgAlias") || stored("local", "sflens.orgAlias");
      if (!savedAlias) { setConnectOpen(true); return; }
      void (async () => {
        try {
          const response = await fetch(`${bridge}/oauth/resume?alias=${encodeURIComponent(savedAlias)}`, { credentials: "include" });
          const data = await response.json();
          if (!response.ok) throw Error(data.error || "Saved Salesforce session expired.");
          authSession.current = data.session;
          setOrgs([data.org]);
          setOrg(data.org.alias);
          setMode("Connected");
          setStatus("Resuming local Salesforce session…");
          await loadDebugStatus(data.org.alias);
          await refresh(data.org.alias);
          setStatus("Connected · session resumed");
        } catch (e) {
          forget("session", "sflens.authSession");
          setMode("Demo");
          const message = bridgeError(e, "Saved Salesforce session could not be resumed. Continuing in Demo mode.");
          setStatus(/Local Salesforce bridge unavailable/.test(message) ? "" : message);
          setConnectOpen(true);
        }
      })();
    }
  }, []);
  useEffect(() => {
    if (mode === "Connected") refresh();
  }, [filters]);
  useEffect(() => {
    if (mode !== "Connected" || !org) return;
    const timer = window.setInterval(() => void refresh(org, true), 5000);
    return () => window.clearInterval(timer);
  }, [mode, org, filters]);
  useEffect(() => {
    if (mode !== "Connected" || tab !== "Related" || !remote.length) return;
    let cancelled = false;
    const hydrate = async () => {
      const queue = remote.slice(0, 20);
      const hydrated: { summary: RemoteLogSummary; parsed?: ParsedLog }[] = [];
      let cursor = 0;
      const worker = async () => {
        while (cursor < queue.length) {
          const summary = queue[cursor++];
          try {
            const body = await api(`/orgs/${encodeURIComponent(summary.orgAlias)}/logs/${encodeURIComponent(summary.id)}/body`);
            hydrated.push({ summary, parsed: parseLog(typeof body === "string" ? body : body.body || "", { source: "salesforce", id: summary.id, name: summary.name }) });
          } catch { /* unavailable candidates are ignored */ }
        }
      };
      await Promise.all([worker(), worker(), worker()]);
      if (!cancelled) setRelatedGroups(correlateTransactions(parsed, hydrated));
    };
    hydrate();
    return () => { cancelled = true; };
  }, [mode, tab, remote, parsed]);
  const load = async (l: RemoteLogSummary) => {
    setLoading(true);
    try {
      const d = await api(
        `/orgs/${encodeURIComponent(l.orgAlias)}/logs/${encodeURIComponent(l.id)}/body`,
      );
      setRaw(typeof d === "string" ? d : d.body || "");
      setSelected(1);
      setSelectedLines([]);
      setStatus(l.name);
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "Could not load log body.");
    } finally {
      setLoading(false);
    }
  };
  const upload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    if (f.size > 25 * 1024 * 1024) {
      alert("SFLens accepts logs up to 25 MB.");
      return;
    }
    const r = new FileReader();
    r.onload = () => {
      setMode("Upload");
      setRaw(String(r.result || ""));
    };
    r.readAsText(f);
  };
  const compareUpload = (e: React.ChangeEvent<HTMLInputElement>) => { const f = e.target.files?.[0]; if (!f || f.size > 25 * 1024 * 1024) return; const r = new FileReader(); r.onload = () => { const p = parseLog(String(r.result || ""), { source: "upload", name: `Baseline · ${f.name}` }); setBaseline(p); setComparison(comparePerformance(p, parsed)); setStatus(`Baseline loaded: ${f.name}`); }; r.readAsText(f); };
  const copyText = async (text: string, label: string) => {
    try {
      if (!navigator.clipboard?.writeText) throw Error("Clipboard unavailable");
      await navigator.clipboard.writeText(text);
      setCopied(label);
      setStatus(`${label} copied · redacted and local-only`);
      window.setTimeout(() => setCopied(""), 1800);
    } catch { setStatus("Clipboard unavailable · use the JSON export instead"); }
  };
  const copyAiContext = () => {
    const evidence = parsed.findings.flatMap((finding) => finding.evidence.flatMap((item) => {
      const rows = [];
      for (let line = item.lineStart; line <= (item.lineEnd || item.lineStart); line += 1) rows.push(`Line ${line}: ${redact(parsed.lines[line - 1] || "")}`);
      return rows;
    })).filter((value, index, all) => all.indexOf(value) === index);
    const findings = parsed.findings.map((finding) => `- [${finding.severity.toUpperCase()}] ${redact(finding.title)}: ${redact(finding.summary)}\n  Remediation: ${redact(remediationForFinding(finding))}\n  Evidence: ${finding.evidence.map((item) => `lines ${item.lineStart}-${item.lineEnd}`).join(", ")}`).join("\n");
    const limits = parsed.limits.map((limit) => `- ${limit.name}: ${limit.used}/${limit.max} (${limit.percent}%)`).join("\n") || "None observed";
    const context = `# SF Lens diagnosis\n\nAnalyze this redacted Salesforce debug-log diagnosis. Use only the evidence below; do not assume metadata or causality that is not shown.\n\n## Log\n- Name: ${redact(parsed.metadata.name)}\n- Source: ${parsed.metadata.source}\n- User: ${redact(parsed.metadata.user || "Unknown")}\n- Size: ${parsed.metadata.rawSize} bytes\n\n## Findings\n${findings || "None observed"}\n\n## Governor limits\n${limits}\n\n## Evidence lines\n${evidence.join("\n") || "None captured"}\n\n## Question\nExplain the most likely root cause, cite the evidence lines, and propose the smallest safe fix. Flag uncertainty clearly.`;
    void copyText(context, "AI diagnosis");
  };
  const copyLine = (line: string, number: number) => void copyText(`SF Lens evidence · line ${number}\n${redact(line)}`, `Line ${number}`);
  const copySelected = () => {
    if (!selectedLines.length) return;
    const excerpt = [...selectedLines].sort((a, b) => a - b).map((number) => `Line ${number}: ${redact(parsed.lines[number - 1] || "")}`).join("\n");
    void copyText(`SF Lens selected evidence\n${excerpt}`, `${selectedLines.length} lines`);
  };
  const exportIncident = (format: "json" | "html" | "sarif") => { const bundle = incidentBundle(parsed, format, comparison || undefined); const url = URL.createObjectURL(new Blob([bundle.content], { type: format === "html" ? "text/html" : "application/json" })); const a = document.createElement("a"); a.href = url; a.download = bundle.filename; a.click(); URL.revokeObjectURL(url); setStatus(`Downloaded redacted ${format.toUpperCase()} bundle`); };
  const disconnect = () => {
    authSession.current = "";
    relaySession.current = "";
    browserConnection.current = null;
    autoSelected.current = false;
    forget("session", "sflens.orgAlias");
    forget("session", "sflens.authSession");
    forget("session", "sflens.relay.session");
    forget("local", "sflens.orgAlias");
    setRemote([]);
    setOrgs([]);
    setOrg("");
    setHostedReadOnly(false);
    setMode("Demo");
    setRaw(demoLog);
    setStatus("Disconnected");
  };
  const showDemo = () => {
    autoSelected.current = false;
    relaySession.current = "";
    browserConnection.current = null;
    forget("session", "sflens.relay.session");
    setHostedReadOnly(false);
    setConnectOpen(false);
    setMode("Demo");
    setRaw(demoLog);
    setQuery("");
    setSelected(1);
    setSelectedLines([]);
    setTab("Findings");
    setRemote([]);
    setRelatedGroups([]);
    setBaseline(null);
    setComparison(null);
    setStatus("Demo log loaded");
  };
  const related = relatedGroups;
  return (
    <div className="shell">
      <header>
        <div className="brand">
          <span className="mark" aria-label="Magnifying glass">
            ⌕
          </span>
          <div>
            <h1>SF Lens</h1>
            <p>Salesforce debug intelligence</p>
          </div>
        </div>
        <div className="topbar-copy">
          <div className="eyebrow">
            DEBUG LOG EXPLORER <b>●</b> READ-ONLY DIAGNOSIS
          </div>
          <p>Parse Apex, Flow, SOQL, limits, and failures with evidence you can act on. Logs stay in this browser session.</p>
        </div>
        <div className="hero-actions">
          <button
            className={mode === "Demo" ? "active" : ""}
            onClick={showDemo}
          >
            ◈ Demo
          </button>
          <label className={mode === "Upload" ? "active" : ""}>
            ↥ Upload log
            <input type="file" accept=".log,.txt" onChange={upload} />
          </label>
          <div className="more-menu">
            <button className={moreOpen ? "active" : ""} onClick={() => setMoreOpen(!moreOpen)}>••• More</button>
            {moreOpen && <div className="more-popover">
              <label>
                ⇄ Compare baseline
                <input type="file" accept=".log,.txt" onChange={(e) => { setMoreOpen(false); compareUpload(e); }} />
              </label>
              <button onClick={() => { setMoreOpen(false); setCiOpen(true); }}>✓ CI/CD</button>
            </div>}
          </div>
          <button
            className={mode === "Connected" ? "active" : ""}
            onClick={() => mode === "Connected" ? disconnect() : setConnectOpen(true)}
          >
            ↯ {mode === "Connected" ? "Disconnect" : "Connected"}
          </button>
        </div>
        <div className="status">
          <i className={mode === "Connected" ? "online" : ""} />
          {mode === "Connected" ? "CONNECTED" : "LOCAL-ONLY"}
          <span>v0.2</span>
        </div>
      </header>
      <section className="metric-strip" aria-label="Current log overview">
        <div><span>FINDINGS</span><strong>{parsed.findings.length}</strong><small>{parsed.findings.filter((f) => f.severity === "critical").length} critical</small></div>
        <div><span>EVENTS</span><strong>{parsed.events.length}</strong><small>{parsed.unknownLines.length} unclassified</small></div>
        <div><span>LIMIT SNAPSHOTS</span><strong>{parsed.limits.length}</strong><small>Evidence-backed usage</small></div>
        <div><span>LOG SIZE</span><strong>{(parsed.metadata.rawSize / 1024).toFixed(1)}<small> KB</small></strong><small>{mode === "Connected" ? "From Salesforce" : "Stays local"}</small></div>
      </section>
      {mode === "Connected" && (
        <section className="connection-bar">
          <span className="connection-label">ORG</span>
          <select
            value={org}
            onChange={(e) => {
              autoSelected.current = false;
              setOrg(e.target.value);
              loadDebugStatus(e.target.value);
              refresh(e.target.value);
            }}
          >
            {orgs.map((o) => (
              <option key={o.alias} value={o.alias}>
                {o.alias} · {o.username}
              </option>
            ))}
          </select>
          <button onClick={() => refresh()} disabled={loading}>
            {loading ? "Loading…" : "Refresh logs"}
          </button>
          {hostedReadOnly ? (
            <span className="debug-help hosted-readonly">Hosted read-only · trace flags require local mode</span>
          ) : (
            <>
              <button className={debugEnabled ? "debug-on" : ""} onClick={toggleDebug} disabled={loading}>
                {debugEnabled ? "Disable debug logging" : "Enable debug logging"}
              </button>
              <span className="debug-help">{debugEnabled ? `Capturing for 15 minutes${debugExpires ? ` · until ${new Date(debugExpires).toLocaleTimeString()}` : ""}` : "Creates a temporary user trace flag"}</span>
            </>
          )}
          <span className="muted">{status}</span>
        </section>
      )}
      <main>
        <aside className="panel logs">
          <div className="panel-title">
            LOGS <span><i className="live-dot" /> LIVE · {remote.length}</span>
          </div>
          {mode === "Connected" && (
            <div className="filters">
              <input placeholder="User" value={filters.user} onChange={(e) => setFilters({ ...filters, user: e.target.value })} />
              <input placeholder="Operation" value={filters.operation} onChange={(e) => setFilters({ ...filters, operation: e.target.value })} />
              <select value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })}>
                <option value="">Any status</option><option>Success</option><option>Failure</option>
              </select>
              <div className="global-search">
                <input aria-label="Search all loaded logs" placeholder="Search up to 100 recent log contents…" value={globalQuery} onChange={(e) => { setGlobalQuery(e.target.value); setGlobalSearched(false); }} onKeyDown={(e) => { if (e.key === "Enter") void searchAllLogs(); }} />
                <button onClick={() => void searchAllLogs()} disabled={globalSearching || !globalQuery.trim()}>{globalSearching ? "Searching…" : "Search all"}</button>
              </div>
            </div>
          )}
          {mode === "Connected" && loading ? (
            <div className="log-skeletons" aria-label="Loading logs">
              {Array.from({ length: 7 }, (_, index) => <div className="log-skeleton" key={index}><i /><div><b /><span /><span /></div></div>)}
            </div>
          ) : mode === "Connected" ? (
            globalSearched ? (
              globalMatches.length ? (
              <>
                <div className="search-summary">{globalMatches.length} logs match “{globalQuery}”</div>
                {globalMatches.map(({ summary, lines }) => <button className="log-card search-result" key={`match-${summary.id}`} onClick={() => { setQuery(globalQuery); void load(summary); setSelected(lines[0] || 1); }}>
                  <span className={`log-type ${logKind(summary.operation, summary.name).toLowerCase()}`}>{logKind(summary.operation, summary.name)}</span>
                  <div><strong>{summary.name}</strong><small>{logTime(summary.startTime)} · {summary.user || "Unknown user"}</small><small className="log-detail">{lines.length} matching line{lines.length === 1 ? "" : "s"} · first line {lines[0]}</small></div><b>›</b>
                </button>)}
              </>
              ) : <div className="empty-hint">No matching lines found in the {remote.length} loaded logs.</div>
            ) : remote.length ? (
              remote.map((l) => (
                <button className="log-card" key={l.id} onClick={() => load(l)}>
                  <span className={`log-type ${logKind(l.operation, l.name).toLowerCase()}`}>{logKind(l.operation, l.name)}</span>
                  <div>
                    <strong>{l.name}</strong>
                    <small>
                      {logTime(l.startTime)} · {l.user || "Unknown user"}
                    </small>
                    <small className="log-detail">{l.status || "Unknown status"} · {l.size ? `${Math.round(l.size / 1024)} KB` : "size unknown"} · {l.id.slice(-8)}</small>
                  </div>
                  <b>›</b>
                </button>
              ))
            ) : (
              <div className="empty-hint">
                No ApexLogs match these filters. Enable a trace flag manually in
                Salesforce, then refresh.
              </div>
            )
          ) : (
            <>
              <div className="log-card selected">
                <div className="severity-dot" />
                <div>
                  <strong>{parsed.metadata.name}</strong>
                  <small>
                    {(parsed.metadata.rawSize / 1024).toFixed(1)} KB · local
                  </small>
                </div>
                <b>›</b>
              </div>
              <div className="empty-hint">
                Drop a log here to compare a baseline.
              </div>
            </>
          )}
        </aside>
        <section className="panel viewer" aria-busy={loading}>
          <div className="toolbar">
            <input
              placeholder="Search raw log…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <span>
              {parsed.events.length} events · {parsed.unknownLines.length}{" "}
              unknown
            </span>
            <span className="selection-help">Shift-click to select a range</span>
            <button className="copy-selected" onClick={copySelected} disabled={!selectedLines.length}>
              {selectedLines.length ? `Copy ${selectedLines.length} selected` : "Copy selected"}
            </button>
          </div>
          <div className="timeline-wrap">
            <div className="timeline">
              {visible.slice(0, 350).map(({ line, i }) => (
              <div
                key={i}
                role="button"
                tabIndex={0}
                className={"line " + (i + 1 === selected ? "picked " : "") + (selectedLines.includes(i + 1) ? "evidence-selected" : "")}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    setSelected(i + 1);
                    setSelectedLines([i + 1]);
                  }
                }}
                onClick={(event) => {
                  const lineNumber = i + 1;
                  if (event.shiftKey) {
                    const start = Math.min(selected, lineNumber);
                    const end = Math.max(selected, lineNumber);
                    setSelectedLines(Array.from({ length: end - start + 1 }, (_, offset) => start + offset));
                  } else {
                    setSelected(lineNumber);
                    setSelectedLines([lineNumber]);
                  }
                }}
              >
                <span>{String(i + 1).padStart(4, "0")}</span>
                <code>{redact(line)}</code>
                <button className="copy-line" aria-label={`Copy line ${i + 1}`} onClick={(event) => { event.stopPropagation(); copyLine(line, i + 1); }}>{copied === `Line ${i + 1}` ? "Copied" : "Copy"}</button>
                {parsed.events.find((e) => e.line === i + 1)?.kind ===
                  "FLOW" && <em className="flow-badge">FLOW</em>}
                </div>
              ))}
            </div>
            {loading && <div className="console-loading" role="status"><div className="loading-spinner" /><span>Loading log body…</span></div>}
          </div>
        </section>
        <aside className="panel insights">
          <div className="tabs">
            {(["Findings", "Limits", "Compare", "Related"] as const).map((t) => (
              <button
                className={tab === t ? "selected" : ""}
                key={t}
                onClick={() => setTab(t)}
              >
                {t}
                {t === "Findings" && <b>{parsed.findings.length}</b>}
                {t === "Related" && <b>{related.length}</b>}
              </button>
            ))}
          </div>
          {tab === "Findings" && <div className="export-actions panel-actions"><span>Redacted incident bundle</span><button className="ai-copy" onClick={copyAiContext}>{copied === "AI diagnosis" ? "Copied for AI" : "Copy for AI"}</button><button onClick={() => exportIncident("html")}>HTML</button><button onClick={() => exportIncident("json")}>JSON</button><button onClick={() => exportIncident("sarif")}>SARIF</button></div>}
          {tab === "Findings" &&
            parsed.findings.map((f) => (
              <button
                className={"finding " + f.severity}
                key={f.id}
                onClick={() => setSelected(f.evidence[0].lineStart)}
              >
                <div>
                  <b>{f.title}</b>
                  <small>{f.summary}</small>
                  <em>
                    {f.ruleId} · line {f.evidence[0].lineStart}
                    {f.metadata?.flow ? " · Flow context" : ""}
                  </em>
                </div>
                <strong>›</strong>
              </button>
            ))}
          {tab === "Limits" &&
            parsed.limits.map((l) => (
              <div className="limit" key={l.name}>
                <div>
                  <b>{l.name}</b>
                  <span>
                    {l.used} / {l.max}
                  </span>
                </div>
                <div className="bar">
                  <i
                    style={{
                      width: `${Math.min(l.percent, 100)}%`,
                      background:
                        l.percent >= 90
                          ? "#ff6b6b"
                          : l.percent >= 70
                            ? "#ffc857"
                            : "#62e6a7",
                    }}
                  />
                </div>
              </div>
            ))}
          {tab === "Compare" && (
            baseline && comparison ? <div className="compare-card"><strong>Baseline → current</strong><small>{baseline.metadata.name} → {parsed.metadata.name}</small>{comparison.deltas.map((d) => <div className="delta" key={d.name}><span>{d.label}</span><b>{d.delta === undefined ? "—" : `${d.delta > 0 ? "+" : ""}${d.delta.toLocaleString()}`}</b><small>{d.explanation}</small></div>)}<div className="export-actions"><button onClick={() => exportIncident("html")}>HTML bundle</button><button onClick={() => exportIncident("json")}>JSON</button><button onClick={() => exportIncident("sarif")}>SARIF</button></div></div> : <div className="empty-hint">Choose “Compare baseline” to load an earlier log. SF Lens will show CPU, heap, SOQL, DML, callout, and query-row deltas with budget remaining.</div>
          )}
          {tab === "Related" &&
            (related.length ? (
              related.map((g) => (
                <div className="related" key={g.id}>
                  <b>{g.confidence} confidence</b>
                  <strong>{g.title}</strong>
                  <small>{g.candidates.map((c) => c.name).join(" → ")}</small>
                  <em>Observed evidence only</em>
                </div>
              ))
            ) : (
              <div className="empty-hint">
                No confirmed related transaction found in the loaded summaries.
              </div>
            ))}
          {tab === "Findings" &&
            parsed.spans.filter((s) => s.kind === "FLOW").length > 0 && (
              <div className="flow-context">
                <div className="panel-title">FLOW PATHS</div>
                {parsed.spans
                  .filter((s) => s.kind === "FLOW")
                  .map((s) => (
                    <div
                      key={s.id}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          setSelected(s.startLine);
                        }
                      }}
                      onClick={() => setSelected(s.startLine)}
                    >
                      {s.flow?.path?.join(" → ") || s.label}
                      <small>
                        line {s.startLine}
                        {s.endLine ? `–${s.endLine}` : ""}
                      </small>
                    </div>
                  ))}
              </div>
            )}
        </aside>
      </main>
      <footer>
        <span>◉ Browser sandbox · uploaded files stay local</span>
        <span>{status || "Read-only diagnosis"}</span>
      </footer>
      {ciOpen && (
        <div className="modal-backdrop">
          <div className="modal">
            <h3>CI/CD mode</h3>
            <p>Upload a log locally to preview the same deterministic gate used in pull requests. The repository workflow runs Salesforce Code Analyzer, publishes SARIF/HTML artifacts, and fails when new critical findings are detected.</p>
            <div className="ci-status"><b>{parsed.findings.filter((f) => f.severity === "critical").length ? "Critical findings detected" : "No critical findings detected"}</b><span>{parsed.findings.length} total findings · {baseline ? "comparison available" : "single-log analysis"}</span></div>
            <div className="modal-actions"><button onClick={() => setCiOpen(false)}>Close</button><button className="active" onClick={() => exportIncident("sarif")}>Download SARIF</button></div>
          </div>
        </div>
      )}
      {connectOpen && (
        <div className="modal-backdrop">
          <div className="modal">
            <h3>Connect Salesforce</h3>
            <p>{isHostedPage() ? "Authorize SF Lens through Salesforce. No local install or bridge is required for the hosted read-only connection." : "Authorize SF Lens to read existing ApexLogs from your Salesforce org. Salesforce will show its normal login and consent screen, then return you here."}</p>
            <div className="ci-status"><b>Secure · read-only · no hosted log archive</b><span>{hostedRelayUrl ? "Salesforce handles your sign-in. The relay keeps only a short-lived access token in volatile memory, never stores logs, and sends bounded log data to this browser for local redaction before display or export." : isHostedPage() ? "Salesforce handles your sign-in. SF Lens requests API access, keeps the access token only in this tab’s memory, and redacts logs before display or export." : "Your credentials stay with Salesforce and the local bridge. Logs are processed in this browser session and never sent to a hosted service."}</span></div>
            {isHostedPage() && <small className="auth-help">If your browser reports <code>ERR_BLOCKED_BY_CLIENT</code>, allowlist only the SF Lens relay and Salesforce login/org hosts in that browser’s privacy or security extension. Do not disable browser security globally.</small>}
            {isHostedPage() && !hostedRelayUrl && !browserClientId && <small className="error">Hosted authorization is not configured on this deployment yet. Continue in Demo mode or run SF Lens locally.</small>}
            <div className="modal-actions">
              <button onClick={showDemo}>Continue in Demo</button>
              <button
                className="active"
                onClick={connect}
                disabled={isHostedPage() && !hostedRelayUrl && !browserClientId}
              >
                {isHostedPage() ? "Authorize in Salesforce" : "Authorize Salesforce"}
              </button>
            </div>
            {status && <small className="error">{status}</small>}
          </div>
        </div>
      )}
    </div>
  );
}
if (typeof document !== "undefined") {
  const root = document.getElementById("root");
  if (root) createRoot(root).render(<App />);
}
