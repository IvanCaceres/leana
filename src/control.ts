// Jev as the control plane around the loop, never the driver: it reads
// whether the world is moving (progress watchdog), whether a completion claim
// is supported (evidence gate), what kind of failure a command hit (triage),
// and which search hits matter (retrieval ranking). Every answer is a
// calibrated probability over a compact state; the policies that act on the
// readings are deterministic and live in the loop.
import type { Answers, Questions, Session } from './types.js';
import { clip } from './context.js';

export interface Jev { decide(state: unknown, questions: Questions, context?: { step: number; phase: string }): Promise<Answers> }
const noul = (a: Answers[string] | undefined): number => a?.type === 'noul' ? a.noul : 0;

// The state every watchdog reading is made from: small, literal, the same
// shape each step, so the readings are comparable across a run.
export function watchState(s: Session): unknown {
  const recent = s.entries.slice(-3).map(e => ({ step: e.step, kind: e.kind, ok: !e.text.startsWith('No action executed') && !/^\{"command"[^}]*"code":[1-9]/.test(e.text), excerpt: clip(e.text, 300) }));
  const previous = s.watch?.readings.at(-1);
  return {
    objective: clip(s.objective, 800), notes: clip(s.notes ?? '', 1200), step: s.step,
    lastThought: clip(s.lastThought ?? '', 400), lastAction: s.lastRoute, lastActionOk: s.lastResultOk,
    changedFiles: s.writes.slice(-12), changedFileCount: s.writes.length, lastWriteStep: s.lastWriteStep,
    verification: s.lastCheck ? { command: s.lastCheck.command ?? s.lastCheckCommand, step: s.lastCheck.step, ok: s.lastCheck.ok, errors: s.lastCheck.summary.errors, files: Object.keys(s.lastCheck.summary.byFile).slice(0, 6), firstError: clip(Object.values(s.lastCheck.summary.byFile)[0]?.samples[0] ?? '', 200), afterLastWrite: s.lastCheck.step > s.lastWriteStep } : null,
    lastError: s.lastError ? clip(s.lastError, 300) : null,
    lastRender: s.lastRender ? { step: s.lastRender.step, afterLastWrite: s.lastRender.step > s.lastWriteStep, ok: s.lastRender.ok, facts: clip(s.lastRender.text, 500) } : 'never rendered',
    turnsOnlyReading: s.readOnlyTurns ?? 0,
    recent, previousReading: previous ? { progress: previous.progress, stuck: previous.stuck, sameFailure: previous.sameFailure } : null, noProgressSteps: s.watch?.noProgress ?? 0,
  };
}
export const watchQuestions: Questions = {
  progress: { type: 'noul', instructions: 'Since the previous reading, did the repository or the verification move measurably closer to the objective (a file created or edited toward it, fewer or different errors, new information the worker needed)? A read of a file already shown, a repeated command with the same result, or a plan with no edit is not progress.' },
  same_failure: { type: 'noul', instructions: 'Is the most recent failure the same failure as the one before it (the same error, the same refused action, the same unresolved package), with nothing changed between them?' },
  stuck: { type: 'noul', instructions: 'Is the worker stuck: repeating actions or reasoning without the state changing, or circling one problem it has not resolved after several attempts?' },
  objective_satisfied: { type: 'noul', instructions: 'From the changed files and the verification, does the repository now satisfy the objective as stated?' },
  needs_user: { type: 'noul', instructions: 'Does moving forward need a decision or information only the user has (a credential, a choice between designs the objective leaves open, a permission)?' },
  in_scope: { type: 'noul', instructions: 'Is the worker\'s latest action and reasoning work the objective asks for, as opposed to additional scope the objective did not ask for (extra tooling, tests or features it never mentioned, polishing beyond the request)?' },
};
export interface Reading { step: number; progress: number; stuck: number; sameFailure: number; objective: number; needsUser: number; inScope: number }
export async function watchdog(jev: Jev, s: Session): Promise<Reading> {
  const a = await jev.decide(watchState(s), watchQuestions, { step: s.step, phase: 'watchdog' });
  return { step: s.step, progress: noul(a.progress), stuck: noul(a.stuck), sameFailure: noul(a.same_failure), objective: noul(a.objective_satisfied), needsUser: noul(a.needs_user), inScope: a.in_scope ? noul(a.in_scope) : 1 };
}

