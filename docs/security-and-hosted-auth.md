# SF Lens security and hosted authorization

This document is the security boundary for the public GitHub Pages deployment and its optional Cloudflare Worker relay. It is intentionally specific about what SF Lens can and cannot protect.

## Security goals

SF Lens is a read-only diagnosis tool. The hosted path is designed to:

- let a user authorize a Salesforce org through Salesforce’s own sign-in and consent screens;
- keep Salesforce access tokens out of the browser URL, Git history, GitHub Pages artifacts, and application logs;
- avoid storing Salesforce logs or org data in a hosted database;
- expose only bounded reads of the authenticated user’s `ApexLog` summaries and bodies;
- redact sensitive values before display, copy, export, or MCP handoff;
- fail closed when the OAuth state, session, origin, or requested resource is invalid.

This does not make raw Salesforce debug logs safe by default. A log can contain business data, identifiers, query values, exception text, and user-entered debug output. Users must review redacted exports before sharing them.

## Deployment model

```text
Salesforce sign-in and consent
              │ authorization code + PKCE
              ▼
GitHub Pages React app ── opaque session in sessionStorage ──► Cloudflare Worker relay
       │                                                        │ short-lived DO session
       │                                                        │ bounded Tooling API reads
       ▼                                                        ▼
browser parser, redaction, exports                         Salesforce org

Local-only alternative:
React app ── loopback session/startup token ──► local bridge ──► Salesforce CLI / Tooling API
```

The hosted Worker is a relay, not a log archive. It keeps only the Salesforce access token and safe org/session metadata in one Durable Object-backed record for at most one hour or the shorter Salesforce expiry. OAuth state expires after ten minutes and is consumed once. It never writes logs or org records to the store. Cloudflare can still have platform-level operational telemetry outside this repository; configure account-level retention and access controls separately.

## Hosted OAuth flow

1. The user chooses Production / Developer Org or Sandbox. The browser navigates to `/oauth/start?environment=production` or `/oauth/start?environment=sandbox` on the Worker.
2. The Worker creates a high-entropy `state` and PKCE verifier, stores them in the session Durable Object for ten minutes, and redirects to Salesforce.
3. Salesforce performs sign-in, MFA, and consent. SF Lens never sees the Salesforce password or MFA code.
4. Salesforce redirects to the fixed Worker callback URL.
5. The Worker validates and consumes `state`, exchanges the code with the PKCE verifier, and calls the Salesforce identity URL returned by Salesforce.
6. The Worker creates a high-entropy opaque session identifier and redirects to the GitHub Pages URL using a URL fragment. The Salesforce access token is never placed in that URL.
7. The browser sends the opaque identifier in `X-SFLens-Session` for subsequent read-only requests, then immediately removes the fragment from the address bar.
8. The browser keeps that opaque identifier only in `sessionStorage`. Disconnect removes it. The Durable Object expires it after one hour or the shorter Salesforce expiry; it contains no log body.

The hosted External Client App is a public OAuth client. It uses authorization code + PKCE and the `api` scope. No Salesforce client secret is required or shipped to the browser. The client ID is a public identifier; the Worker’s secret is the only deployment credential and is configured with `wrangler secret`, never in GitHub Pages build output.

## Hosted relay boundary

The Worker exposes only these routes:

| Route | Access | Behavior |
| --- | --- | --- |
| `GET /health` | public | returns a minimal readiness response |
| `GET /oauth/start` | public | starts PKCE authorization |
| `GET /oauth/callback` | Salesforce redirect | consumes OAuth state and creates a session |
| `GET /orgs` | opaque session | returns one safe org summary |
| `GET /orgs/:alias/logs` | opaque session | returns at most 100 bounded `ApexLog` summaries |
| `GET /orgs/:alias/logs/:id/body` | opaque session | returns one validated `ApexLog` body, capped at 25 MB |

There is no hosted route for DML, Apex execution, metadata deployment, trace flags, arbitrary SOQL, `AsyncApexJob` monitoring, or log upload. Debug logging controls intentionally remain local-only. The Worker validates Salesforce log IDs, caps filter length, validates date filters, normalizes the result shape, and returns generic errors without echoing Salesforce response bodies.

The OAuth environment is an explicit allowlist: `production` uses `login.salesforce.com` (or the reviewed production login override), and `sandbox` uses `test.salesforce.com`. No user-supplied Salesforce host is accepted. This keeps the Workbench-style environment choice simple without turning the relay into an open redirect or arbitrary-host token exchange.

The Worker sends `Cache-Control: no-store`, `Pragma: no-cache`, `X-Content-Type-Options: nosniff`, and `Referrer-Policy: no-referrer`. CORS permits only the exact configured GitHub Pages origin and the two allowed methods needed by the relay. It does not use `*` with authenticated requests.

## Browser handling

