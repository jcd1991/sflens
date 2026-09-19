<div align="center">

# SF Lens

<hr>

### **See the signal. Understand the cause. Share evidence safely.**

<p><strong>A local-first Salesforce debugging workspace for Apex and Flow incidents — with evidence-backed findings instead of blind guessing.</strong></p>

[![CI](https://img.shields.io/github/actions/workflow/status/jcd1991/sflens/sflens-ci.yml?branch=main&label=CI&style=flat-square&labelColor=4b5563)](https://github.com/jcd1991/sflens/actions/workflows/sflens-ci.yml) [![SALESFORCE](https://img.shields.io/badge/SALESFORCE-APEX%20%2B%20FLOW-1476d4?style=flat-square&labelColor=4b5563)](#feature-tour) [![SECURITY](https://img.shields.io/badge/SECURITY-LOCAL%20%2B%20REDACTED-16b894?style=flat-square&labelColor=4b5563)](#security-posture-and-deliberate-boundaries) [![MCP](https://img.shields.io/badge/MCP-COMPANION%20SERVER-7c3aed?style=flat-square&labelColor=4b5563)](#mcp-companion)

[Live demo](https://jcd1991.github.io/sflens/) · [Quick start](#run-it-locally) · [Authorization flow](#hosted-authorization) · [Architecture](#architecture-at-a-glance) · [Security](#security-posture-and-deliberate-boundaries)

</div>

SF Lens parses Apex and Flow logs in the browser, explains governor-limit pressure and failure patterns, connects related transactions using evidence already present in the logs, and packages a redacted diagnosis for a teammate or AI coding assistant. The public site supports Demo, Upload, and hosted read-only Salesforce authorization through the SF Lens relay. Local mode adds the loopback bridge and trace-flag controls.

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

## What SF Lens does not do

SF Lens is intentionally bounded. It is not a hosted log archive and it does not execute Apex, deploy metadata, or invent causality that the logs cannot prove.

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

This starts both the Vite web app and the local Salesforce bridge. Open the Vite URL printed in the terminal. Keep this process running while using Connected mode.

### Demo mode

Demo mode loads a synthetic fixture. It does not contact Salesforce and is the fastest way to see the parser, findings, limits, Flow UI, copy actions, and exports.

### Upload mode

Click **Upload log** and select a `.log` or `.txt` file up to 25 MB. The file is parsed locally in the browser and is not sent to an SF Lens server.

## Connect a Salesforce org

SF Lens has two connection paths:

- **Hosted Connect** uses Salesforce OAuth authorization-code + PKCE through the small Cloudflare Worker relay configured for the public demo. It needs no install, terminal, or per-org CORS setup, is read-only, and keeps only a short-lived access token in relay memory. Log bodies are bounded in the relay, then redacted in the browser before display, copy, or export.
- **Local Connect** uses Salesforce CLI through the loopback bridge. It is the advanced path and is required for the optional **Enable debug logging** / **Disable debug logging** controls.

The hosted path uses one Salesforce OAuth app configured by the SF Lens maintainer—not a new app in every customer org. The relay callback is configured on that app; users only complete Salesforce’s normal authorization screen. The Salesforce OAuth app must use PKCE and allow the relay callback URL.

```text
https://sflens-relay.carito5290.workers.dev/oauth/callback
```

Use a public-client Salesforce External Client App or Connected App with PKCE enabled and the `api` scope. The relay calls Salesforce server-to-server, so target orgs do not need to add the GitHub Pages origin to their CORS allowlist. Do not add a client secret to this repository or to Vite build output; the flow is intentionally a public client.

### Hosted authorization

1. Open [the hosted site](https://jcd1991.github.io/sflens/).
2. Click **Authorize in Salesforce**.
3. Complete Salesforce’s normal sign-in and consent screen.
4. SF Lens loads recent `ApexLog` summaries and automatically opens the most recent available log.

The hosted connection reads `ApexLog` summaries and bodies through the relay. It does not enable trace flags, modify records, deploy metadata, execute Apex, or store logs. The relay session is short-lived and held in volatile Worker memory; users may need to authorize again after a session expires or the Worker is recycled.

### Local authorization

1. Start SF Lens locally:

   ```bash
   npm run dev
   ```

2. Open SF Lens locally.
3. Click **Connected**, then **Authorize Salesforce**.
4. Salesforce CLI opens Salesforce’s normal login and authorization screen.
5. Sign in to the personal or Developer Edition org you want to inspect.
6. Return to SF Lens. The app discovers the newly authorized local org and loads recent logs.

Keep the local SF Lens process running while connected. Salesforce CLI retains its authorization locally on that machine, so credentials generally do not need to be entered again. The bridge session is temporary and can be renewed without changing Salesforce data.

### Generate a useful log

Salesforce creates debug logs only while a trace flag is active:

1. Select the authorized org in SF Lens.
2. Click **Enable debug logging**.
3. Reproduce the issue in Salesforce as the traced user.
4. Wait a few seconds while SF Lens refreshes recent log summaries.
5. Select the newest log and inspect Findings, Limits, Compare, or Related.
6. Click **Disable debug logging** when finished.

The debug control creates a temporary `USER_DEBUG` trace flag for the authenticated user for 15 minutes by default. It does not create records, deploy metadata, or run Apex. **Disable debug logging removes active trace flags for that user**, so review any manually configured trace flag before using the control.

### Connected controls

- **Org selector** — choose the authorized org.
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
                                        │
                         ┌──────────────▼───────────────┐
                         │ Browser parser + redaction    │
                         └──────────────┬───────────────┘
                           hosted        │ local
                  ┌────────▼────────┐    ┌▼────────────────────┐
                  │ Cloudflare      │    │ Loopback bridge     │
                  │ Worker relay    │    │ Salesforce CLI/API │
                  │ OAuth + reads   │    │ trace flags local  │
                  └────────┬────────┘    └──────────┬─────────┘
                           └──────────────┬──────────┘
                                          ▼
                                   ┌─────────────┐
                                   │ Salesforce  │
                                   │ ApexLog     │
                                   └─────────────┘

packages/core → parser, contracts, findings, redaction, comparison, fixtures
apps/mcp      → local stdio MCP adapter over the same bounded interfaces
```

### Package layout

- `packages/core` — shared contracts, parser, deterministic rules, redaction, comparison, correlation, and fixtures.
- `apps/web` — React/Vite explorer, Demo/Upload/Connected UI, exports, and AI copy actions.
- `apps/bridge` — local Salesforce CLI and Tooling API reader. It does not persist logs or records.
- `apps/mcp` — local stdio MCP server using the fixture by default or connected bridge data when configured.
- `workers/sflens-relay` — optional Cloudflare Worker for hosted OAuth + bounded read-only `ApexLog` reads. See [`docs/security-and-hosted-auth.md`](docs/security-and-hosted-auth.md) before deploying it.

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

The hosted authorization threat model, deployment procedure, incident response, and security review checklist live in [`docs/security-and-hosted-auth.md`](docs/security-and-hosted-auth.md). The short version:

- Salesforce credentials are handled by Salesforce’s own authorization screen or Salesforce CLI’s local authorization flow.
- Hosted OAuth access tokens remain in short-lived Worker memory only. The browser receives an opaque session ID in a fragment, removes it from the address bar, and keeps it only in `sessionStorage`.
- The public GitHub Pages build does not receive a Salesforce client secret or hosted access token. The Worker secret is configured with Wrangler, outside Git and Pages artifacts. The relay returns bounded log data; redaction happens in the browser before display, copy, or export.
- Raw log bodies remain in browser memory. Review every export before sharing.
- The hosted relay exposes only bounded, read-only `ApexLog` routes. It cannot enable logging, execute Apex, deploy metadata, run arbitrary SOQL, or write Salesforce data.
- The local bridge binds to `127.0.0.1`, checks its origin allowlist, binds cookie sessions to one authorized org, and uses a short-lived session cookie/startup token. By default it allows only the local Vite origins; adding a public origin requires an explicit `SFLENS_WEB_ORIGINS` override. Debug-flag controls remain local-only.
- The ignored `.sflens-test-org.json` file is local test configuration and must never be committed.
- EventLogFile observability is intentionally not included in this release; retention and availability depend on org type and Event Monitoring entitlement.

SF Lens does not provide a hosted log archive, shared backend, automatic replay, generic recovery, arbitrary SOQL, arbitrary Apex execution, metadata deployment, or an embedded LLM.

## Troubleshooting

### “Failed to fetch”

For Hosted Connect, confirm the relay is deployed, its Salesforce client ID secret is set, and the Salesforce app callback matches the relay callback URL. For Local Connect, confirm that the local bridge is still running and that its allowed origins include the page you opened.

### `Hosted authorization is not configured`

The relay does not have `SFLENS_SALESFORCE_CLIENT_ID`. Set it as a Cloudflare Worker secret, verify the callback URL and PKCE settings, then redeploy the Worker. Local Connect does not need this setting.

### `OAUTH_NOT_CONFIGURED`

Use Local Connect with Salesforce CLI, or finish configuring the hosted Salesforce OAuth app and Cloudflare Worker secret described above.

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
