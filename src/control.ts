// Jev as the control plane around the loop, never the driver: it reads
// whether the world is moving (progress watchdog), whether a completion claim
// is supported (evidence gate), what kind of failure a command hit (triage),
// and which search hits matter (retrieval ranking). Every answer is a
// calibrated probability over a compact state; the policies that act on the
// readings are deterministic and live in the loop.
import type { Answers, Questions, Session } from './types.js';
import { clip, clipEnds } from './context.js';

export interface Jev {
  decide(state: unknown, questions: Questions, context?: { step: number; phase: string }): Promise<Answers>;
}
const noul = (a: Answers[string] | undefined): number => (a?.type === 'noul' ? a.noul : 0);

// The state every watchdog reading is made from: small, literal, the same
// shape each step, so the readings are comparable across a run.
export function watchState(s: Session): unknown {
  const recent = s.entries
    .filter(e => e.kind !== 'turn')
    .slice(-3)
    .map(e => ({
      step: e.step,
      kind: e.kind,
      ok:
        e.kind !== 'repeat' &&
        !e.text.startsWith('No action executed') &&
        !/^\{"command"[^}]*"code":[1-9]/.test(e.text),
      excerpt: clip(e.text, 300),
    }));
  const previous = s.watch?.readings.at(-1);
  return {
    objective: clip(s.objective, 800),
    notes: clip(s.notes ?? '', 1200),
    step: s.step,
    lastThought: clip(s.lastThought ?? '', 400),
    lastAction: s.lastRoute,
    lastActionOk: s.lastResultOk,
    changedFiles: s.writes.slice(-12),
    changedFileCount: s.writes.length,
    lastWriteStep: s.lastWriteStep,
    verification: s.lastCheck
      ? {
          command: s.lastCheck.command ?? s.lastCheckCommand,
          step: s.lastCheck.step,
          ok: s.lastCheck.ok,
          exitCode: s.lastCheck.summary.code,
          files: Object.keys(s.lastCheck.summary.files).slice(0, 6),
          output: clipEnds(s.lastCheck.text, 400),
          afterLastWrite: s.lastCheck.step > s.lastWriteStep,
        }
      : null,
    lastError: s.lastError ? clip(s.lastError, 300) : null,
    lastObservation: s.lastObservation
      ? {
          kind: s.lastObservation.kind,
          step: s.lastObservation.step,
          afterLastWrite: s.lastObservation.step > s.lastWriteStep,
          ok: s.lastObservation.ok,
          facts: clip(s.lastObservation.text, 500),
        }
      : 'never observed',
    turnsOnlyReading: s.readOnlyTurns ?? 0,
    recent,
    previousReading: previous
      ? { progress: previous.progress, stuck: previous.stuck, sameFailure: previous.sameFailure }
      : null,
    noProgressSteps: s.watch?.noProgress ?? 0,
  };
}
export const watchQuestions: Questions = {
  progress: {
    type: 'noul',
    instructions:
      'Since the previous reading, did the repository or the verification move measurably closer to the objective (a file created or edited toward it, fewer or different errors, new information the worker needed)? A read of a file already shown, a repeated command with the same result, or a plan with no edit is not progress.',
  },
  same_failure: {
    type: 'noul',
    instructions:
      'Is the most recent failure the same failure as the one before it (the same error, the same refused action, the same unresolved package), with nothing changed between them?',
  },
  stuck: {
    type: 'noul',
    instructions:
      'Is the worker stuck: repeating actions or reasoning without the state changing, or circling one problem it has not resolved after several attempts?',
  },
  objective_satisfied: {
    type: 'noul',
    instructions:
      'From the changed files and the verification, does the repository now satisfy the objective as stated?',
  },
  needs_user: {
    type: 'noul',
    instructions:
      'Does moving forward need a decision or information only the user has (a credential, a choice between designs the objective leaves open, a permission)?',
  },
  in_scope: {
    type: 'noul',
    instructions:
      "Is the worker's latest action and reasoning work the objective asks for, as opposed to additional scope the objective did not ask for (extra tooling, tests or features it never mentioned, polishing beyond the request)?",
  },
};
export interface Reading {
  step: number;
  progress: number;
  stuck: number;
  sameFailure: number;
  objective: number;
  needsUser: number;
  inScope: number;
}
export async function watchdog(jev: Jev, s: Session): Promise<Reading> {
  const a = await jev.decide(watchState(s), watchQuestions, { step: s.step, phase: 'watchdog' });
  return {
    step: s.step,
    progress: noul(a.progress),
    stuck: noul(a.stuck),
    sameFailure: noul(a.same_failure),
    objective: noul(a.objective_satisfied),
    needsUser: noul(a.needs_user),
    inScope: a.in_scope ? noul(a.in_scope) : 1,
  };
}

