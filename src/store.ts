import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Session } from './types.js';
import { decisionLog } from './decision-log.js';
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
    s.lastRoute ??= null; s.lastResultOk ??= false; s.lastWriteStale ??= false; s.coverage ??= {};
    return s;
  }
  async artifact(step: number, text: string): Promise<string> {
    const name = `${step.toString().padStart(5, '0')}.txt`;
    await writeFile(join(this.artifacts, name), text, { mode: 0o600 });
    return `@artifact/${name}`;
  }
}
