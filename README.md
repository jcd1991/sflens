# SF Lens

> Read-only Salesforce debug-log intelligence for developers.

SF Lens turns noisy Salesforce logs into a focused incident workspace. It highlights governor-limit pressure, Flow failures, database work, exceptions, and related transactions—with evidence lines you can inspect, copy, or share with an AI coding assistant.

**Try the hosted demo:** [jcd1991.github.io/sflens](https://jcd1991.github.io/sflens/)

The hosted site is safe for demos and uploads. Connected Salesforce access runs locally on your computer through the loopback bridge.

## What you can do

| Feature | What it provides |
| --- | --- |
| Log explorer | Searchable, line-numbered Apex logs with event badges and evidence navigation |
| Flow diagnosis | Flow interview paths, failed elements, loop/database pressure, recursion signals, and incomplete interviews |
| Governor limits | CPU, heap, SOQL, DML, callouts, query rows, and budget remaining |
| Related transactions | Evidence-backed links between synchronous and asynchronous logs, with Exact, Strong, or Possible confidence |
| Performance comparison | Compare two logs and see metric deltas plus remaining budgets |
| AI handoff | Copy a redacted diagnosis prompt for Cursor, Devin, ChatGPT, or another review tool |
| Incident bundles | Export redacted HTML, JSON, or SARIF with severity, remediation notes, and evidence lines |
| Debug capture | Temporarily enable or disable the connected user’s trace flag from the UI |
| MCP | Use the same bounded analysis tools from an MCP-compatible client |

## Quick start

SF Lens requires **Node 24 LTS**.

```bash
npm ci
npm run dev
```

Open the Vite URL printed in the terminal.

### Demo mode

Demo mode loads a small, synthetic log that demonstrates an N+1 query pattern and a governor-limit failure. It is useful for learning the interface and does not contact Salesforce.

### Upload mode

Choose **Upload log** and select a `.log` or `.txt` file up to 25 MB. The file is parsed in your browser and stays in browser memory for the current session; it is not uploaded to SF Lens servers.

## Connect a Salesforce org

Connected mode reads existing `ApexLog` records through Salesforce CLI and the Tooling API. SF Lens does not need a Connected App, client ID, password, or manually entered bridge token for the normal local flow.

### 1. Start the local bridge

From the project folder, open a second terminal and run:

```bash
npm run dev -w @sflens/bridge
```

Keep this terminal running while SF Lens is connected. The bridge binds to `127.0.0.1` and prints a short-lived startup token for local tooling use.

### 2. Authorize in the browser

1. Open SF Lens locally, or open the hosted site while the local bridge is running.
2. Click **Connected**.
3. Choose **Authorize Salesforce**.
4. Salesforce CLI opens Salesforce’s normal login and authorization page.
5. Sign in to the personal or Developer Edition org you want to test.
6. Return to SF Lens. The app discovers the newly authorized local org and loads recent logs.

Salesforce CLI retains the local authorization, so you generally do not need to re-enter Salesforce credentials every time. The browser’s bridge session is temporary; if it expires, authorize again while the bridge is running.

### 3. Generate a log

Salesforce only creates debug logs when a trace flag is active. In Connected mode, click **Enable debug logging** to create a temporary `USER_DEBUG` trace flag for the authenticated user. It lasts 15 minutes by default. Reproduce the issue in Salesforce, wait briefly for the log to appear, and let SF Lens auto-refresh the recent-log list.

Click **Disable debug logging** when finished. This is the only connected action that changes org configuration; it creates or removes only the temporary user trace flag. SF Lens does not create records, deploy metadata, run Apex, or modify other trace flags.

### Connected-mode controls

- **Org selector:** choose the authorized local org.
- **Refresh logs:** immediately retrieve the latest records.
- **Filters:** narrow by user, operation, status, or time window.
- **Search all logs:** search the contents of up to 100 recent logs. Bodies are fetched only for the search and remain local.
- **Auto-refresh:** connected log summaries refresh every five seconds.
- **More:** open Compare baseline and CI/CD tools without crowding the main toolbar.

## Reading a diagnosis

Select a log from the left panel. The center console shows the redacted source with stable line numbers. The right panel contains:

- **Findings** — deterministic findings with severity, remediation, and exact evidence lines.
- **Limits** — observed usage and governor budgets.
- **Compare** — CPU, heap, SOQL, DML, callout, and query-row differences between a baseline and the selected log.
- **Related** — transaction candidates and the evidence behind each relationship.

Click a finding, Flow path, or evidence reference to jump to its source line. Use **Copy** on one line, or Shift-click two lines to select a range and use **Copy N selected**. **Copy for AI** produces a redacted prompt containing the diagnosis, limits, remediation, and evidence.

Related transactions use identifiers already present in Salesforce logs and metadata—such as request IDs, async job IDs, Flow interview IDs, class/operation names, users, and timestamps. SF Lens never invents causality: Possible matches are labeled heuristic, and an absent native identifier is reported as unconfirmed.

## Exports and CI/CD

The Findings panel can export a redacted incident bundle as:

- **HTML** for a readable incident handoff;
- **JSON** for scripts and downstream analysis;
- **SARIF** for code-scanning workflows.

Exports include finding severity, remediation notes, and evidence lines. Review any export before sharing it outside your organization.

The repository CI workflow runs tests, type checks, builds, the optional committed-log gate, and Salesforce Code Analyzer. It uploads SARIF and HTML reports as artifacts. Code Analyzer scans authored TypeScript/TSX source only; compiled bundles, CSS, and engines requiring Apex/Flow or Java runtimes are excluded. Analyzer findings are currently reported but non-blocking while the TypeScript rule profile is tuned. See [`code-analyzer.yml`](code-analyzer.yml).

For pull-request use, upload logs as a separate CI artifact or run the parser against files in the workflow. Do not commit production logs unless they have been reviewed and redacted.

## MCP server

Build and run the local stdio MCP server:

```bash
npm run build -w @sflens/mcp
node apps/mcp/dist/index.js
```

With no bridge configuration, MCP uses the synthetic demo fixture. To use connected logs, start the bridge and provide its URL, token, and an authorized org alias:

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

Available tools include `list_debug_logs`, `get_log_summary`, `get_log_excerpt`, `search_debug_logs`, `analyze_debug_log`, `compare_debug_logs`, `create_reproduction_checklist`, and `export_incident_bundle`. All requests are bounded and read-only; redaction is enabled by default.

## Privacy and security

- Credentials and Salesforce access tokens stay in local bridge memory or Salesforce CLI’s local authentication store.
- OAuth uses a local HttpOnly session cookie and PKCE when an External Client App is configured.
- Tokens are never placed in URLs, `localStorage`, rendered errors, or build output.
- Raw logs stay in browser memory and are redacted before display, copy, or export.
- The bridge accepts localhost and the published GitHub Pages origin by default. Set `SFLENS_WEB_ORIGINS` to a comma-separated allowlist for a fork or custom domain.
- The public GitHub Pages deployment supports Demo and Upload modes only. Connected mode requires the local bridge.
- The ignored `.sflens-test-org.json` file is for local testing only and must never be committed.

## Troubleshooting

### “Failed to fetch”

Confirm that the local bridge terminal is still running. If you are using the hosted site, confirm that the bridge includes `https://jcd1991.github.io` in its allowed origins, then reload the page and reconnect.

### `OAUTH_NOT_CONFIGURED`

Use the normal **Authorize Salesforce** flow with the local bridge. A configured External Client App is only needed for the optional direct PKCE OAuth path; it is not required for Salesforce CLI authorization.

### `localhost:1717/OauthSuccess` or connection refused

That address is Salesforce CLI’s local authorization callback listener. Keep the bridge/CLI process running, finish the Salesforce authorization page, and retry. The callback is not a public SF Lens endpoint.

### No logs appear

Enable a trace flag, reproduce the action as the traced user, wait a few seconds, and click **Refresh logs**. Salesforce log availability and retention depend on org limits and trace settings.

## Project layout

```text
packages/core   Parser, contracts, deterministic findings, redaction, comparison, fixtures
apps/web        React/Vite explorer, Demo, Upload, Connected UI, exports
apps/bridge     Local Salesforce CLI and Tooling API reader
apps/mcp        Local stdio MCP server
```

## Local verification

```bash
npm test
npm run typecheck
npm run build
```

## License

[MIT](LICENSE)