// The evidence gate: code states the facts (what changed, what the check
// said, what the worker claims); Jev judges the meaning.
export interface GateFacts {
  summary: string;
  changedFiles: string[];
  diffStat: string;
  observation?: unknown;
  observationState?: 'current' | 'stale' | 'never' | 'unavailable';
  verification: {
    command: string | null;
    ok: boolean | null;
    afterLastWrite: boolean;
    exitCode: number | null;
    text: string;
  };
  requirements: string[];
  sources: unknown;
}
export const gateQuestions: Questions = {
  implementation_matches_request: {
    type: 'noul',
    instructions:
      'Does the change (changedFiles, diffStat, sources, and the observation of the result as its user meets it, or its absence) implement what the objective and its requirements ask for, as opposed to something adjacent, partial, broken or invented?',
  },
  requirement_unaddressed: {
    type: 'noul',
    instructions: 'Does any requirement of the objective appear unaddressed by the change and the verification?',
  },
  claim_supported: {
    type: 'noul',
    instructions:
      "Is the worker's completion summary supported by the facts shown (files that exist, a verification that passed after the last edit), rather than asserted?",
  },
  weakest_evidence: {
    type: 'choice',
    instructions: 'Which part of the evidence most undermines the completion claim?',
    criteria: {
      observation: 'What observing the result as its user meets it showed, or that it was never observed.',
      verification: 'What the verification command ran and reported.',
      sources: 'The source files and what they implement.',
      requirements: 'Parts of the objective the change does not yet build.',
      summary: 'The summary claims more than the facts show.',
    },
  },
  verification_needed: {
    type: 'choice',
    instructions: 'How much verification does this change deserve before it is accepted as complete?',
    criteria: {
      deterministic_only: 'The passing check and the facts are enough: a small, low-risk change.',
      semantic_review:
        'The facts are consistent but the change is substantial or the check is weak: accept only if the answers above are confident.',
      human: 'The user should look before this is called done: risky, ambiguous, or the verification is missing.',
    },
  },
};
export interface GateVerdict {
  accepted: boolean;
  matches: number;
  unaddressed: number;
  supported: number;
  route: string;
  reason: string;
  // Jev's reading of each clause of the objective, least addressed first (the gate of a change).
  clauses?: { clause: string; p: number }[];
}
// A finish with nothing written, checked or observed is an answer, not a change: there is no result
// to verify or to observe, and the files it rests on are the ones the worker read, not ones it wrote. It is
// judged by the same three readings, asked of an answer against the evidence the worker gathered.
// (A read-only review was shown no files and no verification, read as unsupported each time,
// and paused as stuck.)
export const answerQuestions: Questions = {
  implementation_matches_request: {
    type: 'noul',
    instructions:
      "Nothing was written: the summary is the worker's answer. Does it answer what the objective asks, as opposed to something adjacent, partial or invented?",
  },
  requirement_unaddressed: {
    type: 'noul',
    instructions:
      'Does any part of what the objective asks appear unanswered by the summary, given what was read (read: the files and lines the worker read; unread: files of the repository it never opened)?',
  },
  claim_supported: {
    type: 'noul',
    instructions:
      'Is the summary supported by the evidence shown (what the worker read, searched and ran, and the files and lines it read), rather than asserted?',
  },
};
// What an answer covered: each file read and how much of it, and the repository's files never read.
export interface AnswerCoverage {
  read: Record<string, string>;
  unread: string[];
  files: number;
}
export async function answerGate(
  jev: Jev,
  s: Session,
  summary: string,
  evidence: Record<string, string>,
  coverage: AnswerCoverage,
): Promise<GateVerdict> {
  const clauses = objectiveClauses(s.objective);
  const read = Object.fromEntries(Object.entries(coverage.read).slice(0, 80));
  const unread =
    coverage.unread.length > 80
      ? [...coverage.unread.slice(0, 80), `… and ${coverage.unread.length - 80} more`]
      : coverage.unread;
  const state = {
    objective: s.objective,
    clauses: Object.fromEntries(clauses.map((c, i) => [`clause_${i}`, c])),
    notes: clip(s.notes ?? '', 1500),
    summary: clip(summary, 1500),
    repositoryFiles: coverage.files,
    read,
    unread,
    evidence: { ...evidence },
  };
  // The packet is held under Jev's byte cap as JSON (escaped code is longer than its text): the oldest evidence goes first.
  for (const k of Object.keys(evidence)) {
    if (Buffer.byteLength(JSON.stringify(state)) <= 21000) break;
    delete state.evidence[k];
  }
  const questions: Questions = {
    ...answerQuestions,
    ...Object.fromEntries(
      clauses.map((_, i) => [
        `clause_${i}`,
        {
          type: 'noul',
          instructions: `Is clause_${i} of the objective answered by the summary and the evidence shown?`,
        },
      ]),
    ),
  };
  const a = await jev.decide(state, questions, { step: s.step, phase: 'answer-gate' });
  const weak = clauses.map((c, i) => ({ c, p: noul(a[`clause_${i}`]) })).filter(x => x.p < 0.4);
  const matches = noul(a.implementation_matches_request);
  const unaddressed = noul(a.requirement_unaddressed);
  const supported = noul(a.claim_supported);
  const accepted = !weak.length && matches >= 0.75 && supported >= 0.6;
  const reason = accepted
    ? 'Jev reads the answer as answering the objective, supported by what was read'
    : weak.length
      ? `Jev reads these parts of the objective as not answered: ${weak.map(x => `"${x.c}" (${x.p.toFixed(2)})`).join('; ')}`
      : `Jev reads the answer as ${[matches < 0.75 ? `not answering what the objective asks (${matches.toFixed(2)})` : '', supported < 0.6 ? `not supported by the evidence read (${supported.toFixed(2)}): read what the summary states before finishing, or state only what was read` : ''].filter(Boolean).join(' and ')}`;
  // Where Jev reads part of the objective as unanswered, what was not read is the fact the worker can act on.
  const partly = Object.entries(coverage.read)
    .filter(([, c]) => !c.startsWith('whole'))
    .map(([p, c]) => `${p} (${c})`);
  const gaps =
    !accepted && unaddressed >= 0.5 && (coverage.unread.length || partly.length)
      ? `. Jev reads part of the objective as unanswered (${unaddressed.toFixed(2)}); of the repository's ${coverage.files} files, ${Object.keys(coverage.read).length} were read${partly.length ? `, these in part: ${partly.slice(0, 12).join(', ')}${partly.length > 12 ? ` and ${partly.length - 12} more` : ''}` : ''}${coverage.unread.length ? `; never read: ${coverage.unread.slice(0, 30).join(', ')}${coverage.unread.length > 30 ? ` and ${coverage.unread.length - 30} more` : ''}` : ''}`
      : '';
  return { accepted, matches, unaddressed, supported, route: accepted ? 'answer' : 'rejected', reason: reason + gaps };
}
// The items of an objective the user wrote as a list (bullets or numbered
// lines), so an unaddressed one is named, not merely counted. Prose is not
// split: Jev reads it whole through the questions above.
export const objectiveClauses = (objective: string): string[] => {
  const items = [...objective.matchAll(/^[ \t]*(?:[-*+\u2022]|\d+[.)])[ \t]+(\S.*)$/gm)].map(m => m[1]!.trim());
  return items.length >= 2 ? items.slice(0, 12) : [];
};
// The gate's packet held under Jev's byte cap as JSON (escaped code is longer than its text), as the answer gate
// holds its own: the oldest written file's source goes first, and the files left out are named; then the longest
// texts are shortened. (Run react-demo-glm-1: twelve sources of 1,200 characters, a page observation and the
// summary went over the cap, the finish was never judged, and the run stopped.)
export function fitGateState(state: Record<string, any>, limit = 21000): void {
  const size = () => Buffer.byteLength(JSON.stringify(state));
  const sources = state.sources as Record<string, string> | undefined;
  const left: string[] = [];
  for (const k of Object.keys(sources ?? {})) {
    if (size() <= limit) break;
    delete sources![k];
    left.push(k);
    state.sourcesLeftOut = left;
  }
  for (const n of [800, 400, 200]) {
    if (size() <= limit) break;
    state.summary = clip(String(state.summary ?? ''), n);
    state.notes = clip(String(state.notes ?? ''), n);
    state.diffStat = clip(String(state.diffStat ?? ''), n);
    if (state.observation && typeof state.observation === 'object')
      state.observation = { ...state.observation, facts: clip(String(state.observation.facts ?? ''), n) };
  }
}
export async function evidenceGate(jev: Jev, s: Session, facts: GateFacts): Promise<GateVerdict> {
  const clauses = objectiveClauses(s.objective);
  const observation =
    facts.observation && typeof facts.observation === 'object'
      ? { ...(facts.observation as Record<string, unknown>), question: undefined }
      : facts.observation;
  const state = {
    objective: s.objective,
    clauses: Object.fromEntries(clauses.map((c, i) => [`clause_${i}`, c])),
    notes: clip(s.notes ?? '', 1500),
    ...facts,
    observation,
    sources: { ...(facts.sources as Record<string, string>) } as Record<string, string>,
  } as Record<string, any>;
  fitGateState(state);
  const questions: Questions = {
    ...gateQuestions,
    ...Object.fromEntries(
      clauses.map((_, i) => [
        `clause_${i}`,
        {
          type: 'noul',
          instructions: `Is clause_${i} of the objective addressed by the change and the verification shown?`,
        },
      ]),
    ),
  };
  const a = await jev.decide(state, questions, { step: s.step, phase: 'evidence-gate' });
  const readings = clauses.map((c, i) => ({ clause: c, p: noul(a[`clause_${i}`]) })).sort((x, y) => x.p - y.p);
  const weak = readings.filter(x => x.p < 0.4).map(x => ({ c: x.clause, p: x.p }));
  const matches = noul(a.implementation_matches_request);
  const unaddressed = noul(a.requirement_unaddressed);
  const supported = noul(a.claim_supported);
  const route = a.verification_needed?.type === 'choice' ? a.verification_needed.choice : 'semantic_review';
  const facts_ok = facts.verification.ok !== false && facts.verification.afterLastWrite;
  const obs =
    facts.observation && typeof facts.observation === 'object'
      ? (facts.observation as { kind?: string; target?: string; ok?: boolean; facts?: string; question?: string })
      : null;
  const observationBroken = obs?.ok === false;
  // The evidence Jev reads as weakest, when it is evidence that could be gathered and was not
  // (an observation never made, or made before the last write), is gathered before anything is accepted.
  const weakest = a.weakest_evidence?.type === 'choice' ? a.weakest_evidence.choice : null;
  const weakestP =
    a.weakest_evidence?.type === 'choice' ? (a.weakest_evidence.probabilities[a.weakest_evidence.choice] ?? 0) : 0;
  const observationMissing =
    weakest === 'observation' &&
    weakestP >= 0.5 &&
    (facts.observationState === 'never' || facts.observationState === 'stale');
  const accepted =
    facts_ok &&
    !observationBroken &&
    !observationMissing &&
    route !== 'human' &&
    !weak.length &&
    (route === 'deterministic_only' ? matches >= 0.6 : matches >= 0.75 && supported >= 0.6);
  // A clear rejection is the worker's to act on; only a reading that would otherwise pass is sent to the user.
  // requirement_unaddressed decides nothing here: sending a finish back at 0.6 or more (at most twice) made Claude
  // Haiku 5.5 runs 3 to 5 times dearer and slower, every run sent back twice, for pages 10 to 30% longer, and the reading
  // stayed above 0.6 after the rebuilds.
  const humanReview =
    route === 'human' && facts_ok && !observationBroken && !observationMissing && !weak.length && matches >= 0.6;
  const reason = !facts_ok
    ? 'the verification did not pass after the last edit'
    : observationMissing
      ? `Jev reads the observation as the weakest evidence (${weakestP.toFixed(2)}) and the result ${facts.observationState === 'never' ? 'has never been observed' : 'has not been observed since the last write'}: observe it as its user meets it and act on what that shows before finishing`
      : observationBroken
        ? `the last observation (${obs!.kind} ${obs!.target ?? ''}) failed: ${clip(String(obs!.facts ?? ''), 300)}`
        : humanReview
          ? 'Jev routes this completion to the user'
          : accepted
            ? "the facts and Jev's reading agree"
            : weak.length
              ? `Jev reads these parts of the objective as not addressed: ${weak.map(x => `"${x.c}" (${x.p.toFixed(2)})`).join('; ')}`
              : `Jev reads the change as ${matches < 0.75 ? 'not implementing the request' : ''}${supported < 0.6 ? ' not supported by the facts' : ''}`
                  .replace(/\s+/g, ' ')
                  .trim();
  // A rejection says where Jev reads the gap, with the fact itself, so the worker acts on it rather than guessing.
  const pointer =
    accepted || humanReview || !facts_ok || observationBroken || observationMissing || !weakest
      ? ''
      : `. Jev reads the weakest evidence as ${weakestFact(weakest, facts)}`;
  // A completion about to pass while Jev names one piece of evidence as its weakest gets
  // a second, focused reading of that evidence alone; a clear no there stops it. The
  // question about an observation comes from the observer that made it.
  const focusQuestion =
    weakest === 'observation'
      ? obs
        ? (obs.question ?? genericObservationQuestion)
        : null
      : focusQuestions[weakest ?? ''];
  if ((accepted || humanReview) && weakest && weakestP >= 0.5 && focusQuestion) {
    const evidence =
      weakest === 'observation'
        ? { kind: obs!.kind, target: obs!.target, ok: obs!.ok, facts: obs!.facts }
        : weakest === 'verification'
          ? facts.verification
          : facts.sources;
    const f = await jev.decide(
      { objective: s.objective, evidence: weakest, [weakest]: evidence },
      { evidence_shows_done: { type: 'noul', instructions: focusQuestion } },
      { step: s.step, phase: 'evidence-focus' },
    );
    const focus = noul(f.evidence_shows_done);
    if (focus < 0.3)
      return {
        accepted: false,
        matches,
        unaddressed,
        supported,
        route: 'rejected',
        reason: `Jev's focused reading of the ${weakest} alone is that it does not show the work done (${focus.toFixed(2)}): ${weakestFact(weakest, facts)}`,
        clauses: readings,
      };
  }
  return {
    accepted,
    matches,
    unaddressed,
    supported,
    route: humanReview ? 'human' : accepted ? route : 'rejected',
    reason: reason + pointer,
    clauses: readings,
  };
}
// The focused question per kind of evidence: judged by that evidence alone.
const genericObservationQuestion =
  'Judged only by this observation, does the result work for its user as the objective requires, complete and with nothing broken?';
