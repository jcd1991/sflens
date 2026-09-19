# Security policy

## Scope

SF Lens is a read-only Salesforce log diagnosis tool. The hosted site uses a Cloudflare Worker relay for OAuth and bounded `ApexLog` reads; the local development path uses a loopback bridge and Salesforce CLI. The project does not intentionally provide a hosted log archive, arbitrary SOQL, Apex execution, metadata deployment, or automatic remediation.

The detailed threat model, deployment checklist, data-flow description, and incident response procedure are in [`docs/security-and-hosted-auth.md`](docs/security-and-hosted-auth.md).

## Reporting a vulnerability

Please do not open a public issue containing Salesforce log content, OAuth codes, access tokens, session identifiers, screenshots with org data, or other sensitive material.

For a suspected vulnerability, contact the repository owner privately through the security contact configured on the GitHub repository. Include:

- the affected route, component, or deployment;
- a minimal reproduction using synthetic values;
- the impact and any conditions required;
- whether a token, log body, org identifier, or other sensitive data may have been exposed.

Allow time for a private assessment before public disclosure. If an exposure is suspected, disconnect the SF Lens session, revoke the Salesforce app authorization, and notify the maintainer so the Worker client configuration can be rotated.

## Security boundaries to remember

- Salesforce handles sign-in, MFA, and consent. SF Lens never asks for a Salesforce password.
- Hosted sessions are opaque browser credentials kept in `sessionStorage`; Salesforce access tokens remain in volatile Worker memory and are not placed in URLs.
- Raw log bodies are sensitive. Redaction improves sharing safety but is not a guarantee that organization-specific secrets or business data are removed.
- Local bridge sessions and startup tokens are local-machine credentials. Do not paste them into issues, chat, CI logs, or public documentation.
- Review every HTML, JSON, SARIF, or AI-context export before sharing it.
