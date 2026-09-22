import { referenceContext } from './references.js';
import { ledgerFile, describe, readyCreates, dependencyItems, type StructuralDiff } from './ledger.js';
import { boundedRead, importCandidates, safePath, topLevelDeclarations } from './tools.js';
import { staleFor } from './context.js';
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

// One finish policy: the facts that make a completion proposal worth auditing.
// Used both to offer the finish candidate and to propose completion after a
// passing check, so no second rule set can veto the first.
// A deliverable name that is a shell command rather than a description, and
// one that would never return (a dev server, a watcher) or changes files.
export const commandLike = (name: string): boolean => /^(?:cd\s+\S+\s*&&\s*)?(?:npm|pnpm|yarn|bun|npx|node|tsc|vite|python3?|pytest|cargo|go|make|mvn|gradle|eslint|ruff)\b/.test(name.trim());
// The run a command-named verify item cites: the command's own run, or the
// last check when the check is that command (legacy checkpoints record no runs).
export function verifyRun(s: Session, name: string): { step: number; ok: boolean } | undefined {
  const key = name.trim();
  return s.commandRuns?.[key] ?? (s.lastCheck && (!s.lastCheckCommand || s.lastCheckCommand.trim() === key) ? { step: s.lastCheck.step, ok: s.lastCheck.ok } : undefined);
}
export const runnableForever = (name: string): boolean => /\b(dev|start|serve|preview|watch|format|fix|deploy|publish|storybook|release|clean)\b|--watch|--write|--fix/.test(name);
export function readyToFinish(s: Session): boolean {
  return Boolean(s.lastCheck?.ok && s.editEvidence.length && s.lastCheck.step > s.lastWriteStep && !s.pendingCheck && !s.autoUndo
    && staleFor(s).length === 0 && !s.missingNames.length && !s.pendingMoves.length && !s.pendingRepairs.length
    // A required deliverable still pending by source facts (a file not created, a
    // declaration not moved or exported) makes a proposal pointless: the audit would
    // only say what the facts already say. Items judged by the diff alone are the audit's.
    && !s.ledger.some(d => d.status === 'pending' && !d.optional && !d.unresolvable && (d.kind !== 'verify' || (Boolean(d.name && commandLike(d.name)) && (d.attempts ?? 0) < 2))) && s.finishTriedAtCheck !== s.lastCheck.step
    && !s.tasks.some(t => t.status === 'pending') && !s.completionFeedback?.awaitingEvidence);
}
export interface TaskRecord {
  objective: string;
  requirements?: string[];
  design?: { summary: string; conventions: string };
  deliverables: { id: string; kind: string; name: string; where: string; status: string; optional?: boolean; derived?: boolean; note?: string }[];
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
    deliverables: s.ledger.slice(0, 16).map(d => ({ id: d.id, kind: d.kind, name: d.name ?? '', where: d.kind === 'move' ? `${d.from ?? '?'} -> ${d.to ?? '?'}` : (d.to ?? d.from ?? ''), status: d.unresolvable ? 'unresolvable' : d.status, ...(d.optional ? { optional: true } : {}), ...(d.derived ? { derived: true } : {}), ...(d.note ? { note: clip(d.note, 90) } : {}) })),
    verification: { command: s.lastCheckCommand, lastResult: s.lastCheck ? (s.lastCheck.ok ? 'passed' : 'failed') : 'none', current: Boolean(s.lastCheck && s.lastCheck.step > s.lastWriteStep && !s.pendingCheck), errors: s.lastCheck?.summary.errors ?? 0,
      ...(s.lastCheck && !s.lastCheck.ok ? { firstError: clip(Object.values(s.lastCheck.summary.byFile)[0]?.samples[0] ?? '', 160) } : {}), step: s.lastCheck?.step ?? null },
    changes: { files: s.writes.slice(-12), count: s.writes.length, lastEditStep: s.lastWriteStep },
    lastAction: last ? { step: last.step, action: last.kind, ok: !last.text.startsWith('Tool error') && last.kind !== 'generation_error' && last.kind !== 'finish_rejected', summary: clip(last.text.replace(/\s+/g, ' '), 240) } : null,
    progress: { step: s.step, inspectionsSinceAction: s.inspectionsSinceAction, repeatedResults: Math.max(0, ...Object.values(s.repetitions ?? {}).map(n => Number(n) || 0)), editsSinceCheck: s.editsSinceCheck },
    ...(s.completionFeedback && !s.completionFeedback.addressed ? { blocker: clip(s.completionFeedback.text, 300) } : s.lastError ? { blocker: clip(s.lastError.replace(/\s+/g, ' '), 200) } : {}),
  };
}
export interface Candidate { id: string; kind: 'implement' | 'fix' | 'inspect' | 'search' | 'finish' | 'ask' | 'free' | 'verify'; description: string; target?: { deliverable?: Deliverable; path?: string; start?: number; end?: number; name?: string; errors?: string[] } }
// Concrete actions the record supports. Verification, rollback, resolved fixes
// and ledger moves are code's own and never appear here.
// Errors that name a module a pending deliverable will provide are not fix
// work: the module is created next and the errors go with it.
function awaitingModules(s: Session, file: string, v: { count: number; resolution?: number; samples: string[] }): boolean {
  const pending = s.ledger.filter(d => d.kind === 'create' && d.status !== 'done' && d.to);
  // A configuration with no inputs yet is waiting for the files, not for a fix.
  if (pending.length && v.samples.length && v.samples.every(x => /TS18003|No inputs were found/.test(x))) return true;
  if ((v.resolution ?? 0) < v.count) return false;
  const modules = v.samples.map(x => x.match(/Cannot find module '([^']+)'/)?.[1]).filter((m): m is string => Boolean(m));
  return modules.length > 0 && modules.every(m => importCandidates(file, m).some(p => pending.some(d => same(d.to!, p))));
}
export function candidates(s: Session, c: Config, ready: boolean): Candidate[] {
  const out: Candidate[] = [];
  const failed = s.lastCheck && !s.lastCheck.ok;
  if (ready) out.push({ id: 'finish', kind: 'finish', description: 'Every deliverable is done by source facts and the verification passed after the last edit: propose completion for the audit.' });
  if (c.allowWrite) {
    // One file to create at a time: the head of the dependency order, whose
    // imports exist so its generation can see real signatures. Jev cannot
    // order, so offering several interchangeable files only spreads its
    // probability; the description says what creating this one unblocks.
    const ordered = readyCreates(s);
    const head = ordered.find(d => (d.attempts ?? 0) < 3) ?? null;
    const offer = (d: Deliverable, why = '') => out.push({ id: `implement:${d.id}`, kind: 'implement', target: { deliverable: d }, description: `Implement ${d.optional ? 'optional ' : ''}deliverable ${d.id} (${describe(d)}); status ${d.status}${d.note ? `: ${clip(d.note, 80)}` : ''}${why}${d.optional ? '. Optional: a reasonable addition, not required for completion' : ''}.` });
    if (head) {
      const unblocks = s.ledger.filter(o => o !== head && o.kind === 'create' && o.status !== 'done' && dependencyItems(s, o).includes(head)).map(o => o.to).filter(Boolean).slice(0, 5);
      offer(head, unblocks.length ? `; imported by ${unblocks.join(', ')}, which cannot be created before it` : '');
    }
    const others = s.ledger.filter(d => d.status !== 'done' && !d.unresolvable && d.kind !== 'verify' && d.kind !== 'create' && (d.attempts ?? 0) < 3 && !(d.kind === 'move' && s.pendingMoves.some(m => m.name === d.name)));
    for (const d of [...others.filter(d => !d.optional), ...others.filter(d => d.optional)].slice(0, 5)) offer(d);
    // Dependencies that would not install are the manifest's problem, and until
    // they install nothing can be verified: the manifest is fix work first.
    if (s.setupError) { const manifest = [...s.writes, ...s.knownFiles].find(f => /(^|\/)package\.json$/.test(f)) ?? 'package.json'; out.push({ id: 'fix:setup', kind: 'fix', target: { path: manifest, errors: [`npm install failed: ${s.setupError}`] }, description: `Fix ${manifest}: dependencies could not be installed (${clip(s.setupError, 140)}); nothing can be verified until they do.` }); }
    if (failed) for (const [file, v] of Object.entries(s.lastCheck!.summary.byFile).slice(0, 4)) {
      if (file === '(other)') {
        // Errors the check attributes to no file (a bundler's missing entry, a
        // failing test) are work once every file exists; while files are still
        // to be created they are consequences of what is missing, not work.
        if (s.ledger.some(d => d.kind === 'create' && d.status !== 'done' && !d.unresolvable && !d.optional)) continue;
        out.push({ id: 'fix:project', kind: 'free', target: { errors: v.samples }, description: `Address the ${v.count} verification error(s) not attributed to any file (first: ${clip(v.samples[0] ?? '', 120)}): the worker proposes the file to create or edit, or the command to run.` });
        continue;
      }
      const path = [...s.writes, ...s.knownFiles].find(f => same(f, file)) ?? file;
      if (awaitingModules(s, path, v)) continue;
      // Three failed rewrites of this version of the file: not again until it changes.
      if ((s.fixAttempts?.[`${path}@${s.hashes[path] ?? ''}`] ?? 0) >= 3) continue;
      out.push({ id: `fix:${path}`, kind: 'fix', target: { path, start: v.lines[0], end: v.lines.at(-1), errors: v.samples }, description: `Fix the ${v.count} error(s) the verification reports in ${path} (first: ${clip(v.samples[0] ?? '', 120)}).` });
    }
  }
  // Inspections: files the deliverables or errors name that are not readable at their current version.
  const unread = (p: string) => s.readHashes[p] === undefined || s.readHashes[p] !== s.hashes[p];
  const named = new Set<string>();
  for (const d of s.ledger) for (const p of [d.from, d.to]) { const f = p ? ledgerFile(s, p) : null; if (f && (s.knownFiles.includes(f) || s.writes.includes(f))) named.add(f); }
  if (failed) for (const file of Object.keys(s.lastCheck!.summary.byFile)) { const f = [...s.writes, ...s.knownFiles].find(x => same(x, file)); if (f) named.add(f); }
  // A file this session wrote needs no read: code holds it and edits it by
  // region; a read is for files the deliverables name that came with the repository.
  for (const p of [...named].slice(0, 4)) if (unread(p) && !s.writes.includes(p)) out.push({ id: `inspect:${p}`, kind: 'inspect', target: { path: p }, description: `Read ${p}${s.hashes[p] ? ' again: it changed since it was last read' : ''} before editing it.` });
  for (const d of s.ledger) if ((d.status === 'unknown' || d.unresolvable) && d.name && d.kind !== 'verify' && d.kind !== 'create' && d.kind !== 'other' && /^[A-Za-z_$][\w$]*$/.test(d.name)) out.push({ id: `search:${d.name}`, kind: 'search', target: { name: d.name }, description: `Locate where ${d.name} is declared: the deliverable's location is unknown.` });
  // A verify deliverable that names a command is run by code once the current
  // check passes after the last edit: the command is known, so nothing is
  // generated, and its outcome is judged like a check.
  if (c.allowBash && s.lastCheck?.ok && s.lastCheck.step > s.lastWriteStep && !s.pendingCheck) {
    for (const d of s.ledger) if (d.kind === 'verify' && d.status !== 'done' && !d.unresolvable && d.name && commandLike(d.name) && !runnableForever(d.name) && (d.attempts ?? 0) < 2 && (verifyRun(s, d.name)?.step ?? -1) <= s.lastWriteStep)
      out.push({ id: `verify:${d.id}`, kind: 'verify', target: { deliverable: d, name: d.name.trim() }, description: `Run ${d.name}: the design's verification ${d.id} (${clip(d.detail, 100)}) has not run since the last edit.` });
  }
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
  let chosen = tier === 'escalate' ? free : needsUser >= .85 && candidate.kind !== 'finish' ? cands.find(x => x.kind === 'ask') ?? candidate : candidate;
  // Asking the user while Jev judges the task does not need them is a
  // contradiction resolved in code: the next-ranked action is taken instead of
  // generating a question only to refuse it.
  if (chosen.kind === 'ask' && needsUser < .5) chosen = ranked.map(([k]) => cands.find(x => x.id === k)!).find(x => x && x.kind !== 'ask') ?? free;
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
    else if (d.kind === 'verify') {
      // A verify item that names a command cites that command's own run.
      const run = d.name && commandLike(d.name) ? verifyRun(s, d.name) : undefined;
      text = d.name && commandLike(d.name) ? (run ? `${d.name} at step ${run.step}: ${run.ok ? 'passed' : 'failed'}${run.step > s.lastWriteStep ? ' (after the last edit)' : ' (before later edits)'}` : `${d.name} has not been run this session`)
        : s.lastCheck ? `${s.lastCheckCommand ?? 'check'} at step ${s.lastCheck.step}: ${s.lastCheck.ok ? 'passed' : `failed with ${s.lastCheck.summary.errors} error(s)`}${s.lastCheck.step > s.lastWriteStep ? ' (after the last edit)' : ' (before later edits)'}` : 'no verification has run';
    }
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