const focusQuestions: Record<string, string> = {
  verification: 'Judged only by this verification output, does the work build and run as the objective requires?',
  sources:
    'Judged only by these source files, do they implement what the objective asks, completely and without placeholders?',
};
function weakestFact(kind: string, facts: GateFacts): string {
  const o =
    facts.observation && typeof facts.observation === 'object'
      ? (facts.observation as { kind?: string; target?: string; facts?: string })
      : null;
  switch (kind) {
    case 'observation':
      return o
        ? `the observation (${o.kind} ${o.target ?? ''}), which reported: ${clip(String(o.facts ?? ''), 700)}`
        : `the observation: ${String(facts.observation ?? 'none made')}`;
    case 'verification':
      return `the verification (${facts.verification.command ?? 'none'}, exit ${facts.verification.exitCode ?? 'unknown'}): ${clip(facts.verification.text, 400)}`;
    case 'sources':
      return `the source files (${facts.changedFiles.slice(-12).join(', ')}) and what they implement`;
    case 'requirements':
      return 'parts of the objective the change does not build yet';
    default:
      return 'the summary, which claims more than the facts show';
  }
}

// Failure triage: what kind of failure a command hit. The policy (retry
// once, ask the user, tell the worker) is the loop's; the repair is the worker's.
export const failureKinds = {
  code_bug: 'The code or configuration the session wrote is wrong: the worker fixes it.',
  wrong_assumption: 'The worker assumed something the output disproves (a file, a version, a name).',
  bad_command: 'The command itself was malformed or misused.',
  environment: 'The machine lacks a tool or a service the command needs.',
  dependency: 'A package or module is missing, unresolvable, or at a version that does not exist.',
  permission: 'The command was refused for permission, credentials or a prompt it cannot answer.',
  transient: 'A network or timing failure that could pass on a retry.',
  insufficient_context: 'The worker acted without reading what it needed.',
  unknown: 'None of these fits.',
} as const;
export async function triage(
  jev: Jev,
  s: Session,
  command: string,
  output: string,
): Promise<{ kind: keyof typeof failureKinds; probability: number }> {
  const a = await jev.decide(
    {
      objective: clip(s.objective, 400),
      command,
      output: clip(output, 1500),
      lastThought: clip(s.lastThought ?? '', 300),
    },
    { failure: { type: 'choice', instructions: 'What kind of failure is this?', criteria: failureKinds } },
    { step: s.step, phase: 'failure-triage' },
  );
  if (a.failure?.type !== 'choice') return { kind: 'unknown', probability: 0 };
  return {
    kind: a.failure.choice as keyof typeof failureKinds,
    probability: a.failure.probabilities[a.failure.choice] ?? 0,
  };
}

