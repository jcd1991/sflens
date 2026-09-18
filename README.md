# SF Lens

## Salesforce debug intelligence for the moment an incident gets noisy

**See the signal. Understand the cause. Share evidence safely.**<br>
A local-first Salesforce debug workspace for Apex and Flow incidents — with evidence-backed diagnosis instead of blind guessing.

[Live demo](https://jcd1991.github.io/sflens/) · [Quick start](#run-it-locally) · [Authorization flow](#authorization-flow) · [Architecture & security](#architecture-at-a-glance)

[![CI](https://github.com/jcd1991/sflens/actions/workflows/sflens-ci.yml/badge.svg)](https://github.com/jcd1991/sflens/actions/workflows/sflens-ci.yml) [![Live demo](https://img.shields.io/badge/live%20demo-GitHub%20Pages-62e6a7)](https://jcd1991.github.io/sflens/)

SF Lens parses Apex and Flow logs in the browser, explains governor-limit pressure and failure patterns, connects related transactions using evidence already present in the logs, and packages a redacted diagnosis for a teammate or AI coding assistant.

The public site is a safe Demo/Upload experience. Connected Salesforce access stays local through a loopback bridge and Salesforce CLI.

## The 30-second story

When a Salesforce transaction fails, the useful question is not just “what line crashed?” It is:

> What happened, what evidence proves it, and what is the smallest safe next step?

SF Lens turns a raw log into a reviewable incident path:

```text
Salesforce log
      ↓
redacted timeline + deterministic parser
      ↓
findings, Flow path, limits, and related transactions
      ↓
copy for AI · export HTML/JSON/SARIF · compare with a baseline
```

It is intentionally bounded. SF Lens does not become a hosted log archive, execute Apex, deploy metadata, or invent causality that the logs cannot prove.

## What you can demo

| Moment | What someone sees | Why it matters |
| --- | --- | --- |
| 1 · Explore | A curated synthetic log with an N+1 query pattern and limit failure | Learn the interface without connecting an org |
| 2 · Connect | Salesforce’s normal browser authorization flow | Read existing `ApexLog` records without entering credentials into the app |
| 3 · Investigate | Findings, evidence lines, Flow breadcrumbs, and governor budgets | Move from “the log is huge” to a focused diagnosis |
| 4 · Compare | Baseline → current CPU, heap, SOQL, DML, callout, and query-row deltas | See whether a change improved or regressed runtime pressure |
| 5 · Share | Redacted AI prompt, HTML, JSON, or SARIF bundle | Hand off useful evidence without blindly exposing raw debug output |
| 6 · Automate | Local stdio MCP tools for the same bounded analysis | Bring the diagnosis into Cursor, Devin, ChatGPT, or another MCP client |

## Feature tour

### Flow-first diagnosis

SF Lens recognizes Flow interview and element lifecycle markers and builds evidence-backed paths such as:

```text
Opportunity Flow → Loop Contacts → Update Records
```

It can surface failed elements, database work observed inside loops, subflow/recursion signals, Flow-specific limit pressure, and interviews that started without a matching finish marker when the log is not truncated. Findings always point back to source lines.

### Governor-limit and performance analysis

The Limits panel shows observed CPU, heap, SOQL, DML, callout, and query-row usage. The Compare panel accepts a second log and reports deltas plus the remaining budget when Salesforce exposed a maximum in the log.

### Related transactions

SF Lens groups candidate transactions using native evidence such as request IDs, async job IDs, Flow interview IDs, class or operation names, users, and timestamps:

- **Exact** — a native identifier is shared;
- **Strong** — a producer/enqueue identifier matches an async job or candidate transaction;
- **Possible** — user and execution context are nearby, but causality is not proven.

Possible matches are labeled as heuristic. If no native relationship is observable, SF Lens says so.

### Evidence you can take with you

- Copy one redacted log line with its line number.
- Shift-click to select a range, then copy the selected lines.
- Use **Copy for AI** to create a redacted diagnosis prompt with findings, limits, remediation, and evidence.
- Export **HTML**, **JSON**, or **SARIF** incident bundles with severity, remediation notes, and evidence lines.

## Run it locally

Requires **Node 24 LTS**.

```bash
npm ci
npm run dev
```

Open the Vite URL printed in the terminal.

### Demo mode

Demo mode loads a synthetic fixture. It does not contact Salesforce and is the fastest way to see the parser, findings, limits, Flow UI, copy actions, and exports.

### Upload mode

Click **Upload log** and select a `.log` or `.txt` file up to 25 MB. The file is parsed locally in the browser and is not sent to an SF Lens server.

## Connect a Salesforce org

Connected mode reads existing Salesforce `ApexLog` records through a local bridge. The normal path uses Salesforce CLI’s browser authorization; no Connected App, client ID, password, bridge URL, or startup token needs to be entered into the web UI.

### Authorization flow

1. Start the bridge in a second terminal:

   ```bash
   npm run dev -w @sflens/bridge
   ```

2. Open SF Lens locally, or open [the hosted site](https://jcd1991.github.io/sflens/) while the bridge is running.
3. Click **Connected**, then **Authorize Salesforce**.
4. Salesforce CLI opens Salesforce’s normal login and authorization screen.
5. Sign in to the personal or Developer Edition org you want to inspect.
6. Return to SF Lens. The app discovers the newly authorized local org and loads recent logs.

Keep the bridge terminal running while connected. Salesforce CLI retains its local authorization, so credentials generally do not need to be entered again. The SF Lens browser session is temporary and can be renewed without changing Salesforce data.

### Generate a useful log

Salesforce creates debug logs only while a trace flag is active:

1. Select the authorized org in SF Lens.
2. Click **Enable debug logging**.
3. Reproduce the issue in Salesforce as the traced user.
4. Wait a few seconds while SF Lens refreshes recent log summaries.
5. Select the newest log and inspect Findings, Limits, Compare, or Related.
6. Click **Disable debug logging** when finished.

The debug control creates a temporary `USER_DEBUG` trace flag for the authenticated user for 15 minutes by default. It does not create records, deploy metadata, run Apex, or modify unrelated trace flags.

### Connected controls

- **Org selector** — choose the authorized local org.
- **Refresh logs** — retrieve the latest summaries immediately.
- **Filters** — narrow by user, operation, status, or time window.
- **Search all logs** — search up to 100 recent log bodies, fetched only for the current search.
- **Auto-refresh** — refresh recent-log summaries every five seconds.
- **More** — open Compare baseline and CI/CD tools without crowding the primary toolbar.

## Architecture at a glance

```text
┌──────────────────────────────┐
│ React/Vite web app            │
│ Demo · Upload · Connected UI  │
└──────────────┬───────────────┘
               │ localhost / approved Pages origin
┌──────────────▼───────────────┐
│ Local loopback bridge         │
│ Salesforce CLI + Tooling API │
│ bounded read-only routes     │
└──────────────┬───────────────┘
               │ existing ApexLog records only
        ┌──────▼──────┐
        │ Salesforce  │
        └─────────────┘

packages/core → parser, contracts, findings, redaction, comparison, fixtures
apps/mcp      → local stdio MCP adapter over the same bounded interfaces
```

### Package layout

- `packages/core` — shared contracts, parser, deterministic rules, redaction, comparison, correlation, and fixtures.
- `apps/web` — React/Vite explorer, Demo/Upload/Connected UI, exports, and AI copy actions.
- `apps/bridge` — local Salesforce CLI and Tooling API reader. It does not persist logs or records.
- `apps/mcp` — local stdio MCP server using the fixture by default or connected bridge data when configured.

## MCP companion

Build and run the local stdio server:

```bash
npm run build -w @sflens/mcp
node apps/mcp/dist/index.js
```

Without bridge configuration, MCP uses the synthetic fixture. For connected analysis:

```bash
SFLENS_BRIDGE_URL=http://127.0.0.1:8787 \
SFLENS_BRIDGE_TOKEN=<token-from-bridge> \
SFLENS_ORG_ALIAS=<authorized-alias> \
node apps/mcp/dist/index.js
```

The convenience launcher starts both local processes and passes the short-lived token internally:

```bash
node scripts/sflens-mcp-local.mjs
```

Available tools include `list_debug_logs`, `get_log_summary`, `get_log_excerpt`, `search_debug_logs`, `analyze_debug_log`, `compare_debug_logs`, `create_reproduction_checklist`, and `export_incident_bundle`.

All tools are bounded, redaction-aware, and read-only with respect to Salesforce data. The MCP server does not enable logging, change records, deploy metadata, or execute Apex.

## Security posture and deliberate boundaries

- Salesforce credentials are handled by Salesforce CLI’s local authorization flow.
- OAuth access tokens remain in local bridge memory or Salesforce CLI’s local store.
- Connected sessions use a local HttpOnly cookie; tokens are not put in URLs, `localStorage`, rendered errors, or build output.
- Raw log bodies remain in browser memory and are redacted before display, copy, or export.
- The bridge binds to `127.0.0.1` and allows localhost plus the published GitHub Pages origin by default. Set `SFLENS_WEB_ORIGINS` for a fork or custom domain.
- GitHub Pages is static and supports Demo/Upload only; Connected mode requires the local bridge.
- The ignored `.sflens-test-org.json` file is local test configuration and must never be committed.
- EventLogFile observability is intentionally not included in this release; retention and availability depend on org type and Event Monitoring entitlement.

SF Lens does not provide a hosted log archive, shared backend, automatic replay, generic recovery, arbitrary SOQL, arbitrary Apex execution, metadata deployment, or an embedded LLM.

## Troubleshooting

### “Failed to fetch”

Confirm that the local bridge is still running. When using the hosted site, confirm that `https://jcd1991.github.io` is in the bridge’s allowed origins, then reload and reconnect.

### `OAUTH_NOT_CONFIGURED`

Use **Authorize Salesforce** with the local bridge. A separately configured External Client App is only needed for the optional direct PKCE OAuth path; it is not required for Salesforce CLI authorization.

### `localhost:1717/OauthSuccess` or connection refused

That is Salesforce CLI’s local callback listener. Keep the bridge/CLI process running, finish the Salesforce authorization page, and retry. It is not a public SF Lens endpoint.

### No logs appear

Enable a trace flag, reproduce the action as the traced user, wait a few seconds, and click **Refresh logs**. Salesforce log availability and retention depend on trace settings and org limits.

## CI and portfolio proof

Every push and pull request runs:

```bash
npm test
npm run typecheck
npm run build
```

The workflow also runs Salesforce Code Analyzer against authored TypeScript/TSX source and uploads SARIF/HTML reports. Compiled bundles, CSS, and engines requiring Apex/Flow or Java runtimes are excluded; see [`code-analyzer.yml`](code-analyzer.yml). Analyzer findings are currently reported but non-blocking while the TypeScript rule profile is tuned. Tests, type checks, builds, and the optional committed-log gate remain blocking.

Before publishing, confirm that real logs, screenshots, org usernames, OAuth URLs, `.env` files, Salesforce session files, and `.sflens-test-org.json` are not staged.

## License

[MIT](LICENSE)
