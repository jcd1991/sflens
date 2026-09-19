export type SourceKind = "fixture" | "upload" | "salesforce";
export type EventKind =
  | "APEX"
  | "FLOW"
  | "SOQL"
  | "DML"
  | "CALLOUT"
  | "LIMIT"
  | "EXCEPTION"
  | "DEBUG"
  | "OTHER";
export type Confidence = "Exact" | "Strong" | "Possible";
export interface Evidence {
  lineStart: number;
  lineEnd: number;
  excerpt: string;
}
export interface LogMetadata {
  id: string;
  name: string;
  source: SourceKind;
  generatedAt?: string;
  user?: string;
  operation?: string;
  status?: string;
  rawSize: number;
  truncated: boolean;
  orgAlias?: string;
  requestId?: string;
}
export interface FlowContext {
  interviewId?: string;
  flowName?: string;
  version?: string;
  elementName?: string;
  elementType?: string;
  path: string[];
  outcome?: string;
}
export interface LogEvent {
  id: string;
  line: number;
  offset: number;
  timestamp?: string;
  kind: EventKind;
  phase: string;
  message: string;
  depth: number;
  durationMs?: number;
  raw: string;
  flow?: FlowContext;
}
export interface ExecutionSpan {
  id: string;
  label: string;
  kind: EventKind;
  startLine: number;
  endLine?: number;
  durationMs?: number;
  children: string[];
  flow?: FlowContext;
}
export interface LimitSnapshot {
  name: string;
  used: number;
  max: number;
  percent: number;
  line: number;
}
export interface Finding {
  id: string;
  ruleId: string;
  severity: "info" | "warning" | "critical";
  title: string;
  summary: string;
  evidence: Evidence[];
  metadata?: Record<string, string>;
}
export interface ParsedLog {
  metadata: LogMetadata;
  lines: string[];
  events: LogEvent[];
  spans: ExecutionSpan[];
  limits: LimitSnapshot[];
  findings: Finding[];
  unknownLines: number[];
}
export interface CorrelationEvidence {
  requestIds: string[];
  asyncJobIds: string[];
  flowInterviewIds: string[];
  contexts: string[];
}
export interface TransactionCandidate {
  logId: string;
  name: string;
  startTime?: string;
  operation?: string;
  status?: string;
  user?: string;
  requestId?: string;
  evidence: Evidence[];
}
export interface TransactionGroup {
  id: string;
  confidence: Confidence;
  title: string;
  candidates: TransactionCandidate[];
  evidence: Evidence[];
}
export interface RemoteLogSummary {
  id: string;
  name: string;
  startTime?: string;
  user?: string;
  operation?: string;
  status?: string;
  size?: number;
  requestId?: string;
  orgAlias: string;
}
export interface OrgSummary {
  alias: string;
  username: string;
  instanceUrl?: string;
  orgId?: string;
}
export * from "./analysis.js";