// Retrieval ranking: which of many search hits or document chunks matter for
// what the worker is doing, so the prompt carries the few that do.
export async function relevance(jev: Jev, s: Session, query: string, items: string[], clipTo = 200): Promise<number[]> {
  const questions: Questions = Object.fromEntries(
    items.map((_, i) => [
      `hit_${i}`,
      { type: 'noul', instructions: `Is hit_${i} relevant to the query and the worker's current purpose?` },
    ]),
  );
  const a = await jev.decide(
    {
      objective: clip(s.objective, 300),
      notes: clip(s.notes ?? '', 600),
      lastThought: clip(s.lastThought ?? '', 300),
      query,
      hits: Object.fromEntries(items.map((l, i) => [`hit_${i}`, clip(l, clipTo)])),
    },
    questions,
    { step: s.step, phase: 'retrieval-rank' },
  );
  return items.map((_, i) => noul(a[`hit_${i}`]));
}
export async function rankExcerpts(
  jev: Jev,
  s: Session,
  query: string,
  lines: string[],
  keep = 10,
): Promise<{ kept: string[]; dropped: number }> {
  const pool = lines.slice(0, 24);
  const scores = await relevance(jev, s, query, pool);
  const ranked = pool.map((l, i) => ({ l, p: scores[i]! })).sort((x, y) => y.p - x.p);
  const kept = ranked
    .filter(x => x.p >= 0.4)
    .slice(0, keep)
    .map(x => x.l);
  return {
    kept: kept.length ? kept : ranked.slice(0, Math.min(3, ranked.length)).map(x => x.l),
    dropped: lines.length - Math.max(kept.length, Math.min(3, ranked.length)),
  };
}
