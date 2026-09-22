import { referenceContext } from './references.js';
import { ledgerFile, describe, type StructuralDiff } from './ledger.js';
import { boundedRead, safePath, topLevelDeclarations } from './tools.js';
import type { Answers, Config, Deliverable, Questions, Session } from './types.js';

// Jev decides; code owns the loop. Each step, code builds a small task record
// (facts only, a few kilobytes), enumerates the concrete actions that make
// sense from it, and asks Jev one fan-out request: which action, plus a few
// speculative yes/no judgments code consumes when relevant. Bonsai generates
// only what a decision needs generated: an edit's content. Completion is a set
// of citation checks: one bounded piece of evidence per deliverable, judged as
// supports, contradicts or says nothing.

const clip = (text: string, max: number) => text.length <= max ? text : `${text.slice(0, max)}…`;
const same = (a: string, b: string) => a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);

export interface TaskRecord {
  objective: string;
  requirements?: string[];
  design?: { summary: string; conventions: string };
  deliverables: { id: string; kind: string; name: string; where: string; status: string; optional?: boolean; note?: string }[];
  verification: { command: string | null; lastResult: 'passed' | 'failed' | 'none'; current: boolean; errors: number; firstError?: string; step: number | null };
  changes: { files: string[]; count: number; lastEditStep: number };
  lastAction: { step: number; action: string; ok: boolean; summary: string } | null;
  progress: { step: number; inspectionsSinceAction: number; repeatedResults: number; editsSinceCheck: number };
  blocker?: string;
}
export function taskRecord(s: Session): TaskRecord {
  const last = s.entries.at(-1);
  const refs = referenceContext(s, 2400).map(e => clip(e.text.replace(/^\d+:\s?/gm, '').replace(/\s+/g, ' ').trim(), 600));
  return {
    objective: clip(s.objective, 800),
    ...(refs.length ? { requirements: refs } : {}),
    ...(s.design ? { design: { summary: clip(s.design.summary, 400), conventions: clip(s.design.conventions, 300) } } : {}),
    deliverables: s.ledger.slice(0, 16).map(d => ({ id: d.id, kind: d.kind, name: d.name ?? '', where: d.kind === 'move' ? `${d.from ?? '?'} -> ${d.to ?? '?'}` : (d.to ?? d.from ?? ''), status: d.unresolvable ? 'unresolvable' : d.status, ...(d.optional ? { optional: true } : {}), ...(d.note ? { note: clip(d.note, 90) } : {}) })),
    verification: { command: s.lastCheckCommand, lastResult: s.lastCheck ? (s.lastCheck.ok ? 'passed' : 'failed') : 'none', current: Boolean(s.lastCheck && s.lastCheck.step > s.lastWriteStep && !s.pendingCheck), errors: s.lastCheck?.summary.errors ?? 0,
      ...(s.lastCheck && !s.lastCheck.ok ? { firstError: clip(Object.values(s.lastCheck.summary.byFile)[0]?.samples[0] ?? '', 160) } : {}), step: s.lastCheck?.step ?? null },
    changes: { files: s.writes.slice(-12), count: s.writes.length, lastEditStep: s.lastWriteStep },
    lastAction: last ? { step: last.step, action: last.kind, ok: !last.text.startsWith('Tool error') && last.kind !== 'generation_error' && last.kind !== 'finish_rejected', summary: clip(last.text.replace(/\s+/g, ' '), 240) } : null,
    progress: { step: s.step, inspectionsSinceAction: s.inspectionsSinceAction, repeatedResults: Math.max(0, ...Object.values(s.repetitions ?? {}).map(n => Number(n) || 0)), editsSinceCheck: s.editsSinceCheck },
    ...(s.completionFeedback && !s.completionFeedback.addressed ? { blocker: clip(s.completionFeedback.text, 300) } : s.lastError ? { blocker: clip(s.lastError.replace(/\s+/g, ' '), 200) } : {}),
  };
}
export interface Candidate { id: string; kind: 'implement' | 'fix' | 'inspect' | 'search' | 'finish' | 'ask' | 'free'; description: string; target?: { deliverable?: Deliverable; path?: string; start?: number; end?: number; name?: string } }
// Concrete actions the record supports. Verification, rollback, resolved fixes
// and ledger moves are code's own and never appear here.
export function candidates(s: Session, c: Config, ready: boolean): Candidate[] {
  const out: Candidate[] = [];
  const failed = s.lastCheck && !s.lastCheck.ok;
  // An edit route the worker just failed on twice is not re-decided into.
  const blockedEdit = s.blockedRoute === 'replace_lines' || s.blockedRoute === 'write' || s.blockedRoute === 'move_lines' ? s.blockedRoute : null;
  if (ready) out.push({ id: 'finish', kind: 'finish', description: 'Every deliverable is done by source facts and the verification passed after the last edit: propose completion for the audit.' });
  if (c.allowWrite) {
    const requiredOpen = s.ledger.some(d => !d.optional && !d.unresolvable && d.status !== 'done' && d.kind !== 'verify');
    for (const d of s.ledger) {
      if (d.status === 'done' || d.unresolvable) continue;
      if (d.kind === 'move' && s.pendingMoves.some(m => m.name === d.name)) continue; // the harness performs it
      if (d.kind === 'verify') continue;
      if (d.optional && requiredOpen) continue; // required work first
      if (blockedEdit === (d.kind === 'move' ? 'move_lines' : d.kind === 'create' ? 'write' : 'replace_lines')) continue;
      out.push({ id: `implement:${d.id}`, kind: 'implement', target: { deliverable: d }, description: `Implement ${d.optional ? 'optional ' : ''}deliverable ${d.id} (${describe(d)}); status ${d.status}${d.note ? `: ${clip(d.note, 80)}` : ''}${d.optional ? '. Optional: a reasonable addition, not required for completion' : ''}.` });
      if (out.filter(x => x.kind === 'implement').length >= 6) break; // interchangeable choices spread probability for nothing
    }
    if (failed && blockedEdit !== 'replace_lines') for (const [file, v] of Object.entries(s.lastCheck!.summary.byFile).slice(0, 4)) {
      if (file === '(other)') continue;
      const path = [...s.writes, ...s.knownFiles].find(f => same(f, file)) ?? file;
      out.push({ id: `fix:${path}`, kind: 'fix', target: { path, start: v.lines[0], end: v.lines[0] }, description: `Fix the ${v.count} error(s) the verification reports in ${path} (first: ${clip(v.samples[0] ?? '', 120)}).` });
    }
  }
  // Inspections: files the deliverables or errors name that are not readable at their current version.
  const unread = (p: string) => s.readHashes[p] === undefined || s.readHashes[p] !== s.hashes[p];
  const named = new Set<string>();
  for (const d of s.ledger) for (const p of [d.from, d.to]) { const f = p ? ledgerFile(s, p) : null; if (f && s.knownFiles.includes(f)) named.add(f); }
  if (failed) for (const file of Object.keys(s.lastCheck!.summary.byFile)) { const f = [...s.writes, ...s.knownFiles].find(x => same(x, file)); if (f) named.add(f); }
  for (const p of [...named].slice(0, 4)) if (unread(p)) out.push({ id: `inspect:${p}`, kind: 'inspect', target: { path: p }, description: `Read ${p}${s.hashes[p] ? ' again: it changed since it was last read' : ''} before editing it.` });
  for (const d of s.ledger) if ((d.status === 'unknown' || d.unresolvable) && d.name && d.kind !== 'verify' && d.kind !== 'create' && d.kind !== 'other' && /^[A-Za-z_$][\w$]*$/.test(d.name)) out.push({ id: `search:${d.name}`, kind: 'search', target: { name: d.name }, description: `Locate where ${d.name} is declared: the deliverable's location is unknown.` });
  out.push({ id: 'ask', kind: 'ask', description: 'Pause and ask the user: the objective cannot be carried out without a decision or information only they have.' });
  out.push({ id: 'free', kind: 'free', description: 'None of the listed actions is the right next step; let the worker propose its own action (slower, less precise).' });
  return out.slice(0, 24);
}
export function stepQuestions(cands: Candidate[]): Questions {
  return {
    next: { type: 'choice', instructions: 'Given the task record (deliverables with their source-fact status, verification state, recent action and its outcome), which listed action is the best next step toward completing the objective? Prefer implementing a pending deliverable over inspecting, and inspecting over asking; choose finish only when it is offered.', criteria: Object.fromEntries(cands.map(c => [c.id, c.description])) },
    stuck: { type: 'noul', instructions: 'Is the work stuck: the last action failed or repeated a result without progress, so that repeating the same kind of action would not help?' },
    scope_drift: { type: 'noul', instructions: 'Do the changed files suggest work beyond the deliverables the objective asks for?' },
    needs_user: { type: 'noul', instructions: 'Does completing the objective require a decision or information only the user can give (an ambiguous requirement, a missing credential, a choice between designs the objective does not settle)?' },
  };
}
export interface Decision { candidate: Candidate; confidence: number; probability: number; tier: 'act' | 'cautious' | 'escalate'; stuck: number; scopeDrift: number; needsUser: number }
// Confidence tiers by consequence: an inspection is cheap and may proceed on a
// middling read; an edit needs a clearer one; below that the worker proposes.
export function decideStep(answers: Answers, cands: Candidate[], c: Config): Decision {
  const a = answers.next; const free = cands.find(x => x.kind === 'free')!;
  const noul = (k: string) => { const v = answers[k]; return v?.type === 'noul' ? v.noul : 0; };
  if (a?.type !== 'choice') return { candidate: free, confidence: 0, probability: 0, tier: 'escalate', stuck: noul('stuck'), scopeDrift: noul('scope_drift'), needsUser: noul('needs_user') };
  const ranked = Object.entries(a.probabilities).filter(([k]) => cands.some(x => x.id === k)).sort((x, y) => y[1] - x[1]);
  const [id, p] = ranked[0] ?? ['free', 0];
  const candidate = cands.find(x => x.id === id) ?? free;
  const cheap = candidate.kind === 'inspect' || candidate.kind === 'search';
  // Several pending deliverables are acceptable alternatives: probability spread
  // among them is a preference, not doubt. Judge by the mass of the chosen kind.
  const kindMass = ranked.filter(([k]) => cands.find(x => x.id === k)?.kind === candidate.kind).reduce((n, [, v]) => n + v, 0);
  const strength = candidate.kind === 'implement' || candidate.kind === 'inspect' ? Math.max(p, kindMass) : p;
  const tier: Decision['tier'] = a.confidence >= .6 || strength >= .6 ? 'act' : (cheap && strength >= c.routeProbability * .75) || strength >= c.routeProbability ? 'cautious' : 'escalate';
  const needsUser = noul('needs_user');
  const chosen = tier === 'escalate' ? free : needsUser >= .85 && candidate.kind !== 'finish' ? cands.find(x => x.kind === 'ask') ?? candidate : candidate;
  return { candidate: chosen, confidence: a.confidence, probability: p, tier, stuck: noul('stuck'), scopeDrift: noul('scope_drift'), needsUser };
}
// One bounded piece of evidence per deliverable, selected by code from the
// current source and the diff: the citation the audit checks.
export async function completionEvidence(root: string, s: Session, diff: StructuralDiff): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const read = async (p: string | null | undefined) => { if (!p) return null; try { return await boundedRead(await safePath(root, p)); } catch { return null; } };
  const hunksFor = (p: string | undefined) => diff.files.filter(f => p && same(f.path, p)).map(f => f.hunks ?? '').join('\n');
  for (const d of s.ledger) {
    const from = ledgerFile(s, d.from); const to = ledgerFile(s, d.to);
    let text = '';
    if (d.kind === 'move' && d.name) {
      const toText = await read(to); const fromText = await read(from);
      const inTo = toText ? (await topLevelDeclarations(to!, toText)).get(d.name) : undefined; const inFrom = fromText ? (await topLevelDeclarations(from!, fromText)).get(d.name) : undefined;
      text = inTo ? `${to} lines ${inTo.start}-${inTo.end}:\n${toText!.split('\n').slice(inTo.start - 1, Math.min(inTo.end, inTo.start + 11)).join('\n')}` : `${to ?? '?'} does not declare ${d.name}.`;
      text += inFrom ? `\n${from} still declares ${d.name} at lines ${inFrom.start}-${inFrom.end}.` : `\n${from ?? '?'} no longer declares ${d.name}.`;
      const imp = fromText?.split('\n').find(l => /^import\b/.test(l) && l.includes(d.name!)); if (imp) text += `\n${from} imports it: ${imp}`;
    } else if (d.kind === 'create') { const t = await read(to ?? from); text = t === null ? `${to ?? from} does not exist.` : `${to ?? from} exists (${t.split('\n').length} lines):\n${clip(t, 500)}`; }
    else if (d.kind === 'verify') text = s.lastCheck ? `${s.lastCheckCommand ?? 'check'} at step ${s.lastCheck.step}: ${s.lastCheck.ok ? 'passed' : `failed with ${s.lastCheck.summary.errors} error(s)`}${s.lastCheck.step > s.lastWriteStep ? ' (after the last edit)' : ' (before later edits)'}` : 'no verification has run';
    else { const h = hunksFor(to ?? undefined) || hunksFor(from ?? undefined); const t = h ? clip(h, 900) : ''; const cur = !h ? await read(to ?? from) : null; text = t ? `diff of ${to ?? from}:\n${t}` : cur !== null ? `${to ?? from} (unchanged this session; current head):\n${clip(cur, 500)}` : `${to ?? from ?? 'target'}: no evidence available`; }
    out[d.id] = clip(text, 1100);
  }
  return out;
}
// Files the change touched that no deliverable names: the only ones a scope
// question can be about. Code computes the set; Jev judges only what is in it.
export function unaccountedFiles(s: Session, changedFiles: string[]): string[] {
  const named = s.ledger.flatMap(d => [d.from, d.to, d.kind === 'create' ? d.name : undefined]).filter((p): p is string => Boolean(p)).map(p => ledgerFile(s, p) ?? p);
  return changedFiles.filter(f => !named.some(n => same(f, n)) && !/(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb)$/.test(f));
}
export function completionState(s: Session, evidence: Record<string, string>, changedFiles: string[], currentSource?: unknown, diffSummary?: string): Record<string, unknown> {
  const unaccounted = unaccountedFiles(s, changedFiles);
  return {
    ...(unaccounted.length ? { unaccountedFiles: unaccounted } : {}),
    tasks: 'omitted: task entries are worker claims, not evidence', editEvidence: [],
    ...(currentSource ? { currentSource } : {}),
    ...(diffSummary ? { diff: diffSummary } : {}),
    objective: clip(s.objective, 800),
    requirements: referenceContext(s, 2000).map(e => clip(e.text.replace(/^\d+:\s?/gm, '').replace(/\s+/g, ' ').trim(), 500)),
    deliverables: Object.fromEntries(s.ledger.map(d => [d.id, describe(d)])),
    evidence,
    changedFiles: changedFiles.slice(0, 30),
    verification: { command: s.lastCheckCommand, result: s.lastCheck ? (s.lastCheck.ok ? 'passed' : 'failed') : 'none', afterLastEdit: Boolean(s.lastCheck && s.lastCheck.step > s.lastWriteStep) },
  };
}
export function auditQuestions(items: Deliverable[], withObjective = items.length === 0, unaccounted: string[] = []): Questions {
  const q: Questions = {};
  // With no deliverables identified there is nothing to cite: judge the objective as a whole.
  if (withObjective) q.objective_met = { type: 'noul', instructions: 'Considering the objective, `currentSource` (fresh facts about the changed files) and `diff`: is the requested work done? A passing verification alone does not establish it; work the objective did not ask for does not count.' };
  for (const d of items) q[`d_${d.id}`] = { type: 'choice', instructions: `Does \`evidence.${d.id}\` show that deliverable ${d.id} (\`deliverables.${d.id}\`) is done?`, criteria: {
    supports: 'The evidence shows the deliverable is done as described: the declaration, file or change is present where the deliverable says it should be.',
    contradicts: 'The evidence shows the deliverable is not done, is done in the wrong place, or is only partly done.',
    says_nothing: 'The evidence does not address this deliverable either way.' } };
  if (unaccounted.length || withObjective) q.scope_creep = { type: 'noul', instructions: unaccounted.length ? 'Are the changes to `unaccountedFiles` (files no deliverable names) work the objective did not ask for? Build output, lockfiles, generated files and mechanical consequences of the deliverables are in scope.' : 'Do `changedFiles` include work the objective did not ask for?' };
  return q;
}
export interface AuditVerdict { accepted: boolean; perItem: Record<string, { supports: number; contradicts: number; saysNothing: number }>; scopeCreep: number; unmet: string[]; objectiveMet: number | null }
export function auditVerdict(answers: Answers, items: Deliverable[], c: Config): AuditVerdict {
  const perItem: AuditVerdict['perItem'] = {}; const unmet: string[] = [];
  for (const d of items) {
    const a = answers[`d_${d.id}`]; const p = a?.type === 'choice' ? a.probabilities : {};
    const v = { supports: p.supports ?? 0, contradicts: p.contradicts ?? 0, saysNothing: p.says_nothing ?? 0 }; perItem[d.id] = v;
    if (d.unresolvable || d.optional) continue; // optional items never block completion
    const ok = v.supports >= c.completeProbability * .8 || (d.status === 'done' && v.contradicts < .5);
    if (!ok) unmet.push(d.id);
  }
  const scope = answers.scope_creep; const scopeCreep = scope?.type === 'noul' ? scope.noul : 0;
  const om = answers.objective_met; const objectiveMet = om?.type === 'noul' ? om.noul : null;
  const objectiveOk = objectiveMet === null || objectiveMet >= c.completeProbability;
  return { accepted: unmet.length === 0 && scopeCreep < c.completeProbability && objectiveOk, perItem, scopeCreep, unmet, objectiveMet };
}
