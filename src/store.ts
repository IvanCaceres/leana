import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import type { Session } from './types.js';
import { decisionLog } from './decision-log.js';
import { clip, rememberEdit, retireEvidence } from './context.js';
import { editRoutes } from './types.js';
import { summarizeCheck } from './tools.js';
// Sessions live outside the repository, in the user's state directory, so the
// project directory holds only the project: a scaffolder or a clean-tree check
// sees exactly what the user sees.
export function stateDir(root: string): string {
  const base = process.env.LEANA_STATE_DIR ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'leana');
  return join(base, `${basename(root).replace(/[^\w.-]/g, '_')}-${createHash('sha256').update(root).digest('hex').slice(0, 10)}`);
}
export const runsDir = (root: string): string => join(stateDir(root), 'runs');
export class Store {
  readonly artifacts: string;
  constructor(readonly path: string) { this.artifacts = join(path, 'artifacts'); }
  async init(): Promise<void> { await mkdir(this.artifacts, { recursive: true, mode: 0o700 }); }
  async log(type: string, data: unknown): Promise<void> {
    const at = new Date().toISOString();
    await appendFile(join(this.path, 'events.jsonl'), JSON.stringify({ at, type, data }) + '\n', { mode: 0o600 });
    const readable = decisionLog(type, data, at);
    if (readable) await appendFile(join(this.path, 'jev-decisions.md'), readable, { mode: 0o600 });
  }
  async save(s: Session): Promise<void> {
    await writeFile(join(this.path, 'checkpoint.tmp'), JSON.stringify(s, null, 2), { mode: 0o600 });
    await rename(join(this.path, 'checkpoint.tmp'), join(this.path, 'checkpoint.json'));
  }
  async load(): Promise<Session> {
    const s = JSON.parse(await readFile(join(this.path, 'checkpoint.json'), 'utf8')) as Session;
    if (s.version !== 1 || !Array.isArray(s.entries) || !Array.isArray(s.tasks) || typeof s.root !== 'string') throw new Error('Invalid checkpoint');
    s.phase ??= 'inspect'; s.knownFiles ??= []; s.inspectionCount ??= 0; s.lastError ??= null;
    s.lastRoute ??= null; s.lastResultOk ??= false; s.lastWriteStale ??= false; s.coverage ??= {}; s.hashes ??= {}; s.lastPromptTokens ??= 0; s.lastCheck ??= null; s.actions ??= {}; s.searches ??= {}; s.blockedRoute ??= null; s.editsSinceCheck ??= 0; s.readHashes ??= {}; s.writeSteps ??= {};
    s.previousCheck ??= null; s.editSnapshots ??= {}; s.coverageByHash ??= {}; s.repetitionSteps ??= {}; s.focusReadAt ??= -1; s.autoFixKeys ??= {};
    for (const t of [...s.transaction ?? [], ...s.rejectedEdits ?? []]) { (t as any).identity ??= t.key; (t as any).paths ??= []; } s.transaction ??= []; s.rejectedEdits ??= []; s.lastCheckCommand ??= null; s.autoUndo ??= null; s.inspectionsSinceAction ??= 0;
    // Older checkpoints: recover the check command from the pinned bash result.
    // Superseded reads from older checkpoints: keep only their header line.
    for (const e of s.entries) if (e.text.startsWith('[superseded') && e.text.split('\n').length > 2) { const l = e.text.split('\n'); e.text = `${l[0]}\n${l.find(x => x.includes(' sha256=')) ?? ''}`; e.relevance = Math.min(e.relevance, .1); }
    if (!s.lastCheckCommand && s.lastCheck) { const m = s.lastCheck.text.match(/^\{"command":"((?:[^"\\]|\\.)*)"/); if (m) { try { s.lastCheckCommand = JSON.parse(`"${m[1]}"`); } catch { /* leave null */ } } }
    // Checkpoints from before the neutral summary carried per-tool error counts: re-read from the text.
    for (const c of [s.lastCheck, s.previousCheck]) if (c && !c.summary?.files) c.summary = await summarizeCheck(c.text, s.root, s.knownFiles);
    if (!s.editEvidence) {
      s.editEvidence = [];
      await this.recoverEditEvidence(s);
    }
    s.referenceEvidence ??= [];
    // Sessions from before observations were generalized kept the last page render.
    const legacy = (s as any).lastRender as { step: number; ok: boolean; url: string; text: string } | undefined;
    if (legacy && !s.lastObservation) s.lastObservation = { step: legacy.step, kind: 'page', ok: legacy.ok, target: legacy.url, text: legacy.text };
    // Designs from before the neutral schema carried landing-page field names.
    if (s.design) { const d = s.design as any; if (d.pageComposition && !d.composition) d.composition = d.pageComposition; if (d.copy && !d.fixtures) d.fixtures = d.copy; delete d.pageComposition; delete d.copy; }
    for (const d of s.ledger ?? []) { const x = d as any; if (x.layout && !x.placement) x.placement = x.layout; delete x.layout; }
    s.completionFeedback ??= null; s.finishTriedAtCheck ??= -1; s.lastToolError ??= null; s.ledger ??= []; s.design ??= null; s.ledgerAttempts ??= 0; s.ledgerBuilt ??= false; s.ledgerComplete ??= 0; s.checkInferences ??= 0; s.checkInferredFor ??= -1; s.setupDone ??= false; s.setupError ??= null; s.baselineStatus ??= null; s.baselineArtifacts ??= {}; s.pendingRepairs ??= []; s.failedVersions ??= {};
    // Older checkpoints: a create that went through write is a create_file now.
    if (s.blockedRoute === ('write' as string) && s.entries.some(e => e.kind === 'write' && /Created|expectedHash=new/.test(e.text))) s.blockedRoute = null;
    if (!s.completionFeedback && s.stopReason.startsWith('Completion was not established by tool evidence')) {
      s.completionFeedback = { step: s.step, text: 'The previous completion attempt was rejected. Inspect the referenced requirements and current source, then continue the missing work before trying finish again.', awaitingEvidence: true };
      s.phase = 'implement'; s.inspectionsSinceAction = 0;
    }
    retireEvidence(s);
    if (s.lastError) s.lastError = clip(s.lastError, 1500);
    return s;
  }
  // Legacy checkpoints lost successful edits when failures crowded out the
  // working context. Rebuild only from logged successful results and artifacts,
  // never from a worker's task ledger or unexecuted action arguments.
  private async recoverEditEvidence(s: Session): Promise<void> {
    let action: any;
    const input = createReadStream(join(this.path, 'events.jsonl'), { encoding: 'utf8' });
    const lines = createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        let event: any; try { event = JSON.parse(line); } catch { continue; }
        const d = event.data;
        if (!d || d.step > s.step) continue;
        if (event.type === 'action') action = d;
        if (event.type === 'undo') {
          s.editEvidence = s.editEvidence.filter(e => !(d.rejected ?? []).some((r: any) => r.step === e.step));
        }
        if (event.type !== 'result' || !d.ok || action?.step !== d.step || !editRoutes.includes(action.route) || action.rejected) continue;
        const paths = action.route === 'move_lines' ? [action.args.source, action.args.destination] : [action.args.path];
        // Only accept the standard result artifact for this step, not arbitrary log paths.
        const name = `${String(d.step).padStart(5, '0')}.txt`;
        if (d.artifact !== `@artifact/${name}` || !paths.every(p => typeof p === 'string')) continue;
        try { rememberEdit(s, d.step, action.route, paths, d.artifact, await readFile(join(this.artifacts, name), 'utf8'), action.args); }
        catch (e: any) { if (e.code !== 'ENOENT') throw e; }
      }
    } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
    finally { lines.close(); input.destroy(); }
  }
  // Previous content of a file about to be edited, so a bad edit can be undone.
  async snapshot(step: number, path: string, text: string): Promise<string> {
    const name = `${step.toString().padStart(5, '0')}-${path.replace(/[\\/]/g, '__')}`;
    await writeFile(join(this.artifacts, name), text, { mode: 0o600 });
    return `@artifact/${name}`;
  }
  // The exact worker prompt of a step, for inspection; not part of the evidence.
  // A label names a prompt other than the step's own (a file's code generation in the same step), so neither overwrites the other.
  async promptArtifact(step: number, attempt: number, messages: unknown, label?: string): Promise<string> {
    const name = `${step.toString().padStart(5, '0')}-prompt${label ? `-${label.replace(/[^\w.-]/g, '_')}` : ''}${attempt > 1 ? `-${attempt}` : ''}.json`;
    await writeFile(join(this.artifacts, name), JSON.stringify(messages, null, 2), { mode: 0o600 });
    return `@artifact/${name}`;
  }
  async artifact(step: number, text: string): Promise<string> {
    const name = `${step.toString().padStart(5, '0')}.txt`;
    await writeFile(join(this.artifacts, name), text, { mode: 0o600 });
    return `@artifact/${name}`;
  }
}
