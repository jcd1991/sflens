import { describe, it, expect } from "vitest";
import { comparePerformance, correlateTransactions, demoLog, incidentBundle, parseLog, redact } from "../src/index";
describe("SFLens parser", () => {
  it("parses events, limits and findings", () => {
    const p = parseLog(demoLog, { source: "fixture" });
    expect(p.events.length).toBeGreaterThan(8);
    expect(p.limits[0].percent).toBe(91);
    expect(p.findings.map((f) => f.ruleId)).toEqual(
      expect.arrayContaining([
        "N_PLUS_ONE_SOQL",
        "LIMIT_OVER_90",
        "UNHANDLED_EXCEPTION",
      ]),
    );
  });
  it("preserves unknown lines", () =>
    expect(parseLog("mystery line").unknownLines).toEqual([1]));
  it("redacts secrets", () =>
    expect(redact("Authorization: Bearer abc password=xyz", false)).toContain(
      "[REDACTED]",
    ));
  it("diagnoses Flow failures and preserves Flow context", () => {
    const p = parseLog([
      "10:00:00.000|FLOW_START|INTERVIEW_ID=flow-123|FLOW_NAME=Opportunity Flow",
      "10:00:00.010|FLOW_ELEMENT_BEGIN|ELEMENT=Loop Contacts|TYPE=LOOP",
      "10:00:00.020|FLOW_ELEMENT_ERROR|ELEMENT=Update Records|TYPE=UPDATE|ERROR=Too many DML",
    ].join("\n"), { source: "upload" });
    expect(p.events.some((e) => e.flow?.interviewId === "flow-123")).toBe(true);
    expect(p.findings.map((f) => f.ruleId)).toContain("FLOW_ELEMENT_FAILED");
    expect(p.spans.some((s) => s.kind === "FLOW")).toBe(true);
  });
  it("groups logs only when native evidence matches", () => {
    const selected = parseLog("10:00:00.000|USER_DEBUG|REQUEST_ID=req-12345678");
    const groups = correlateTransactions(selected, [{ summary: { id: "07L000000000001", name: "Queueable", orgAlias: "dev", requestId: "req-12345678" } }]);
    expect(groups[0].confidence).toBe("Exact");
  });
  it("compares budgets and redacts incident exports", () => {
    const base = parseLog("LIMIT_USAGE_FOR_NS|Number of SOQL queries: 2 out of 100\nUSER_DEBUG|email=person@example.test");
    const current = parseLog("LIMIT_USAGE_FOR_NS|Number of SOQL queries: 5 out of 100\nFATAL_ERROR|password=secret");
    const comparison = comparePerformance(base, current);
    expect(comparison.deltas.find((d) => d.name === "soql")?.delta).toBe(3);
    const bundle = incidentBundle(current, "json", comparison);
    expect(bundle.content).not.toContain("secret");
    expect(bundle.filename).toBe("sflens-incident.json");
  });
});
