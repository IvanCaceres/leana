// Calls a model wrote in a shape that can be read one way only, made into the calls it meant. Everything else
// is left as written, for the schema to refuse with its reason. A refusal costs a step, and four in a row end
// the attempt: run react-demo-7 (dots-3-note-preview, 2026-10-18) asked read_files for four and five files, and
// once for a bare path, and was refused four times in a row and stopped, its scaffold done and nothing read.
import { schemas } from './schema.js';

export interface Call {
  action: string;
  args: Record<string, any>;
  problem?: string;
}
// How many files one read_files call takes (its schema's maxItems): they share one character budget.
const perRead = schemas.read_files.properties!.files!.maxItems ?? 3;
const wholeFile = { start: 1, end: 1000000 };

// A read_files file named by its path alone (a string, or { path } without a range) is read from its start; a
// range missing one end is completed. Anything that is not a path is left for the schema to refuse.
function file(f: unknown): unknown {
  if (typeof f === 'string') return { path: f, ...wholeFile };
  if (!f || typeof f !== 'object' || typeof (f as any).path !== 'string') return f;
  const { path, start, end } = f as Record<string, unknown>;
  if (start !== undefined && end !== undefined) return f;
  return { path, start: start ?? wholeFile.start, end: end ?? wholeFile.end };
}

// The calls with each repair made, and one line per repair saying what was changed (logged, not shown).
export function repairCalls(calls: Call[]): { calls: Call[]; repairs: string[] } {
  const out: Call[] = [];
  const repairs: string[] = [];
  for (const c of calls) {
    if (c.action !== 'read_files' || c.problem) {
      out.push(c);
      continue;
    }
    let files: unknown = c.args.files;
    // { path } (or { path, start, end }) for { files: [ ... ] }; a list of paths given as paths.
    if (files === undefined && (typeof c.args.path === 'string' || Array.isArray(c.args.paths))) {
      files = typeof c.args.path === 'string' ? [c.args] : c.args.paths;
      repairs.push(`read_files named its file${typeof c.args.path === 'string' ? '' : 's'} outside files`);
    }
    if (!Array.isArray(files)) {
      out.push(c);
      continue;
    }
    const fixed = files.map(file);
    if (fixed.some((f, i) => JSON.stringify(f) !== JSON.stringify(files[i])))
      repairs.push('read_files named a file without its range, read from its start');
    // More files than one read takes: run as consecutive reads of the batch, in the order named.
    if (fixed.length > perRead)
      repairs.push(`read_files named ${fixed.length} files, read as ${Math.ceil(fixed.length / perRead)} reads`);
    for (let i = 0; i < Math.max(1, fixed.length); i += perRead)
      out.push({ action: 'read_files', args: { files: fixed.slice(i, i + perRead) } });
  }
  return { calls: out, repairs };
}
