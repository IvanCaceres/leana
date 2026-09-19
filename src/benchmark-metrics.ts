export interface Event { at: string; type: string; data: any }
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
function distribution(values: number[]) {
  const xs = [...values].sort((a, b) => a - b);
  return { count: xs.length, totalMs: sum(xs), medianMs: xs.length ? (xs[Math.floor((xs.length - 1) / 2)]! + xs[Math.floor(xs.length / 2)]!) / 2 : null,
    p95Ms: xs.length ? xs[Math.ceil(xs.length * .95) - 1]! : null };
}
function canonical(value: any): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
export function summarizeEvents(events: Event[]) {
  const data = (type: string) => events.filter(e => e.type === type).map(e => e.data);
  const jev = data('jev'); const bonsai = data('bonsai'); const actions = data('action');
  const compactions = data('compact');
  const providerTime = (success: any[], failures: any[]) => {
    const values = new Map<string, number>();
    for (const [i, d] of [...success, ...failures].entries()) if (Number.isFinite(d.ms)) values.set(d.requestId ?? `legacy-${i}`, d.ms);
    return distribution([...values.values()]);
  };
  const repeated = (route: string) => {
    const seen = new Set<string>(); let repeats = 0;
    for (const a of actions.filter(a => a.route === route)) {
      const key = canonical(a.args); if (seen.has(key)) repeats++; seen.add(key);
    }
    return repeats;
  };
  const tokens = (records: any[], key: string) => sum(records.map(d => typeof d.usage?.[key] === 'number' ? d.usage[key] : 0));
  return {
    jevRequests: data('jev-request').length, jevResponses: jev.length, jevErrors: data('jev-error').length,
    jevQuestionCount: sum(data('jev-request').map(d => Object.keys(d.questions).length)),
    jevLatency: providerTime(jev, data('jev-error')),
    jevInputTokens: tokens(jev, 'input_tokens'), jevOutputTokens: tokens(jev, 'output_tokens'),
    bonsaiRequests: data('bonsai-request').length, bonsaiResponses: bonsai.length, bonsaiErrors: data('bonsai-error').length,
    bonsaiLatency: providerTime(bonsai, data('bonsai-error')),
    bonsaiPromptTokens: tokens(bonsai, 'prompt_tokens'), bonsaiCompletionTokens: tokens(bonsai, 'completion_tokens'),
    bonsaiCachedPromptTokens: sum(bonsai.map(d => d.usage?.prompt_tokens_details?.cached_tokens ?? 0)),
    peakPromptTokens: Math.max(0, ...bonsai.map(d => d.usage?.prompt_tokens ?? d.prompt?.tokens ?? 0)),
    missingUsageResponses: [...jev, ...bonsai].filter(d => !d.usage).length,
    toolMs: sum(data('result').map(d => d.ms ?? 0)), toolErrors: data('result').filter(d => !d.ok).length,
    actions: actions.length, actionsByRoute: Object.fromEntries([...new Set(actions.map(a => a.route))].map(route => [route, actions.filter(a => a.route === route).length])),
    repeatedReadRequests: repeated('read_files'), repeatedSearchRequests: repeated('search_codebase'),
    compactions: compactions.length, evictedEntries: sum(compactions.map(d => d.removed ?? 0)),
    compactionsByReason: Object.fromEntries([...new Set(compactions.map(a => a.reason))].map(reason => [reason, compactions.filter(a => a.reason === reason).length])),
    pauses: data('stop').length ? data('stop').filter(d => d.status === 'paused').length : data('paused').length,
  };
}
export function comparisonMarkdown(reports: any[]): string {
  if (reports.length < 2) throw new Error('Compare at least two benchmark results');
  if (reports.some(r => r.fixtureHash !== reports[0].fixtureHash || r.promptHash !== reports[0].promptHash || r.version !== reports[0].version))
    throw new Error('Cannot compare different fixtures, prompts, or verifier versions');
  const cell = (v: any) => v === null || v === undefined ? 'unknown' : String(v).replace(/[|\r\n]/g, ' ');
  const lines = ['# Refactor benchmark comparison', '', '| Run | Verified refactor | Agent completed | Wall seconds | Prompt tokens | Peak prompt | Compactions |', '| --- | --- | --- | ---: | ---: | ---: | ---: |'];
  for (const r of reports) lines.push(`| ${cell(r.label)} | ${r.verification.passed ? 'PASS' : 'FAIL'} | ${cell(r.agentCompleted)} | ${cell(r.wallSeconds)} | ${cell(r.metrics?.bonsaiPromptTokens)} | ${cell(r.metrics?.peakPromptTokens)} | ${cell(r.metrics?.compactions)} |`);
  lines.push('', 'The same fixture and task hashes are required. Unknown external-agent telemetry stays unknown; it is not zero. Compare model/server settings and concurrency before interpreting speed or token differences. Repeated read counts include legitimate re-reads after changes. This is a synthetic multi-file refactor, not a real-repository leaderboard.', '');
  return lines.join('\n');
}
