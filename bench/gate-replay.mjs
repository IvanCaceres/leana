// Replays the completion gate's logged requests to Jev with the gate as it is built now, to measure a change to how
// a finish is presented before running a benchmark: how many good finishes it accepts, and that it still accepts no
// flawed one.
//
//   npm run build && node bench/gate-replay.mjs [suite directory ...]
//
// Good finishes: every gate request in the suites' Leana trials whose check passed and whose result was observed
// working. Flawed finishes: copies of some of them with a real flaw (the objective names a feature none of them has;
// the summary claims a feature that is not there; the source is a stub). Jev answers a state the same way each time
// (within about 0.01), so a difference between two builds is the presentation's. A stale observation is taken as
// made again, as the gate now does. Needs TYPESAFE_API_KEY; about two Jev calls per request, a few cents per run.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { gateState, gateQuestions, fitGateState } = await import(
  pathToFileURL(join(root, 'dist', 'src', 'control.js')).href
);
const key = process.env.TYPESAFE_API_KEY;
if (!key) throw new Error('Set TYPESAFE_API_KEY');

const harnesses = join(root, 'work', 'bench', 'harnesses');
const suites = process.argv.slice(2).length
  ? process.argv.slice(2)
  : existsSync(harnesses)
    ? readdirSync(harnesses).map(d => join(harnesses, d))
    : [];

// Text Jev refuses (half an emoji) made well-formed, as the client does.
const wellFormed = v =>
  typeof v === 'string'
    ? v.toWellFormed()
    : Array.isArray(v)
      ? v.map(wellFormed)
      : v && typeof v === 'object'
        ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, wellFormed(x)]))
        : v;
async function ask(state, questions) {
  for (let k = 0; k < 4; k++) {
    const r = await fetch('https://api.typesafe.ai/v1/systemone', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: 'jev-latest', state: wellFormed(state), questions }),
    });
    if (r.ok) return (await r.json()).answers;
    if (r.status === 400) throw new Error(`HTTP 400: ${(await r.text()).slice(0, 300)}`);
    await new Promise(res => setTimeout(res, 1500 * (k + 1)));
  }
  throw new Error('Jev did not answer');
}

// The facts of a logged request, whichever layout logged it: flat, or grouped under result and workerReport.
function factsOf(st) {
  const res = st.result;
  const report = st.workerReport ?? {};
  const notDone = report.notDoneOrUntested ?? st.workerNotes;
  const summary = report.summary ?? st.summary ?? '';
  const obs = res ? res.observation : st.observation;
  const observationState = res ? res.observation?.state : st.observationState;
  const check = res?.check;
  return {
    objective: st.objective,
    notes: typeof st.notes === 'string' ? st.notes : (report.workingNotes?.text ?? st.workingNotes?.text ?? ''),
    facts: {
      summary: notDone ? `${summary}\n\nLimitations:\n${notDone}` : summary,
      changedFiles: res?.files?.changed ?? st.changedFiles ?? [],
      diffStat: res?.files?.diffStat ?? st.diffStat ?? '',
      observation: obs && typeof obs === 'object' ? (({ state, ...o }) => o)(obs) : obs,
      observationState: observationState ?? 'never',
      verification: check
        ? {
            command: check.command,
            ok: check.passed,
            afterLastWrite: check.ranAfterLastEdit,
            exitCode: check.exitCode,
            text: check.output,
          }
        : st.verification,
      requirements: st.requirements ?? [],
      sources: res?.files?.sources ?? st.sources ?? {},
    },
  };
}

const good = [];
for (const suite of suites) {
  if (!existsSync(join(suite, 'suite.json'))) continue;
  const model = JSON.parse(readFileSync(join(suite, 'suite.json'), 'utf8')).scenario?.model ?? '?';
  for (const d of readdirSync(suite).filter(d => /^leana-\d+$/.test(d))) {
    const trial = join(suite, d, 'trial.json');
    const session = existsSync(trial) ? JSON.parse(readFileSync(trial, 'utf8')).usage?.extra?.session : null;
    if (!session || !existsSync(join(session, 'events.jsonl'))) continue;
    for (const l of readFileSync(join(session, 'events.jsonl'), 'utf8').split('\n')) {
      if (!l.includes('"evidence-gate"') || !l.includes('"jev-request"')) continue;
      const e = JSON.parse(l);
      if (e.type !== 'jev-request' || e.data.phase !== 'evidence-gate') continue;
      const c = factsOf(e.data.state);
      if (!c.facts.verification?.ok || c.facts.observation?.ok === false) continue;
      if (c.facts.observationState === 'stale') c.facts.observationState = 'current';
      good.push({ model, ...c });
    }
  }
}
if (!good.length) throw new Error('No logged gate requests in the suites given');

