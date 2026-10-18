// Calls a model wrote in a shape that can be read one way only, made into the calls it meant. Everything else
// is left as written, for the schema to refuse with its reason. A refusal costs a step, and four in a row end
// the attempt: run react-demo-7 (dots-3-note-preview, 2026-10-18) asked read_files for four and five files, and
// once for a bare path, and was refused four times in a row and stopped, its scaffold done and nothing read; run
// supermarket-1 (the same model) sent write with a whole file's content four times, refused each time for its
// missing oldText, and was paused as stuck.
import { schemas } from './schema.js';

export interface Call {
  action: string;
  args: Record<string, any>;
  problem?: string;
}
// How many files one read_files call takes (its schema's maxItems): they share one character budget.
const perRead = schemas.read_files.properties!.files!.maxItems ?? 3;
// A file's entry as read_files takes it: a path given alone is that path (its range defaults to the whole file).
const entry = (f: unknown): unknown => (typeof f === 'string' ? { path: f } : f);
const only = (o: Record<string, any>, keys: string[]) =>
  Object.fromEntries(keys.filter(k => o[k] !== undefined).map(k => [k, o[k]]));

// The calls with each repair made, and one line per repair saying what was changed (logged, not shown). exists
// says whether a repository path is a file now: a whole file's content goes to the action for one that exists or not.
export function repairCalls(
  calls: Call[],
  exists: (path: string) => boolean = () => true,
): { calls: Call[]; repairs: string[] } {
  const out: Call[] = [];
  const repairs: string[] = [];
  for (const c of calls) {
    if (c.problem) out.push(c);
    else if (c.action === 'read_files') out.push(...reads(c, repairs));
    else if (c.action === 'write') out.push(whole(c, repairs, exists));
    else out.push(c);
  }
  return { calls: out, repairs };
}

// read_files: { path } or { paths } for the files list they name, paths given as strings for their entries, and
// more files than one read takes as consecutive reads, in the order named.
function reads(c: Call, repairs: string[]): Call[] {
  let files: unknown = c.args.files;
  if (files === undefined && (typeof c.args.path === 'string' || Array.isArray(c.args.paths))) {
    files = typeof c.args.path === 'string' ? [only(c.args, ['path', 'start', 'end'])] : c.args.paths;
    repairs.push(`read_files named its file${typeof c.args.path === 'string' ? '' : 's'} outside files`);
  }
  if (!Array.isArray(files)) return [c];
  const named = files.map(entry);
  if (files.some(f => typeof f === 'string')) repairs.push('read_files named files by their paths alone');
  if (named.length > perRead)
    repairs.push(`read_files named ${named.length} files, read as ${Math.ceil(named.length / perRead)} reads`);
  const out: Call[] = [];
  for (let i = 0; i < Math.max(1, named.length); i += perRead)
    out.push({ action: 'read_files', args: { files: named.slice(i, i + perRead) } });
  return out;
}

// write with a whole file's content and no text to replace is that file's whole new content: rewrite_file for a
// file that exists, create_file for one that does not. A write that names any text to replace is left as written.
function whole(c: Call, repairs: string[], exists: (path: string) => boolean): Call {
  const { path, content } = c.args;
  if (typeof path !== 'string' || typeof content !== 'string' || 'oldText' in c.args || 'newText' in c.args) return c;
  if (Object.keys(c.args).some(k => !['path', 'content', 'expectedHash'].includes(k))) return c;
  const action = exists(path) ? 'rewrite_file' : 'create_file';
  repairs.push(`write carried ${path}'s whole content, written as ${action}`);
  return { action, args: { path, content } };
}