// The evidence gate: code states the facts (what changed, what the check
// said, what the worker claims); Jev judges the meaning.
export interface GateFacts { summary: string; changedFiles: string[]; diffStat: string; render?: unknown; verification: { command: string | null; ok: boolean | null; afterLastWrite: boolean; errors: number; text: string }; requirements: string[]; sources: unknown }
export const gateQuestions: Questions = {
  implementation_matches_request: { type: 'noul', instructions: 'Does the change (changedFiles, diffStat, sources, and for anything user-facing the render facts: errors, failed requests, broken images, overflow, unstyled lists, a page never rendered) implement what the objective and its requirements ask for, as opposed to something adjacent, partial, broken, unstyled or invented?' },
  requirement_unaddressed: { type: 'noul', instructions: 'Does any requirement of the objective appear unaddressed by the change and the verification?' },
  claim_supported: { type: 'noul', instructions: 'Is the worker\'s completion summary supported by the facts shown (files that exist, a verification that passed after the last edit), rather than asserted?' },
  verification_needed: { type: 'choice', instructions: 'How much verification does this change deserve before it is accepted as complete?', criteria: { deterministic_only: 'The passing check and the facts are enough: a small, low-risk change.', semantic_review: 'The facts are consistent but the change is substantial or the check is weak: accept only if the answers above are confident.', human: 'The user should look before this is called done: risky, ambiguous, or the verification is missing.' } },
};
export interface GateVerdict { accepted: boolean; matches: number; unaddressed: number; supported: number; route: string; reason: string }
// The clauses of an objective, so an unaddressed requirement is named, not merely counted.
export const objectiveClauses = (objective: string): string[] => objective.split(/\n+|(?<=[a-z\)])[.;]\s+|,\s+(?:and\s+)?|\s+and\s+(?=[a-z])|\s+with\s+(?=[a-z])/i).map(c => c.trim().replace(/^(?:and|with)\s+/i, '')).filter(c => c.split(/\s+/).length >= 2).slice(0, 8);
export async function evidenceGate(jev: Jev, s: Session, facts: GateFacts): Promise<GateVerdict> {
  const clauses = objectiveClauses(s.objective);
  const state = { objective: s.objective, clauses: Object.fromEntries(clauses.map((c, i) => [`clause_${i}`, c])), notes: clip(s.notes ?? '', 1500), ...facts, sources: facts.sources };
  const questions: Questions = { ...gateQuestions, ...Object.fromEntries(clauses.map((_, i) => [`clause_${i}`, { type: 'noul', instructions: `Is clause_${i} of the objective addressed by the change and the verification shown?` }])) };
  const a = await jev.decide(state, questions, { step: s.step, phase: 'evidence-gate' });
  const weak = clauses.map((c, i) => ({ c, p: noul(a[`clause_${i}`]) })).filter(x => x.p < .4);
  const matches = noul(a.implementation_matches_request); const unaddressed = noul(a.requirement_unaddressed); const supported = noul(a.claim_supported);
  const route = a.verification_needed?.type === 'choice' ? a.verification_needed.choice : 'semantic_review';
  const facts_ok = facts.verification.ok !== false && facts.verification.afterLastWrite;
  const renderBroken = Boolean(facts.render && typeof facts.render === 'object' && (facts.render as any).ok === false);
  const accepted = facts_ok && !renderBroken && route !== 'human' && !weak.length && (route === 'deterministic_only' ? matches >= .6 : matches >= .75 && supported >= .6);
  // A clear rejection is the worker's to act on; only a reading that would otherwise pass is sent to the user.
  const humanReview = route === 'human' && facts_ok && !renderBroken && !weak.length && matches >= .6;
  const reason = !facts_ok ? 'the verification did not pass after the last edit' : renderBroken ? `the last render of ${(facts.render as any).url ?? 'the page'} failed: ${clip(String((facts.render as any).facts ?? ''), 300)}` : humanReview ? 'Jev routes this completion to the user' : accepted ? 'the facts and Jev\'s reading agree' : weak.length ? `Jev reads these parts of the objective as not addressed: ${weak.map(x => `"${x.c}" (${x.p.toFixed(2)})`).join('; ')}` : `Jev reads the change as ${matches < .75 ? 'not implementing the request' : ''}${supported < .6 ? ' not supported by the facts' : ''}`.replace(/\s+/g, ' ').trim();
  return { accepted, matches, unaddressed, supported, route: humanReview ? 'human' : accepted ? route : 'rejected', reason };
}

// Failure triage: what kind of failure a command hit. The policy (retry
// once, ask the user, tell the worker) is the loop's; the repair is the worker's.
export const failureKinds = { code_bug: 'The code or configuration the session wrote is wrong: the worker fixes it.', wrong_assumption: 'The worker assumed something the output disproves (a file, a version, a name).', bad_command: 'The command itself was malformed or misused.', environment: 'The machine lacks a tool or a service the command needs.', dependency: 'A package or module is missing, unresolvable, or at a version that does not exist.', permission: 'The command was refused for permission, credentials or a prompt it cannot answer.', transient: 'A network or timing failure that could pass on a retry.', insufficient_context: 'The worker acted without reading what it needed.', unknown: 'None of these fits.' } as const;
export async function triage(jev: Jev, s: Session, command: string, output: string): Promise<{ kind: keyof typeof failureKinds; probability: number }> {
  const a = await jev.decide({ objective: clip(s.objective, 400), command, output: clip(output, 1500), lastThought: clip(s.lastThought ?? '', 300) }, { failure: { type: 'choice', instructions: 'What kind of failure is this?', criteria: failureKinds } }, { step: s.step, phase: 'failure-triage' });
  if (a.failure?.type !== 'choice') return { kind: 'unknown', probability: 0 };
  return { kind: a.failure.choice as keyof typeof failureKinds, probability: a.failure.probabilities[a.failure.choice] ?? 0 };
}

// Retrieval ranking: which of many search hits matter for what the worker is
// doing, so the prompt carries the few that do.
export async function rankExcerpts(jev: Jev, s: Session, query: string, lines: string[], keep = 10): Promise<{ kept: string[]; dropped: number }> {
  const pool = lines.slice(0, 24);
  const questions: Questions = Object.fromEntries(pool.map((_, i) => [`hit_${i}`, { type: 'noul', instructions: `Is hit_${i} relevant to the query and the worker's current purpose?` }]));
  const a = await jev.decide({ objective: clip(s.objective, 300), notes: clip(s.notes ?? '', 600), lastThought: clip(s.lastThought ?? '', 300), query, hits: Object.fromEntries(pool.map((l, i) => [`hit_${i}`, clip(l, 200)])) }, questions, { step: s.step, phase: 'retrieval-rank' });
  const ranked = pool.map((l, i) => ({ l, p: noul(a[`hit_${i}`]) })).sort((x, y) => y.p - x.p);
  const kept = ranked.filter(x => x.p >= .4).slice(0, keep).map(x => x.l);
  return { kept: kept.length ? kept : ranked.slice(0, Math.min(3, ranked.length)).map(x => x.l), dropped: lines.length - Math.max(kept.length, Math.min(3, ranked.length)) };
}