- Hosted mode stores only the opaque relay session in `sessionStorage`; it does not use `localStorage` for credentials.
- The direct browser PKCE fallback is available only when a deployment explicitly supplies a public client ID and does not configure the relay. The public GitHub Pages build intentionally uses the relay and does not receive a client ID secret.
- Local mode uses the loopback bridge’s short-lived session cookie/startup token. The bridge binds to `127.0.0.1`, checks the configured origin allowlist, binds cookie sessions to one authorized org, and keeps its Salesforce connection in process memory or Salesforce CLI’s local authorization store. Its default CORS origins are local Vite origins; a public origin must be explicitly added with `SFLENS_WEB_ORIGINS` for a deliberate local-development scenario.
- Raw log text is bounded by the relay and kept in browser memory for the active page. Copy and export paths call the shared redaction utility first. The browser does not persist raw logs.
- The UI must not print access tokens, authorization codes, PKCE verifiers, session identifiers, or raw Salesforce error bodies. Errors shown to users are intentionally generic.
- The web shell includes a restrictive Content Security Policy. If you deploy a different relay hostname, update the policy’s `connect-src` allowlist with that exact hostname as part of the deployment review.

## Threat model and response

### Token theft

An opaque relay session is a bearer credential for the lifetime of that session. It is not a Salesforce access token, but it can read the authorized user’s bounded logs until it expires or is disconnected. The practical defenses are PKCE, no token in URLs, `sessionStorage` instead of `localStorage`, `no-store` responses, a strict origin allowlist, short TTLs, and no persistence. Avoid browser extensions or injected scripts that can read the page or session storage.

If a session may have been exposed, click **Disconnect**, close the tab, and revoke the connected app authorization in Salesforce. The maintainer can also rotate the Worker secret, change the Salesforce client app, or redeploy the Worker. Rotating the client ID secret does not revoke already-issued Salesforce tokens; revocation must be performed in Salesforce.

### OAuth substitution and callback attacks

The Worker creates and consumes state server-side, requires PKCE, binds the token exchange to the stored verifier and exact callback URI, and redirects only to the configured GitHub Pages URL. A callback with missing, reused, expired, or denied state fails closed.

### Origin and request abuse

The Worker permits only the exact published origin. It does not trust a user-provided Salesforce instance URL, org alias, SOQL fragment, or record ID. Query limits are capped at 100, filters are length-bounded, dates are syntax-validated, and log bodies are capped at 25 MB. The relay fetches at most one requested body per request. The UI’s related-transaction search caps candidate logs at 20 and uses concurrency three.

### Sensitive debug content

Redaction is a presentation and export safeguard, not a guarantee that the source log is harmless. Do not paste raw logs into issues, chat, public pull requests, browser screenshots, or support tickets. Review generated HTML/JSON/SARIF and AI context before sharing. The app does not send the log to an LLM automatically.

### Worker availability and session lifecycle

The relay uses a single Durable Object-backed session store because Worker isolates are not a shared process. The store contains only short-lived OAuth state and access-token/session metadata, never ApexLog bodies. Strict TTLs, one-time state consumption, exact origin checks, and disconnect/expiry behavior remain in force. If the hosted relay later becomes a larger multi-tenant service, add an explicit review for tenant isolation, audit controls, rate limiting, and revocation operations.

## Operational checklist

### Initial deployment

1. Create a Salesforce External Client App in a stable maintainer org.
2. Enable OAuth authorization code + PKCE and request only `api`.
3. Set the exact Worker callback URL and the exact GitHub Pages origin/redirect variables in `wrangler.toml`.
4. Configure the consumer key only with:

   ```bash
   npx wrangler secret put SFLENS_SALESFORCE_CLIENT_ID \
     --config workers/sflens-relay/wrangler.toml
   ```

5. Deploy the Worker, check `/health`, and run the relay tests.
6. Build the GitHub Pages site with `VITE_SFLENS_RELAY_URL` pointing at the custom Worker hostname. Do not add the consumer key as a Vite secret or GitHub Pages secret.
7. Test with a personal Developer Edition org before any public announcement.

### Routine review

- Confirm the Worker has only the expected secret and non-sensitive variables.
- Confirm the Salesforce app has only the `api` scope and the exact callback.
- Check that `git diff --check`, secret scanning, tests, type checks, and production build pass.
- Search staged files for `access_token`, `refresh_token`, `client_secret`, Salesforce session URLs, `.env`, and real debug-log content.
- Verify hosted requests cannot reach local-only debug-logging routes.
- Verify the local bridge default CORS policy does not include the public Pages origin; add an explicit origin only for a deliberate local-development scenario.
- Revoke and re-authorize during release testing so a stale session is not mistaken for a current deployment.

### Incident response

1. Disable or delete the Salesforce External Client App, or revoke its user authorizations.
2. Rotate `SFLENS_SALESFORCE_CLIENT_ID` in Cloudflare and redeploy.
3. Remove any exposed log/export artifacts from the affected distribution point.
4. Preserve only the minimum metadata needed to investigate; do not copy tokens or raw logs into tickets.
5. Record the affected deployment revision, callback URL, scope, and revocation time in the private incident record.

## Known limitations

- Salesforce org administrators can change OAuth policies, session lifetimes, trace-log retention, and API availability.
- The relay does not provide centralized logout, per-user rate quotas, or an audit dashboard in this release.
- A Durable Object or Salesforce session expiry can log a user out. This is expected.
- GitHub Pages is static and cannot run the local bridge or enable trace flags. Hosted mode is read-only.
- The shared redactor is deterministic but cannot know every organization-specific secret format. Treat exported material as sensitive until reviewed.
- EventLogFile, broad observability, long-term archives, and automatic remediation are deliberately out of scope.
