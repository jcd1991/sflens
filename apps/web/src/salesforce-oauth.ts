export type SalesforceOAuthConfig = {
  clientId: string;
  loginUrl: string;
  redirectUri: string;
};

export type SalesforceOAuthStart = {
  state: string;
  verifier: string;
  authorizationUrl: string;
};

function base64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function randomUrlToken(byteLength: number) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

export async function createSalesforceOAuthStart(config: SalesforceOAuthConfig): Promise<SalesforceOAuthStart> {
  const verifier = randomUrlToken(32);
  const state = randomUrlToken(24);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const challenge = base64Url(new Uint8Array(digest));
  const url = new URL("/services/oauth2/authorize", config.loginUrl);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope: "api",
  }).toString();
  return { state, verifier, authorizationUrl: url.toString() };
}

export function salesforceRedirectUri() {
  return `${window.location.origin}${window.location.pathname}`;
}

export function salesforceOrgAlias(organizationId: string, instanceUrl: string) {
  const source = organizationId || instanceUrl;
  return `oauth-${source.replace(/[^a-zA-Z0-9]/g, "").slice(-12).toLowerCase()}`;
}

export function salesforceOAuthError(value: unknown, options: { hosted?: boolean } = {}) {
  const message = value instanceof Error ? value.message : String(value || "");
  if (/invalid_grant|invalid code|expired/i.test(message)) return "Salesforce authorization expired. Start authorization again.";
  if (/cors|failed to fetch|networkerror|load failed/i.test(message)) {
    if (options.hosted) {
      return "Salesforce authorization could not be reached in this browser. Retry from the same Salesforce sign-in session or a clean tab; SF Lens does not require a Chrome extension or per-org setup.";
    }
    return "Salesforce could not be reached from this page. Check the Salesforce app callback and CORS settings, then try again.";
  }
  return message || "Salesforce authorization could not be completed.";
}
