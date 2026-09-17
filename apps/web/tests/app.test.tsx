import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/main";
afterEach(() => { cleanup(); vi.restoreAllMocks(); if (typeof sessionStorage !== "undefined") sessionStorage.clear(); if (typeof localStorage !== "undefined") localStorage.clear(); });
const log = "EXECUTION_STARTED\nLIMIT_USAGE_FOR_NS|default|LIMIT_CPU_TIME|100|10000\nSOQL_EXECUTE_BEGIN|[1]|Aggregations\nSOQL_EXECUTE_END|[1]|Rows:1\nUSER_DEBUG|hello\nEXECUTION_FINISHED";
describe("SF Lens browser workflow", () => {
  it("prompts for local Salesforce authorization and offers Demo fallback", () => { render(<App />); expect(screen.getByText(/Authorize SF Lens to read existing ApexLogs/)).toBeInTheDocument(); expect(screen.getByRole("button", { name: "Authorize Salesforce" })).toBeInTheDocument(); expect(screen.getByRole("button", { name: "Continue in Demo" })).toBeInTheDocument(); expect(screen.queryByLabelText("Startup token")).not.toBeInTheDocument(); });
  it("loads a baseline, shows Compare, and exports a bundle", async () => { render(<App />); fireEvent.click(screen.getByRole("button", { name: /more/i })); const files = document.querySelectorAll('input[type="file"]'); const baseline = new File([log], "baseline.log", { type: "text/plain" }); fireEvent.change(files[1], { target: { files: [baseline] } }); fireEvent.click(screen.getByRole("button", { name: "Compare" })); await waitFor(() => expect(screen.getByText("Baseline → current")).toBeInTheDocument()); const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined); fireEvent.click(screen.getByRole("button", { name: "JSON" })); expect(click).toHaveBeenCalled(); });
  it("makes Demo a visible workspace reset", async () => { render(<App />); fireEvent.click(screen.getByRole("button", { name: "Continue in Demo" })); await waitFor(() => expect(screen.getByText("Demo log loaded")).toBeInTheDocument()); expect(screen.getByText("LOCAL-ONLY")).toBeInTheDocument(); });
  it("opens browser authorization and finishes the CLI login handoff", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/oauth/start")) return new Response(JSON.stringify({ mode: "cli", jobId: "job-test" }), { status: 200 });
      if (url.includes("/oauth/status/job-test")) return new Response(JSON.stringify({ status: "complete" }), { status: 200 });
      if (url.endsWith("/orgs")) return new Response(JSON.stringify({ orgs: [{ alias: "dev-org", username: "dev@example.test" }] }), { status: 200 });
      if (url.includes("/debug-logging")) return new Response(JSON.stringify({ enabled: true, flags: [] }), { status: 200 });
      if (url.includes("/logs")) return new Response(JSON.stringify({ records: [] }), { status: 200 });
      return new Response(JSON.stringify({}), { status: 200 });
    });
    render(<App />); fireEvent.click(screen.getByRole("button", { name: "Authorize Salesforce" }));
    await waitFor(() => expect(screen.getByText("CONNECTED")).toBeInTheDocument(), { timeout: 3000 });
  });
});
