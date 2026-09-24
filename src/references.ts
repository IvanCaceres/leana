import type { Session } from './types.js';
import { boundedRead, hash, safePath } from './tools.js';

// The files the objective names are pinned for the worker as source excerpts,
// never as model-written interpretations of the task. The harness reads each
// one itself (bounded), cuts it into overlapping chunks, and when the chunks do
// not all fit, Jev ranks them against the objective; the prompt carries the
// best-ranked ones. A file that changes is read and ranked again.
const chunkLines = 30; const chunkStep = 20; const maxChunks = 120; const storeBytes = 12000;
export type Rank = (query: string, chunks: string[]) => Promise<number[]>;

// Path tokens of the objective that are files of the repository: as written
// from the root, or the one known file that ends with it.
export async function namedFiles(root: string, objective: string, known: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const m of objective.matchAll(/(?:^|[\s"'`(\[<])((?:\.\/)?(?:[\w@+.-]+\/)*[\w@+-][\w@+.-]*\.[A-Za-z]\w{0,7})(?=$|[\s"'`)\]>:;,.!?])/g)) {
    const token = m[1]!.replace(/^\.\//, '');
    let path: string | null = await safePath(root, token).then(() => token, () => null);
    if (!path) { const ends = known.filter(f => f.endsWith(`/${token}`)); path = ends.length === 1 ? ends[0]! : null; }
    if (path && !out.includes(path)) out.push(path);
  }
  return out;
}

// Refresh the pinned chunks of every named file whose content changed since it
// was pinned. Returns the paths that were (re)pinned.
export async function pinReferences(s: Session, root: string, rank: Rank | null): Promise<string[]> {
  const pinned: string[] = []; const named = await namedFiles(root, s.objective, s.knownFiles);
  for (const path of named) {
    let text: string; try { text = await boundedRead(await safePath(root, path)); } catch { continue; }
    if (text.includes('\u0000')) continue;
    const h = hash(text);
    if (s.referenceEvidence.some(e => e.path === path && e.hash === h)) continue;
    const lines = text.split('\n'); const chunks: { start: number; text: string }[] = [];
    for (let start = 0; start < lines.length && chunks.length < maxChunks; start += chunkStep) {
      chunks.push({ start: start + 1, text: lines.slice(start, start + chunkLines).map((l, i) => `${start + i + 1}: ${l}`).join('\n').slice(0, 2400) });
      if (start + chunkLines >= lines.length) break;
    }
    let ranks: (number | undefined)[] = chunks.map(() => undefined);
    const share = Math.floor(storeBytes / named.length);
    if (rank && chunks.reduce((n, c) => n + Buffer.byteLength(c.text), 0) > share) {
      ranks = [];
      for (let i = 0; i < chunks.length; i += 24) {
        const batch = chunks.slice(i, i + 24).map(c => c.text);
        const scores = await rank(`the parts of ${path} that the objective asks for`, batch).catch(() => batch.map(() => undefined));
        ranks.push(...scores);
      }
    }
    const fresh = chunks.map((c, i) => ({ path, hash: h, text: c.text, start: c.start, ...(ranks[i] !== undefined ? { rank: ranks[i] } : {}) }))
      .sort((a, b) => (b.rank ?? 1) - (a.rank ?? 1) || a.start - b.start);
    let bytes = 0; const kept = fresh.filter(e => (bytes += Buffer.byteLength(e.text)) <= share || e === fresh[0]);
    s.referenceEvidence = [...s.referenceEvidence.filter(e => e.path !== path), ...kept];
    pinned.push(path);
  }
  return pinned;
}

// The best-ranked current chunks within a budget, in document order.
export function referenceContext(s: Session, budget = 6000): Session['referenceEvidence'] {
  const current = s.referenceEvidence.filter(e => !s.hashes[e.path] || s.hashes[e.path] === e.hash);
  const out: Session['referenceEvidence'] = [];
  for (const e of [...current].sort((a, b) => (b.rank ?? 1) - (a.rank ?? 1) || (a.start ?? 0) - (b.start ?? 0))) {
    const size = Buffer.byteLength(JSON.stringify(e));
    if (size > budget) continue;
    out.push(e); budget -= size;
  }
  return out.sort((a, b) => a.path.localeCompare(b.path) || (a.start ?? 0) - (b.start ?? 0));
}