const rules: [RegExp, EventKind, string][] = [
  [/SOQL_EXECUTE_BEGIN/i, "SOQL", "query started"],
  [/SOQL_EXECUTE_END/i, "SOQL", "query completed"],
  [/DML_BEGIN/i, "DML", "DML started"],
  [/DML_END/i, "DML", "DML completed"],
  [/CALLOUT_REQUEST/i, "CALLOUT", "callout started"],
  [/CALLOUT_RESPONSE/i, "CALLOUT", "callout completed"],
  [
    /FLOW_(START|ELEMENT|INTERVIEW|VALUE|ASSIGNMENT|BULK)/i,
    "FLOW",
    "flow event",
  ],
  [/CODE_UNIT|METHOD_(ENTRY|EXIT)|EXECUTION_/i, "APEX", "execution event"],
  [
    /LIMIT_USAGE|CUMULATIVE_LIMIT|FLOW_INTERVIEW_FINISHED_LIMIT_USAGE/i,
    "LIMIT",
    "limit snapshot",
  ],
  [/EXCEPTION_THROWN|FATAL_ERROR/i, "EXCEPTION", "exception"],
  [/USER_DEBUG/i, "DEBUG", "user debug"],
];
const time = (s: string) => s.match(/(\d{2}:\d{2}:\d{2}\.\d{3})/)?.[1];
const evidence = (lines: string[], line: number, end = line): Evidence => ({
  lineStart: line,
  lineEnd: end,
  excerpt: lines
    .slice(line - 1, end)
    .join("\n")
    .slice(0, 600),
});
const parseLimit = (line: string, n: number): LimitSnapshot | undefined => {
  const m = line.match(/([A-Za-z][\w ]+):\s*(\d+)\s+out of\s+(\d+)/i);
  return m
    ? {
        name: m[1].trim(),
        used: +m[2],
        max: +m[3],
        percent: (+m[2] / +m[3]) * 100,
        line: n,
      }
    : undefined;
};
const flowContext = (
  line: string,
  prior: FlowContext | undefined,
): FlowContext | undefined => {
  if (!/FLOW_/i.test(line)) return prior;
  const out: FlowContext = { path: prior?.path || [] };
  const id = line.match(
    /(?:INTERVIEW|INTERVIEW_ID)[^|:=]*[|:=]\s*([^|\s]+)/i,
  )?.[1];
  const name = line
    .match(/(?:FLOW_NAME|FLOW_NAME=|Flow)\s*[:=|]\s*([^|]+)/i)?.[1]
    ?.trim();
  const version = line
    .match(/(?:VERSION|FLOW_VERSION)\s*[:=|]\s*([^|]+)/i)?.[1]
    ?.trim();
  const element = line
    .match(/(?:ELEMENT|ELEMENT_NAME)\s*[:=|]\s*([^|]+)/i)?.[1]
    ?.trim();
  const type = line
    .match(/(?:ELEMENT_TYPE|TYPE)\s*[:=|]\s*([^|]+)/i)?.[1]
    ?.trim();
  const path = element && !out.path.includes(element) ? [...out.path, element] : out.path;
  return {
    ...out,
    path,
    interviewId: id || prior?.interviewId,
    flowName: name || prior?.flowName,
    version: version || prior?.version,
    elementName: element || prior?.elementName,
    elementType: type || prior?.elementType,
    outcome: /ERROR|FAILED|FAULT/i.test(line)
      ? "failed"
      : /FINISHED|END/i.test(line)
        ? "completed"
        : prior?.outcome,
  };
};
function buildFlowSpans(events: LogEvent[]): ExecutionSpan[] {
  const spans: ExecutionSpan[] = [];
  const stack: ExecutionSpan[] = [];
  for (const e of events.filter((x) => x.kind === "FLOW")) {
    const start =
      /START|BEGIN|ELEMENT/i.test(e.raw) && !/(END|FINISHED)/i.test(e.raw);
    const end = /(END|FINISHED|ERROR|FAULT)/i.test(e.raw);
    if (start) {
      const s: ExecutionSpan = {
        id: `flow-${e.id}`,
        label: e.flow?.elementName || e.flow?.flowName || e.message || "Flow",
        kind: "FLOW",
        startLine: e.line,
        children: [],
        flow: e.flow,
      };
      if (stack.length) stack[stack.length - 1].children.push(s.id);
      spans.push(s);
      stack.push(s);
    } else if (end && stack.length) {
      const s = stack.pop()!;
      s.endLine = e.line;
      s.flow = e.flow || s.flow;
    }
  }
  return spans;
}
export function parseLog(
  raw: string,
  metadata: Partial<LogMetadata> = {},
): ParsedLog {
  const lines = raw.split(/\r?\n/),
    events: LogEvent[] = [],
    limits: LimitSnapshot[] = [],
    unknownLines: number[] = [];
  let depth = 0,
    flow: FlowContext | undefined;
  lines.forEach((line, i) => {
    const n = i + 1,
      match = rules.find(([r]) => r.test(line)),
      limit = parseLimit(line, n);
    if (limit) limits.push(limit);
    if (!match) {
      if (line.trim()) unknownLines.push(n);
      return;
    }
    const [, kind, phase] = match;
    flow = flowContext(line, flow);
    const exit =
      /(END|FINISHED|METHOD_EXIT|EXECUTION_FINISHED|CALLOUT_RESPONSE|DML_END)/i.test(
        line,
      );
    if (exit) depth = Math.max(0, depth - 1);
    events.push({
      id: `e${n}`,
      line: n,
      offset: lines.slice(0, i).join("\n").length + (i ? 1 : 0),
      timestamp: time(line),
      kind,
      phase,
      message: line
        .replace(/^.*?\|(?:[A-Z_]+)\|?/, "")
        .trim()
        .slice(0, 240),
      depth,
      raw: line,
      flow: kind === "FLOW" || flow?.interviewId ? flow : undefined,
    });
    if (!exit) depth++;
  });
  const spans = [
    ...events
      .filter((e) => ["APEX", "SOQL", "DML", "CALLOUT"].includes(e.kind))
      .map(
        (e) =>
          ({
            id: e.id,
            label: e.message || e.phase,
            kind: e.kind,
            startLine: e.line,
            children: [],
          }) as ExecutionSpan,
      ),
    ...buildFlowSpans(events),
  ];
  const findings: Finding[] = [];
  const q = events.filter((e) => e.kind === "SOQL" && /BEGIN/i.test(e.raw)),
    d = events.filter((e) => e.kind === "DML" && /BEGIN/i.test(e.raw));
  if (q.length >= 3)
    findings.push({
      id: "n-plus-one",
      ruleId: "N_PLUS_ONE_SOQL",
      severity: "warning",
      title: "Repeated SOQL pattern",
      summary: `${q.length} query starts were observed; inspect for N+1 access.`,
      evidence: q.slice(0, 3).map((e) => evidence(lines, e.line)),
    });
  limits
    .filter((l) => l.percent >= 90)
    .forEach((l) =>
      findings.push({
        id: `limit-critical-${l.line}`,
        ruleId: "LIMIT_OVER_90",
        severity: "critical",
        title: `${l.name} is near its governor limit`,
        summary: `${l.used} of ${l.max} used (${l.percent.toFixed(0)}%).`,
        evidence: [evidence(lines, l.line)],
      }),
    );
  limits
    .filter((l) => l.percent >= 70 && l.percent < 90)
    .forEach((l) =>
      findings.push({
        id: `limit-warning-${l.line}`,
        ruleId: "LIMIT_OVER_70",
        severity: "warning",
        title: `${l.name} usage is elevated`,
        summary: `${l.used} of ${l.max} used (${l.percent.toFixed(0)}%).`,
        evidence: [evidence(lines, l.line)],
      }),
    );
  events
    .filter((e) => e.kind === "EXCEPTION")
    .forEach((e) =>
      findings.push({
        id: `exception-${e.line}`,
        ruleId: "UNHANDLED_EXCEPTION",
        severity: "critical",
        title: "Exception detected",
        summary: e.raw.slice(-240),
        evidence: [evidence(lines, e.line)],
      }),
    );
  if (d.length >= 3)
    findings.push({
      id: "repeated-dml",
      ruleId: "REPEATED_DML",
      severity: "warning",
      title: "Repeated DML operations",
      summary: `${d.length} DML starts detected; consider bulkification.`,
      evidence: d.slice(0, 3).map((e) => evidence(lines, e.line)),
    });
  const flowErrors = events.filter(
    (e) => e.kind === "FLOW" && /ERROR|FAILED|FAULT/i.test(e.raw),
  );
  if (flowErrors.length)
    findings.push({
      id: "flow-failure",
      ruleId: "FLOW_ELEMENT_FAILED",
      severity: "critical",
      title: "Flow element failure",
      summary: `${flowErrors[0].flow?.elementName || "A Flow element"} reported an error.`,
      evidence: flowErrors.slice(0, 2).map((e) => evidence(lines, e.line)),
      metadata: { flow: flowErrors[0].flow?.flowName || "unknown" },
    });
  const flowLoops = events.filter(
    (e) => e.kind === "FLOW" && /LOOP|ITERATION/i.test(e.raw),
  );
  if (flowLoops.length && d.length)
    findings.push({
      id: "flow-loop-dml",
      ruleId: "FLOW_DML_IN_LOOP",
      severity: "warning",
      title: "Database work observed near a Flow loop",
      summary:
        "The log shows Flow loop activity and repeated DML; review for bulkification.",
      evidence: [
        ...flowLoops.slice(0, 1).map((e) => evidence(lines, e.line)),
        ...d.slice(0, 2).map((e) => evidence(lines, e.line)),
      ],
    });
  if (events.some((e) => e.kind === "FLOW" && /SUBFLOW|RECURS/i.test(e.raw)))
    findings.push({
      id: "flow-cycle",
      ruleId: "FLOW_SUBFLOW_CYCLE",
      severity: "warning",
      title: "Possible recursive Flow or subflow",
      summary: "A recursive or subflow signal was observed in the runtime log.",
      evidence: events
        .filter((e) => e.kind === "FLOW" && /SUBFLOW|RECURS/i.test(e.raw))
        .slice(0, 2)
        .map((e) => evidence(lines, e.line)),
    });
  if (
    !metadata.truncated &&
    !/FLOW_INTERVIEW_FINISHED|FLOW_FINISHED|FLOW_INTERVIEW_END/i.test(raw) &&
    events.some((e) => e.kind === "FLOW" && /START|BEGIN/i.test(e.raw))
  )
    findings.push({
      id: "flow-unfinished",
      ruleId: "FLOW_UNFINISHED_INTERVIEW",
      severity: "info",
      title: "Flow interview did not finish in this log",
      summary:
        "A Flow started without a matching finish marker; verify whether the log is complete.",
      evidence: [
        evidence(
          lines,
          events.find((e) => e.kind === "FLOW" && /START|BEGIN/i.test(e.raw))!
            .line,
        ),
      ],
    });
  if (events.some((e) => e.kind === "APEX" && /recursive|trigger/i.test(e.raw)))
    findings.push({
      id: "recursive-execution",
      ruleId: "RECURSIVE_EXECUTION",
      severity: "warning",
      title: "Recursive execution signal",
      summary: "Nested trigger or recursive execution text was found.",
      evidence: events
        .filter((e) => /recursive|trigger/i.test(e.raw))
        .slice(0, 2)
        .map((e) => evidence(lines, e.line)),
    });
  return {
    metadata: {
      id: metadata.id || "local-log",
      name: metadata.name || "Untitled log",
      source: metadata.source || "upload",
      rawSize: raw.length,
      truncated: /truncated|maximum debug log size/i.test(raw),
      ...metadata,
    },
    lines,
    events,
    spans,
    limits,
    findings,
    unknownLines,
  };
}
export function extractCorrelation(parsed: ParsedLog): CorrelationEvidence {
  const ids = (r: RegExp) =>
    Array.from(
      new Set(
        parsed.lines.flatMap((l) => Array.from(l.matchAll(r)).map((m) => m[1])),
      ),
    );
  return {
    requestIds: ids(
      /(?:REQUEST_ID|requestId|Request ID|REQUEST)[=:|\s]+([a-zA-Z0-9-]{8,})/g,
    ),
    asyncJobIds: ids(
      /(?:AsyncApexJob|JOB_ID|JobId|jobId)[=:|\s]+([a-zA-Z0-9]{10,})/g,
    ),
    flowInterviewIds: Array.from(
      new Set(
        parsed.events
          .map((e) => e.flow?.interviewId)
          .filter(Boolean) as string[],
      ),
    ),
    contexts: Array.from(
      new Set(
        parsed.events.map((e) => e.flow?.flowName || e.message).filter(Boolean),
      ),
    ),
  };
}
export function correlateTransactions(
  selected: ParsedLog,
  candidates: { summary: RemoteLogSummary; parsed?: ParsedLog }[],
): TransactionGroup[] {
  const a = extractCorrelation(selected),
    groups: TransactionGroup[] = [];
  for (const c of candidates) {
    const b = c.parsed
      ? extractCorrelation(c.parsed)
      : {
          requestIds: [c.summary.requestId].filter(Boolean) as string[],
          asyncJobIds: [],
          flowInterviewIds: [],
          contexts: [],
        };
    const exact =
      a.requestIds.find((id) => b.requestIds.includes(id)) ||
      a.flowInterviewIds.find((id) => b.flowInterviewIds.includes(id));
    const strong = a.asyncJobIds.find((id) => b.asyncJobIds.includes(id));
    const context = a.contexts.find((x) =>
      b.contexts.some((y) => y && x === y),
    );
    if (exact || strong || context) {
      const confidence: Confidence = exact
        ? "Exact"
        : strong
          ? "Strong"
          : "Possible";
      groups.push({
        id: `tx-${c.summary.id}`,
        confidence,
        title:
          confidence === "Exact"
            ? "Shared native request identifier"
            : confidence === "Strong"
              ? "Async producer/consumer evidence"
              : "Nearby matching execution context",
        candidates: [
          {
            logId: selected.metadata.id,
            name: selected.metadata.name,
            startTime: selected.metadata.generatedAt,
            user: selected.metadata.user,
            operation: selected.metadata.operation,
            requestId: exact,
            evidence: [],
          },
          {
            logId: c.summary.id,
            name: c.summary.name,
            startTime: c.summary.startTime,
            user: c.summary.user,
            operation: c.summary.operation,
            requestId: c.summary.requestId,
            evidence: [],
          },
        ],
        evidence: [],
      });
    }
  }
  return groups;
}
export const demoLog = [
  "09:41:12.000 (100)|USER_INFO|[EXTERNAL]|demo.user@example.test",
  "09:41:12.010 (110)|EXECUTION_STARTED",
  "09:41:12.012 (112)|CODE_UNIT_STARTED|[EXTERNAL]|OpportunityTrigger on Opportunity trigger event BeforeUpdate",
  "09:41:12.020 (120)|FLOW_START|INTERVIEW_ID=flow-opp-001|FLOW_NAME=Opportunity Lifecycle|VERSION=3",
  "09:41:12.030 (130)|FLOW_ELEMENT_BEGIN|ELEMENT=Loop Contacts|TYPE=LOOP",
  "09:41:12.040 (140)|FLOW_ELEMENT_BEGIN|ELEMENT=Get Contact|TYPE=GET_RECORDS",
  "09:41:12.100 (200)|SOQL_EXECUTE_BEGIN|[1]|Aggregations:0|SELECT Id,Name FROM Account WHERE Id = :tmp",
  "09:41:12.130 (230)|SOQL_EXECUTE_END|[1]|Rows:1",
  "09:41:12.140 (240)|SOQL_EXECUTE_BEGIN|[2]|Aggregations:0|SELECT Id FROM Contact WHERE AccountId = :tmp",
  "09:41:12.170 (270)|SOQL_EXECUTE_END|[2]|Rows:1",
  "09:41:12.180 (280)|SOQL_EXECUTE_BEGIN|[3]|Aggregations:0|SELECT Id FROM Contact WHERE AccountId = :tmp",
  "09:41:12.210 (310)|SOQL_EXECUTE_END|[3]|Rows:1",
  "09:41:12.220 (320)|SOQL_EXECUTE_BEGIN|[4]|Aggregations:0|SELECT Id FROM Contact WHERE AccountId = :tmp",
  "09:41:12.250 (350)|SOQL_EXECUTE_END|[4]|Rows:1",
  "09:41:12.260 (360)|FLOW_ELEMENT_END|ELEMENT=Get Contact|TYPE=GET_RECORDS",
  "09:41:12.270 (370)|FLOW_ELEMENT_BEGIN|ELEMENT=Update Contact|TYPE=UPDATE",
  "09:41:12.280 (380)|DML_BEGIN|[45]|Update Contact",
  "09:41:12.290 (390)|DML_END|[45]|Update Contact|Rows:1",
  "09:41:12.300 (400)|DML_BEGIN|[45]|Update Contact",
  "09:41:12.310 (410)|DML_END|[45]|Update Contact|Rows:1",
  "09:41:12.320 (420)|DML_BEGIN|[45]|Update Contact",
  "09:41:12.330 (430)|DML_END|[45]|Update Contact|Rows:1",
  "09:41:12.340 (440)|FLOW_ELEMENT_ERROR|ELEMENT=Update Contact|TYPE=UPDATE|ERROR=FIELD_CUSTOM_VALIDATION_EXCEPTION",
  "09:41:12.350 (450)|FLOW_ELEMENT_BEGIN|ELEMENT=Notify Owner|TYPE=SUBFLOW",
  "09:41:12.360 (460)|CALLOUT_REQUEST|[52]|POST https://example.invalid/notify",
  "09:41:12.390 (490)|CALLOUT_RESPONSE|[52]|StatusCode:200",
  "09:41:12.400 (500)|FLOW_ELEMENT_END|ELEMENT=Notify Owner|TYPE=SUBFLOW",
  "09:41:12.410 (510)|FLOW_ELEMENT_END|ELEMENT=Loop Contacts|TYPE=LOOP",
  "09:41:12.420 (520)|FLOW_INTERVIEW_FINISHED_LIMIT_USAGE|Number of SOQL queries: 91 out of 100|Number of query rows: 4870 out of 50000",
  "09:41:12.430 (530)|LIMIT_USAGE_FOR_NS|(default)|Maximum CPU time: 7420 out of 10000",
  "09:41:12.440 (540)|LIMIT_USAGE_FOR_NS|(default)|Maximum heap size: 4800000 out of 6000000",
  "09:41:12.450 (550)|LIMIT_USAGE_FOR_NS|(default)|Number of DML statements: 42 out of 150",
  "09:41:12.460 (560)|LIMIT_USAGE_FOR_NS|(default)|Number of callouts: 2 out of 100",
  "09:41:12.470 (570)|USER_DEBUG|[42]|DEBUG|Contact merge candidate evaluated",
  "09:41:12.480 (580)|EXCEPTION_THROWN|[67]|System.DmlException: Update failed",
  "09:41:12.490 (590)|FATAL_ERROR|System.LimitException: Too many SOQL queries: 101",
  "09:41:12.500 (600)|FLOW_INTERVIEW_FINISHED|INTERVIEW_ID=flow-opp-001",
  "09:41:12.510 (610)|EXECUTION_FINISHED",
].join("\n");
export function redact(text: string, pii = false) {
  const out = text.replace(
    /(Authorization|session(Id)?|password|client_secret)\s*[:=]\s*[^\s,|]+/gi,
    "$1: [REDACTED]",
  );
  return pii
    ? out
        .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, "[EMAIL]")
        .replace(/\+?\d[\d ()-]{7,}\d/g, "[PHONE]")
    : out;
}
export function compareLogs(base: ParsedLog, candidate: ParsedLog) {
  return {
    addedFindings: candidate.findings.filter(
      (f) => !base.findings.some((b) => b.ruleId === f.ruleId),
    ),
    removedFindings: base.findings.filter(
      (f) => !candidate.findings.some((b) => b.ruleId === f.ruleId),
    ),
    limitDelta: candidate.limits.map((l) => ({
      name: l.name,
      delta:
        l.percent - (base.limits.find((b) => b.name === l.name)?.percent || 0),
    })),
  };
}
