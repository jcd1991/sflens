# SF Lens

SF Lens is a local-first Salesforce debug log explorer with a deterministic MCP debugging interface. The public web demo parses synthetic or uploaded `.log`/`.txt` files entirely in the browser. Connected mode is deliberately local-only: a loopback bridge uses Salesforce CLI authentication and the Tooling API to read existing `ApexLog` records from a Developer Edition org.

## Quick start

Requires Node 24 LTS. Install dependencies, then run `npm run dev` from this folder. Open the printed Vite URL and use Demo or Upload. Uploads are capped at 25 MB and are never sent to a server.

Run the local bridge separately with `npm run dev -w @sflens/bridge`. Click `Connected` in SF Lens and choose `Authorize Salesforce`; the bridge asks Salesforce CLI to open the normal Salesforce web authorization screen in your browser. After you finish there, SF Lens discovers only the newly authorized local org session. No Connected App, client ID, bridge URL, startup token, or CLI login is entered in the browser. The bridge binds to `127.0.0.1` and allows localhost plus the published GitHub Pages origin by default; override the list with comma-separated `SFLENS_WEB_ORIGINS` if you use a fork or custom domain. Connected mode lists up to 100 recent ApexLogs, supports user, operation, status, and time-window filters, and silently refreshes the list every five seconds. Advanced deployments may provide `SFLENS_SALESFORCE_CLIENT_ID` to use a separately configured PKCE External Client App instead.

Run the MCP server with `npm run build -w @sflens/mcp && node apps/mcp/dist/index.js`. It exposes read-only, bounded tools over stdio and uses the fixture by default. For connected MCP, start the bridge, then launch the server with `SFLENS_BRIDGE_URL=http://127.0.0.1:8787 SFLENS_BRIDGE_TOKEN=<token-from-bridge> SFLENS_ORG_ALIAS=sflens-personal node apps/mcp/dist/index.js`. The convenience launcher `node scripts/sflens-mcp-local.mjs` starts both processes and passes the short-lived bridge token internally. Secret redaction is always enabled, with PII redaction on search excerpts.

## Packages

- `packages/core`: contracts, parser, deterministic rules, redaction, comparison, fixtures.
- `apps/web`: React/Vite public demo and upload explorer, suitable for GitHub Pages.
- `apps/bridge`: loopback Salesforce CLI/Tooling API reader; does not persist logs or records. The optional debug-logging control creates/removes only a temporary user trace flag.
- `apps/mcp`: local stdio MCP server with fixture or connected read-only log tools.

GitHub Pages is static, so Connected mode is not deployed. The Pages workflow derives the project base path from the repository name and publishes to `https://<user>.github.io/<repository>/` after Pages is enabled for the repository.

## Security and scope

No credentials, proprietary logs, employer code, cloud storage, hosted MCP endpoint, embedded LLM, deletion, deployment, or Execute Anonymous operations are included. Developer Edition is the canonical free test org; Salesforce requires an active trace flag for logs to exist.

Connected mode is read-only for Salesforce data. OAuth uses an HttpOnly local session cookie and PKCE; access tokens remain in the local bridge memory and are never put in a URL, browser storage, or logs. Raw log bodies remain in browser memory and are redacted before display. Disconnecting clears the loaded remote logs. GitHub Pages remains Demo/Upload only because a static site cannot safely reach the local bridge.

The personal test-org username/config is intentionally local-only and ignored by Git. It is not required by the runtime and should not be published with the project.

When Connected mode is active, `Enable debug logging` creates a temporary USER_DEBUG trace flag for the authenticated user for 15 minutes. `Disable debug logging` removes active flags for that user. This requires Salesforce Tooling API permission and is the only Connected-mode action that changes org configuration; no records or metadata are created. The status line shows the active window so it is easy to turn off after testing.

The Compare tab accepts a second log and reports CPU, heap, SOQL, DML, callout, and query-row deltas, including remaining governor budget when the log exposes a maximum. The Findings panel exports redacted HTML, JSON, or SARIF bundles with severity, evidence lines, and remediation notes. The CI workflow runs tests/builds and Salesforce Code Analyzer, uploads SARIF/HTML reports, and fails at the configured severity threshold.

The Findings panel also has `Copy for AI`, which copies a redacted diagnosis prompt containing findings, remediation, limits, and evidence lines. Each visible log line has a `Copy` action, and Shift-click selects a range for `Copy N selected`. These clipboard actions are local browser operations and are intended for pasting into Cursor, Devin, ChatGPT, or another review tool. Review copied content before sharing it externally.

Flow diagnosis is evidence-backed: it recognizes interview and element lifecycle markers, Flow limits, failed elements, loop/database pressure, subflow recursion signals, and incomplete interviews when the log is not truncated. Related transactions use observed request IDs, async job IDs, Flow interview IDs, and nearby execution context. “Possible” matches are explicitly heuristic; no helper metadata or org deployment is required.

If Connected mode cannot load logs, confirm the bridge is running and finish the Salesforce authorization window that SF Lens opened. A `localhost:1717/OauthSuccess` error is from the Salesforce CLI callback listener, not the GitHub Pages site; restart the bridge/CLI login and make sure the local CLI process remains running while the browser authorization completes. Salesforce CLI stores the local authorization; SF Lens does not ask the browser to handle credentials. A trace flag must be active for logs to exist; SF Lens can offer a temporary USER_DEBUG trace flag after connection, and does not create or remove any other org data.

MCP tools include `list_debug_logs`, `get_log_summary`, `get_log_excerpt`, `search_debug_logs`, `analyze_debug_log`, `compare_debug_logs`, `create_reproduction_checklist`, and `export_incident_bundle`. The connected adapter only reads logs through the loopback bridge; it never enables logging, changes records, deploys metadata, or executes Apex.

## Public release checklist

Before publishing, confirm that no real logs, screenshots, org usernames, OAuth URLs, `.env` files, or local test-org configuration are staged. The ignored `.sflens-test-org.json` file is for local testing only and is not required by the runtime. Never force-add it or any Salesforce session/token file.

For a hosted demo, use Demo or Upload mode only. Connected mode requires the local bridge and Salesforce CLI, so it is intentionally unavailable from GitHub Pages. The bridge is designed for one developer on one machine, not for deployment as a public service.

For local verification:

```bash
npm ci
npm test
npm run typecheck
npm run build
```

The included CI workflow also runs Salesforce Code Analyzer against authored TypeScript/TSX source and uploads SARIF/HTML reports. It intentionally excludes compiled bundles, CSS, and engines that require Apex/Flow or Java runtimes; see [`code-analyzer.yml`](code-analyzer.yml). Analyzer findings are currently non-blocking while the TypeScript rule profile is tuned, but tests, type checks, builds, and the runtime-log gate remain blocking. The runtime-log gate only analyzes `.log`/`.txt` files that a repository owner intentionally commits; debug logs should normally remain outside the repository because they can contain sensitive data.

## License

MIT.
