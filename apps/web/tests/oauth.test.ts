import { describe, expect, it } from "vitest";
import { createSalesforceOAuthStart, salesforceOAuthError, salesforceOrgAlias } from "../src/salesforce-oauth";

describe("Salesforce OAuth helpers", () => {
  it("creates a PKCE challenge without putting the verifier in the URL", async () => {
    const start = await createSalesforceOAuthStart({ clientId: "public-client", loginUrl: "https://login.salesforce.com", redirectUri: "https://example.test/" });
    const url = new URL(start.authorizationUrl);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBeTruthy();
    expect(start.authorizationUrl).not.toContain(start.verifier);
  });

  it("normalizes org aliases and hides raw network errors", () => {
    expect(salesforceOrgAlias("00D-123", "https://example.my.salesforce.com")).toBe("oauth-00d123");
    expect(salesforceOAuthError(new TypeError("Failed to fetch"))).toMatch(/could not be reached/i);
    expect(salesforceOAuthError(new TypeError("Failed to fetch"), { hosted: true })).toMatch(/does not require a Chrome extension/i);
    expect(salesforceOAuthError(new TypeError("Failed to fetch"), { hosted: true })).toMatch(/per-org setup/i);
  });
});