const flawed = [];
const plain = good.filter(
  c => !/roi|calculator|stripe|checkout/i.test(JSON.stringify(c.facts.sources) + c.facts.summary),
);
const every = Math.max(1, Math.floor(plain.length / 24));
plain
  .filter((_, i) => i % every === 0)
  .slice(0, 24)
  .forEach((c, k) => {
    if (k % 3 === 0)
      flawed.push({
        ...c,
        kind: 'missing feature',
        objective: `${c.objective}, including an interactive ROI calculator`,
      });
    if (k % 3 === 1)
      flawed.push({
        ...c,
        kind: 'unsupported claim',
        facts: {
          ...c.facts,
          summary: `${c.facts.summary}\n\nIt also includes a working Stripe checkout and an interactive ROI calculator, both tested.`,
        },
      });
    if (k % 3 === 2)
      flawed.push({
        ...c,
        kind: 'stub',
        facts: {
          ...c.facts,
          changedFiles: ['src/App.tsx'],
          sources: {
            'src/App.tsx': 'export default function App() {\n  return <main><h1>Coming soon</h1></main>;\n}\n',
          },
          observation: c.facts.observation && {
            ...c.facts.observation,
            facts:
              'Rendered: no exception, every request loaded.\nTitle "Coming soon"; height 804px; 11 characters of text.\nHeadings: h1: Coming soon',
          },
        },
      });
  });

// The gate's acceptance rules (evidenceGate) on Jev's answers.
function verdict(a, observationState) {
  const weakest = a.weakest_evidence?.choice;
  const wp = a.weakest_evidence?.probabilities?.[weakest] ?? 0;
  if (weakest === 'observation' && wp >= 0.5 && ['stale', 'never'].includes(observationState)) return 'reject';
  const m = a.implementation_matches_request.noul;
  const route = a.verification_needed.choice;
  if (route === 'human') return m >= 0.6 ? 'person' : 'reject';
  return (route === 'deterministic_only' ? m >= 0.6 : m >= 0.75 && a.claim_supported.noul >= 0.6) ? 'accept' : 'reject';
}
async function judge(c) {
  const observation =
    c.facts.observation && typeof c.facts.observation === 'object'
      ? { ...c.facts.observation, question: undefined }
      : c.facts.observation;
  const state = gateState({ objective: c.objective, notes: c.notes }, c.facts, observation, []);
  fitGateState(state);
  return verdict(await ask(state, gateQuestions), c.facts.observationState);
}
async function all(list) {
  const out = [];
  for (let i = 0; i < list.length; i += 6) out.push(...(await Promise.all(list.slice(i, i + 6).map(judge))));
  return out;
}
const g = await all(good);
const f = await all(flawed);
const count = (xs, v) => xs.filter(x => x === v).length;
console.log(
  `Good finishes (${good.length}): accepted ${count(g, 'accept')}, to a person ${count(g, 'person')}, rejected ${count(g, 'reject')}`,
);
for (const m of [...new Set(good.map(c => c.model))]) {
  const mine = g.filter((_, i) => good[i].model === m);
  console.log(`  ${m}: accepted ${count(mine, 'accept')} of ${mine.length}`);
}
console.log(`Flawed finishes (${flawed.length}): accepted ${count(f, 'accept')}, to a person ${count(f, 'person')}`);
for (const k of [...new Set(flawed.map(c => c.kind))]) {
  const mine = f.filter((_, i) => flawed[i].kind === k);
  console.log(`  ${k}: accepted ${count(mine, 'accept')} of ${mine.length}`);
}
