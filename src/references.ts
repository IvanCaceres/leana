import type { Session } from './types.js';

// Preserve source excerpts, never model-written interpretations of the task.
// Rank short windows by literal objective terms, including numbered sections:
// a plan's title and table of contents alone do not explain a requested substep.
function terms(objective: string): string[] {
  const sections = objective.match(/\b(?:step|section|phase|part)\s+\d+(?:\.\d+)*\b/gi) ?? [];
  const words = objective.replace(/\S+\.(?:md|txt|rst)\b/gi, '').match(/[a-zA-Z_][\w-]{3,}/g) ?? [];
  return [...new Set([...sections, ...words.filter(w => !/^(read|perform|only|step|substep|section|phase|part|this|that|with|from|then|please)$/i.test(w))].map(w => w.toLowerCase()))];
}
function score(text: string, objective: string): number {
  const lower = text.toLowerCase();
  return terms(objective).reduce((n, term) => n + (new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(lower) ? (term.includes(' ') ? 20 : 1) : 0), 0);
}
// Every requested item: "step 1 substep 2", "step 1 substep 1 and substep 2",
// "step 1 substeps 1-3", "step 1 substep 1 and 2". One scope per item.
export function scopes(objective: string): { key: string; kind: string; section: string; item: string }[] {
  const out: { key: string; kind: string; section: string; item: string }[] = [];
  for (const m of objective.matchAll(/\b(step|section|phase|part)\s+(\d+(?:\.\d+)*)\s+(?:substeps?|items?)\s+(\d+(?:\s*(?:,|and|&|-|to|through)\s*(?:substeps?|items?)?\s*\d+)*)\b/gi)) {
    const [kind, section] = [m[1]!.toLowerCase(), m[2]!];
    const numbers = [...m[3]!.matchAll(/\d+/g)].map(x => Number(x[0]));
    const ranged = /-|\bto\b|\bthrough\b/i.test(m[3]!) && numbers.length === 2 && numbers[1]! > numbers[0]!
      ? Array.from({ length: numbers[1]! - numbers[0]! + 1 }, (_, i) => numbers[0]! + i) : numbers;
    for (const n of ranged) { const key = `${kind} ${section} substep ${n}`; if (!out.some(o => o.key === key)) out.push({ key, kind, section, item: String(n) }); }
  }
  return out;
}
export function rememberReferences(s: Session, result: string): void {
  const blocks = result.split(/\n\n(?=\S+ sha256=)/);
  for (const block of blocks) {
    const header = block.match(/^(\S+\.(?:md|txt|rst)) sha256=(\w+) totalLines=\d+ shown=\d+\.\.\d+\n/i);
    if (!header || !s.objective.includes(header[1]!)) continue;
    const [, path, hash] = header as [string, string, string];
    s.referenceEvidence = s.referenceEvidence.filter(e => e.path !== path || e.hash === hash);
    const lines = block.slice(header[0].length).split('\n');
    for (const requested of scopes(s.objective)) {
      const plain = (line: string) => line.replace(/^\d+:\s?/, '').replace(/^[#*\s]+/, '');
      const heading = new RegExp(`^${requested.kind}\\s+${requested.section.replace(/\./g, '\\.')}\\b`, 'i');
      const at = lines.findIndex(l => heading.test(plain(l)));
      if (at < 0) continue;
      const body = lines.slice(at + 1);
      const nextHeading = body.findIndex(l => /^(?:step|section|phase|part)\s+\d/i.test(plain(l)));
      const section = nextHeading < 0 ? body : body.slice(0, nextHeading);
      const item = section.findIndex(l => new RegExp(`^${requested.item}[.)]\\s`).test(plain(l)));
      if (item < 0) continue;
      const rest = section.slice(item + 1);
      const next = rest.findIndex(l => /^\d+[.)]\s/.test(plain(l)));
      const text = [lines[at], section[item], ...(next < 0 ? rest : rest.slice(0, next))].join('\n').slice(0, 2400);
      if (!s.referenceEvidence.some(e => e.path === path && e.text === text)) s.referenceEvidence.push({ path, hash, text, scope: requested.key });
    }
    // Overlapping windows retain headings and the following numbered items.
    for (let start = 0; start < lines.length; start += 12) {
      const text = lines.slice(start, start + 24).join('\n').slice(0, 2400);
      if (!s.referenceEvidence.some(e => e.path === path && e.text === text)) s.referenceEvidence.push({ path, hash, text });
    }
  }
  s.referenceEvidence.sort((a, b) => Number(Boolean(b.scope)) - Number(Boolean(a.scope)) || score(b.text, s.objective) - score(a.text, s.objective));
  let bytes = 0;
  s.referenceEvidence = s.referenceEvidence.filter(e => (bytes += Buffer.byteLength(JSON.stringify(e))) <= 12000);
}
export function referenceContext(s: Session, budget = 6000): Session['referenceEvidence'] {
  const out: Session['referenceEvidence'] = [];
  const requested = new Set(scopes(s.objective).map(r => r.key));
  const current = s.referenceEvidence.filter(e => !s.hashes[e.path] || s.hashes[e.path] === e.hash);
  const scoped = current.filter(e => e.scope && requested.has(e.scope));
  for (const e of scoped.length ? scoped : current) {
    // A changed document must be read again before its requirements are reused.
    if (s.hashes[e.path] && s.hashes[e.path] !== e.hash) continue;
    const size = Buffer.byteLength(JSON.stringify(e));
    if (size > budget) continue;
    out.push(e); budget -= size;
  }
  return out;
}
