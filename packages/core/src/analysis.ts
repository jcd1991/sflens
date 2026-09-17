import type { Finding, LimitSnapshot, ParsedLog } from "./index";

export type PerformanceMetricName = "cpuMs" | "heapBytes" | "soql" | "dml" | "callouts" | "queryRows";
export interface PerformanceSnapshot { cpuMs?: number; heapBytes?: number; soql?: number; dml?: number; callouts?: number; queryRows?: number; }
export interface PerformanceDelta { name: PerformanceMetricName; label: string; base?: number; candidate?: number; delta?: number; remaining?: number; max?: number; explanation: string; }
export interface PerformanceComparison { base: PerformanceSnapshot; candidate: PerformanceSnapshot; deltas: PerformanceDelta[]; }
export interface IncidentBundle { format: "json" | "html" | "sarif"; filename: string; content: string; }

const metricRules: [PerformanceMetricName, RegExp, string][] = [
  ["cpuMs", /(?:Maximum CPU time|CPU time):\s*(\d+)\s+out of\s+(\d+)/i, "CPU time"],
  ["heapBytes", /(?:Maximum heap size|Heap size):\s*(\d+)\s+out of\s+(\d+)/i, "Heap size"],
  ["soql", /Number of SOQL queries:\s*(\d+)\s+out of\s+(\d+)/i, "SOQL queries"],
  ["dml", /Number of DML statements:\s*(\d+)\s+out of\s+(\d+)/i, "DML statements"],
  ["callouts", /Number of callouts:\s*(\d+)\s+out of\s+(\d+)/i, "Callouts"],
  ["queryRows", /Number of query rows:\s*(\d+)\s+out of\s+(\d+)/i, "Query rows"],
];
export function performanceSnapshot(parsed: ParsedLog): PerformanceSnapshot {
  const result: PerformanceSnapshot = {};
  for (const [name, rule] of metricRules) {
    const limit = parsed.limits.find((item) => rule.test(`${item.name}: ${item.used} out of ${item.max}`));
    if (limit) result[name] = limit.used;
    else {
      const line = parsed.lines.find((item) => rule.test(item));
      const match = line?.match(rule);
      if (match) result[name] = Number(match[1]);
    }
  }
  return result;
}
export function comparePerformance(base: ParsedLog, candidate: ParsedLog): PerformanceComparison {
  const baseSnapshot = performanceSnapshot(base), candidateSnapshot = performanceSnapshot(candidate);
  const deltas = metricRules.map(([name, rule, label]) => {
    const baseValue = baseSnapshot[name], candidateValue = candidateSnapshot[name];
    const max = candidate.limits.find((l) => rule.test(`${l.name}: ${l.used} out of ${l.max}`))?.max ?? base.limits.find((l) => rule.test(`${l.name}: ${l.used} out of ${l.max}`))?.max;
    const delta = baseValue !== undefined && candidateValue !== undefined ? candidateValue - baseValue : undefined;
    const remaining = candidateValue !== undefined && max !== undefined ? max - candidateValue : undefined;
    const explanation = candidateValue === undefined ? "Not observed in this log." : remaining !== undefined ? `${remaining.toLocaleString()} of ${max!.toLocaleString()} budget remaining.` : "Observed usage; this log did not include a limit budget.";
    return { name, label, base: baseValue, candidate: candidateValue, delta, remaining, max, explanation };
  });
  return { base: baseSnapshot, candidate: candidateSnapshot, deltas };
}
export function remediationForFinding(finding: Finding): string { const notes: Record<string,string> = { N_PLUS_ONE_SOQL: "Collect records before the loop and query once with a selective filter.", REPEATED_DML: "Accumulate changes and perform one bulk DML operation outside the loop.", LIMIT_OVER_90: "Reduce work per transaction or split the work into smaller async units.", FLOW_DML_IN_LOOP: "Move Update/Create Records outside the Flow loop and use a collection.", FLOW_ELEMENT_FAILED: "Inspect the element evidence and add a handled fault path or validation.", UNHANDLED_EXCEPTION: "Handle the exception at the transaction boundary and avoid exposing sensitive details." }; return notes[finding.ruleId] || "Review the evidence lines and reproduce with the smallest possible transaction."; }
const esc=(value:string)=>value.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
const redactExport=(value:string)=>value.replace(/(Authorization|session(?:Id)?|password|client_secret)\s*[:=]\s*[^\s,|]+/gi,"$1: [REDACTED]").replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g,"[EMAIL]").replace(/\+?\d[\d ()-]{7,}\d/g,"[PHONE]");
export function incidentBundle(parsed: ParsedLog, format: "json"|"html"|"sarif", comparison?: PerformanceComparison): IncidentBundle { const findings=parsed.findings.map(f=>({...f,title:redactExport(f.title),summary:redactExport(f.summary),remediation:remediationForFinding(f),evidence:f.evidence.map(e=>({lineStart:e.lineStart,lineEnd:e.lineEnd,excerpt:redactExport(e.excerpt)}))})); const metadata={...parsed.metadata,user:parsed.metadata.user?redactExport(parsed.metadata.user):undefined}; const data={product:"SF Lens",generatedAt:new Date().toISOString(),metadata,summary:{events:parsed.events.length,findings:findings.length,limits:parsed.limits.length},findings,performance:comparison}; if(format==="json")return{format,filename:"sflens-incident.json",content:JSON.stringify(data,null,2)}; if(format==="sarif"){const sarif={version:"2.1.0",$schema:"https://json.schemastore.org/sarif-2.1.0.json",runs:[{tool:{driver:{name:"SF Lens",version:"0.3.0"}},results:findings.map(f=>({ruleId:f.ruleId,level:f.severity==="critical"?"error":f.severity==="warning"?"warning":"note",message:{text:redactExport(`${f.title}: ${f.summary} Remediation: ${f.remediation}`)},locations:[{physicalLocation:{artifactLocation:{uri:parsed.metadata.name},region:{startLine:f.evidence[0]?.lineStart||1}}}]}))}]};return{format,filename:"sflens-incident.sarif",content:JSON.stringify(sarif,null,2)}}const rows=findings.map(f=>`<article class="${f.severity}"><h2>${esc(f.title)}</h2><p>${esc(f.summary)}</p><p><b>Remediation:</b> ${esc(f.remediation)}</p><pre>Lines ${f.evidence[0]?.lineStart||1}-${f.evidence[0]?.lineEnd||1}\n${esc(f.evidence[0]?.excerpt||"")}</pre></article>`).join("");return{format,filename:"sflens-incident.html",content:`<!doctype html><meta charset="utf-8"><title>SF Lens incident</title><style>body{font:16px system-ui;max-width:900px;margin:40px auto;background:#10151d;color:#e8eef5}article{padding:18px;margin:14px 0;border:1px solid #364457;border-left:5px solid #62e6a7}article.critical{border-left-color:#ff6b6b}article.warning{border-left-color:#ffc857}pre{white-space:pre-wrap;color:#b9c6d5;background:#0a0e14;padding:12px}</style><h1>SF Lens incident bundle</h1><p>Redacted evidence report · ${esc(parsed.metadata.name)}</p>${rows}`}; }
