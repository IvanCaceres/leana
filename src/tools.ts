import { createHash, randomUUID } from 'node:crypto';
import { open, readFile, realpath, rename, stat, unlink, mkdir, readdir } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import type { CheckSummary, Config, NameOrigin, Route, ToolResult } from './types.js';
import { clip } from './context.js';
export const hash = (text: string | Buffer): string => createHash('sha256').update(text).digest('hex');
// A write whose target was never read, or was read before it changed. Only this
// failure class requires a fresh read; other edit failures are argument mistakes.
export class StaleWriteError extends Error {}
// Did a check get worse after edits? Any in-scope increase, or new in-scope syntax
// errors without a net decrease, is a regression and is rolled back with no vote;
// a structural move is judged on syntax only. Anything else is committed.
export function regression(before: CheckSummary | null, after: CheckSummary, scope: { files?: string[]; structural?: boolean } = {}): 'worse' | 'fine' {
  if (!before) return 'fine';
  // Judge the files this transaction touched, not the whole repository: errors
  // cascading into test files must not blunt the signal, and pre-existing errors
  // elsewhere are not this edit's doing. Errors the check does not attribute to a
  // file (test failures, project-level errors) always count: they cannot be
  // anyone else's, and they cancel out when unchanged.
  const files = scope.files ?? [];
  const matches = (f: string) => files.some(p => f === p || f.endsWith(`/${p}`) || p.endsWith(`/${f}`));
  const attributed = files.length > 0 && [before, after].some(s => Object.keys(s.byFile).some(k => k !== '(other)' && matches(k)));
  const inScope = (s: CheckSummary) => {
    if (!attributed) return { errors: s.errors, syntax: s.syntax };
    let errors = 0; let syntax = 0;
    for (const [f, v] of Object.entries(s.byFile)) if (f === '(other)' || matches(f)) { errors += v.count; syntax += v.syntax; }
    return { errors, syntax };
  };
  const b = inScope(before); const a = inScope(after);
  // New syntax errors with no net progress are a regression. New syntax errors
  // alongside a net decrease are progress with one known line to fix: keep them.
  if (a.syntax > b.syntax && a.errors >= b.errors) return 'worse';
  // A structural move legitimately raises the count until its follow-ups land.
  if (!scope.structural && a.errors > b.errors) return 'worse';
  return 'fine';
}
// An edit that pastes lines the file already contains (a header copied again,
// a block duplicated) is refused: the recurring way a small model breaks a file.
export function assertNoBulkDuplication(before: string, inserted: string[], label: string, countRule = true): void {
  const trimmed = (xs: string[]) => xs.map(l => l.trim());
  const beforeLines = trimmed(before.split('\n'));
  const present = new Set(beforeLines);
  const dupImport = trimmed(inserted).find(l => /^(import|export)\b.*\bfrom\b/.test(l) && present.has(l));
  if (dupImport) throw new Error(`Edit refused: ${label} already contains the line ${JSON.stringify(dupImport.slice(0, 80))}; an import or export is never added twice. Add only the names that are missing.`);
  if (!countRule) return;
  // A run of five consecutive substantive inserted lines that already appears
  // consecutively in the file is a pasted block, not a shared idiom.
  // (five closing braces are not a paste: every line must carry some text and the run some substance)
  const substantive = (w: string[]) => w.every(l => l.length >= 4) && w.join('').length >= 60;
  const windows = new Set<string>();
  for (let i = 0; i + 5 <= beforeLines.length; i++) { const w = beforeLines.slice(i, i + 5); if (substantive(w)) windows.add(w.join('\n')); }
  const ins = trimmed(inserted);
  for (let i = 0; i + 5 <= ins.length; i++) {
    const w = ins.slice(i, i + 5);
    if (substantive(w) && windows.has(w.join('\n'))) throw new Error(`Edit refused: it would insert a block that ${label} already contains (starting ${JSON.stringify(w[0]!.slice(0, 60))}). The file already has these lines; add only what is missing.`);
  }
}
// The 1-based line at which a new import belongs: after the last import
// declaration according to the TypeScript parser (never an import-shaped line
// inside a string), else after a leading shebang or directive prologue.
export async function importInsertLine(path: string, text: string): Promise<number> {
  const lines = text.split('\n');
  if (tsModule === undefined) { try { const m: any = await import('typescript'); tsModule = m.default ?? m; } catch { tsModule = null; } }
  if (tsModule && parseable.test(path)) {
    const ts = tsModule;
    const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
    let after = -1;
    for (const st of sf.statements) {
      if (st.kind === ts.SyntaxKind.ImportDeclaration || st.kind === ts.SyntaxKind.ImportEqualsDeclaration) after = sf.getLineAndCharacterOfPosition(st.getEnd()).line;
      else if (after < 0 && st.kind === ts.SyntaxKind.ExpressionStatement && st.expression?.kind === ts.SyntaxKind.StringLiteral) after = sf.getLineAndCharacterOfPosition(st.getEnd()).line; // 'use strict'
    }
    if (after >= 0) return after + 2;
    return lines[0]?.startsWith('#!') ? 2 : 1;
  }
  let last = -1;
  for (let i = 0; i < lines.length; i++) if (/^import\b.*\bfrom\s+["'][^"']+["'];?\s*$/.test(lines[i]!) || /^import\s+["'][^"']+["'];?\s*$/.test(lines[i]!) || /^\}\s*from\s+["'][^"']+["'];?\s*$/.test(lines[i]!)) last = i;
  return last >= 0 ? last + 2 : lines[0]?.startsWith('#!') ? 2 : 1;
}
// A compact, comparable view of a check's output: error counts overall and per
// file, with the lines they name. Syntax errors are singled out because a file
// that fails to parse is not semantically checked, so a broken edit can make the
// total drop while the code is worse.
export function summarizeCheck(text: string): CheckSummary {
  let output = text;
  try { const parsed = JSON.parse(text); if (typeof parsed?.output === 'string') output = parsed.output; } catch { /* plain text */ }
  const byFile: CheckSummary['byFile'] = {}; let errors = 0; let syntax = 0;
  for (const raw of output.split('\n')) {
    const line = raw.trim();
    // Test runners report failures without the word error: TAP 'not ok', Jest 'FAIL',
    // Node's AssertionError. Summary lines ('# fail 1') are not failures.
    if (!/\berror\b/i.test(line) && !/\bAssertionError\b|\bSyntaxError\b|\bFAIL(?:ED)?\b|^not ok\b/.test(line)) continue;
    errors++;
    const isSyntax = /\bTS1\d{3}\b|SyntaxError|Unexpected token|[a-z')\]}] expected\.$/.test(line);
    if (isSyntax) syntax++;
    const m = line.match(/^([\w@./\\-]+\.\w+)(?:\((\d+)|:(\d+))?/);
    const file = m?.[1] ?? '(other)'; const at = Number(m?.[2] ?? m?.[3] ?? 0);
    const f = byFile[file] ??= { count: 0, syntax: 0, lines: [], samples: [] };
    f.count++; if (isSyntax) f.syntax++;
    if (at && f.lines.length < 12 && !f.lines.includes(at)) f.lines.push(at);
    if (f.samples.length < 3) f.samples.push(clip(line, 140));
  }
  return { errors, syntax, byFile: Object.fromEntries(Object.entries(byFile).sort((a, b) => b[1].count - a[1].count)) };
}
// Bracket balance of code, ignoring string literals and comments so an ANSI
// escape such as "\u001B[?25l" or a "{" in a comment does not skew the count.
// An edit that leaves a file with more unmatched brackets than before has cut
// through a declaration or statement; refuse it before it lands on disk.
// An edit that leaves a TypeScript or JavaScript file unparseable is refused
// with the parser's own message: cheaper than a lint, a rollback and a rejected
// edit, and it names the exact line. Uses the harness's TypeScript when present.
const parseable = /\.(?:[cm]?[jt]sx?)$/i;
let tsModule: any | null | undefined;
export async function syntaxErrors(path: string, text: string): Promise<string[]> {
  if (!parseable.test(path)) return [];
  if (tsModule === undefined) { try { const m: any = await import('typescript'); tsModule = m.default ?? m; } catch { tsModule = null; } }
  if (!tsModule) return [];
  const ts = tsModule;
  const out = ts.transpileModule(text, { reportDiagnostics: true, fileName: path, compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.Preserve, allowJs: true } });
  return (out.diagnostics ?? []).slice(0, 5).map((d: any) => {
    const where = d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start) : null;
    return `${where ? `line ${where.line + 1}: ` : ''}${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`;
  });
}
export async function assertParses(path: string, before: string, after: string): Promise<void> {
  const problems = await syntaxErrors(path, after);
  if (!problems.length) return;
  const had = await syntaxErrors(path, before);
  if (had.length && had.length >= problems.length) return; // already broken; do not block repairs
  throw new Error(`Edit refused: ${path} would no longer parse (${problems.join('; ')}). Re-read the lines around the error and cover whole statements; a missing import is added at the top of the file, never by overwriting the line that uses the name.`);
}
export function assertBalancePreserved(before: string, after: string, label: string): void {
  const count = (text: string, ch: string): number => text.split(ch).length - 1;
  const b = stripLiterals(before); const a = stripLiterals(after);
  const worse = ([open, close]: readonly [string, string]) => {
    const was = count(b, open) - count(b, close); const now = count(a, open) - count(a, close);
    return Math.abs(now) > Math.abs(was) ? `${Math.abs(now)} unmatched '${now > 0 ? open : close}' (was ${Math.abs(was)})` : null;
  };
  const problems = ([['{', '}'], ['(', ')'], ['[', ']']] as const).map(worse).filter(Boolean);
  if (problems.length) throw new Error(`Edit refused: it would leave ${label} with ${problems.join(', ')}. The range cuts through a declaration or statement; cover whole statements or blocks.`);
}
export function stripLiterals(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|`(?:\\[\s\S]|[^`\\])*`|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/g, m => m.replace(/[^\n]/g, ' '));
}
export async function listRepoFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(dir: string, prefix = ''): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (['.git', '.leana', 'node_modules'].includes(entry.name) || /^\.env(?:\.|$)/.test(entry.name)) continue;
      const rel = prefix + entry.name;
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) await visit(path, `${rel}/`);
      else if (entry.isFile() && !/\.(?:pem|key)$/i.test(entry.name)) files.push(rel);
    }
  }
  await visit(root);
  return files.sort();
}
export const within = (root: string, path: string): boolean => {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};
function blocked(path: string): boolean {
  return path.split(/[\\/]/).some(part => ['.git', '.leana', 'node_modules'].includes(part) || /^\.env(?:\.|$)/.test(part)
    || /^(?:id_rsa|id_ed25519)$/.test(part) || /\.(?:pem|key)$/i.test(part));
}
export async function safePath(root: string, name: string, create = false): Promise<string> {
  if (!name || name.includes('\0') || isAbsolute(name) || blocked(name)) throw new Error('Path is excluded or must be repository-relative');
  const target = resolve(root, name);
  if (!within(root, target)) throw new Error('Path escapes repository');
  let current = target;
  while (true) {
    try {
      const canonical = await realpath(current);
      if (!within(root, canonical) || blocked(relative(root, canonical))) throw new Error('Symlink escapes repository or targets excluded path');
      if (current === target) return canonical;
      return target;
    } catch (e: any) {
      if (e.code !== 'ENOENT' || !create || current === root) throw e;
      current = dirname(current);
    }
  }
}
export async function runCommand(command: string, args: string[], cwd: string, timeout: number, limit = 1024 * 1024): Promise<{ output: string; code: number | null; truncated: boolean; timedOut: boolean }> {
  return new Promise((resolveResult, reject) => {
    const env: NodeJS.ProcessEnv = {};
    for (const key of ['PATH', 'HOME', 'USER', 'LANG', 'LC_ALL', 'TMPDIR', 'TERM'])
      if (process.env[key]) env[key] = process.env[key];
    const child = spawn(command, args, { cwd, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = []; let size = 0; let truncated = false; let timedOut = false;
    const kill = () => {
      if (!child.pid) return;
      try { if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { /* already exited */ }
    };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeout);
    const collect = (data: Buffer) => {
      const room = Math.max(0, limit - size);
      if (room) { const part = data.subarray(0, room); chunks.push(part); size += part.length; }
      if (data.length > room) { truncated = true; kill(); }
    };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    child.on('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(e.code === 'ENOENT' && command === 'rg'
        ? new Error('ripgrep (rg) was not found in PATH. Install ripgrep, confirm rg --version works in this terminal, then retry.')
        : e);
    });
    child.on('close', code => {
      clearTimeout(timer); kill();
      resolveResult({ output: Buffer.concat(chunks).toString('utf8'), code, truncated, timedOut });
    });
  });
}
async function boundedRead(path: string, limit = 1024 * 1024): Promise<string> {
  const handle = await open(path, 'r');
  try {
    if (!(await handle.stat()).isFile()) throw new Error('Only regular files may be read');
    const buffer = Buffer.alloc(limit + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > limit) throw new Error('File exceeds read byte limit; narrow with search or split it externally');
    if (buffer.subarray(0, bytesRead).includes(0)) throw new Error('Binary file excluded');
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead));
  } finally { await handle.close(); }
}
// Where does a name that a file cannot find come from? Deterministic answer
// from the repository: an import of it in the other edited files (the block was
// moved from one of them), or a declaration anywhere. Saves a small model from
// searching one name per step.
export function missingNamesFrom(summary: CheckSummary): { file: string; name: string }[] {
  const out: { file: string; name: string }[] = [];
  for (const [file, f] of Object.entries(summary.byFile)) for (const sample of f.samples.concat()) {
    const m = sample.match(/Cannot find name '([^']+)'/); if (m) out.push({ file, name: m[1]! });
  }
  return out;
}
export async function resolveMissingNames(root: string, checkOutput: string, editedFiles: string[], limit = 40): Promise<NameOrigin[]> {
  // name -> { file it is missing in, kind, module named by the error (if any) }
  const wanted = new Map<string, Map<string, { kind: 'missing' | 'not-exported' | 'wrong-module'; module?: string }>>();
  const add = (file: string, name: string, kind: 'missing' | 'not-exported' | 'wrong-module', module?: string) => {
    if (!wanted.has(file)) wanted.set(file, new Map()); if (!wanted.get(file)!.has(name)) wanted.get(file)!.set(name, { kind, module });
  };
  for (const m of checkOutput.matchAll(/^(\S+?)\(\d+,\d+\): error TS(?:2304|2552): Cannot find name '([^']+)'/gm)) add(m[1]!, m[2]!, 'missing');
  for (const m of checkOutput.matchAll(/^(\S+?)\(\d+,\d+\): error TS2459: Module '"([^"]+)"' declares '([^']+)' locally, but it is not exported/gm)) add(m[1]!, m[3]!, 'not-exported', m[2]!);
  for (const m of checkOutput.matchAll(/^(\S+?)\(\d+,\d+\): error TS(?:2305|2724): (?:Module )?'"([^"]+)"' has no exported member(?: named)? '([^']+)'/gm)) add(m[1]!, m[3]!, 'wrong-module', m[2]!);
  const results: NameOrigin[] = [];
  const headers = new Map<string, string>();
  const header = async (rel: string): Promise<string> => {
    if (!headers.has(rel)) { try { headers.set(rel, (await boundedRead(await safePath(root, rel))).split('\n').slice(0, 400).join('\n')); } catch { headers.set(rel, ''); } }
    return headers.get(rel)!;
  };
  const relPath = (from: string, to: string) => { const r = relative(dirname(from), to).replace(/\\/g, '/'); return r.startsWith('.') ? r : `./${r}`; };
  const declare = async (name: string, only?: string): Promise<{ file: string; line: string; exported: boolean; typeLike: boolean } | null> => {
    const r = await runCommand('rg', ['-n', '-H', '--no-heading', '--color', 'never', '--max-count', '3', '-g', '!node_modules/**', '-g', '!.leana/**', '-g', '!dist/**', '-e', `^(export )?(declare )?(type|interface|const|let|function|async function|class|enum) ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, '--', only ?? '.'], root, 10000).catch(() => null);
    const hit = r?.output.split('\n').find(Boolean); const m = hit?.match(/^(.*?):(\d+):(.*)$/);
    return m ? { file: m[1]!.replace(/^\.\//, ''), line: m[2]!, exported: /^export /.test(m[3]!), typeLike: /^(export )?(declare )?(type|interface)\b/.test(m[3]!) } : null;
  };
  for (const [reported, names] of wanted) {
    // The check prints paths relative to the package it ran in; match them to repository paths.
    const inFile = editedFiles.find(f => f.endsWith(reported) || reported.endsWith(f)) ?? reported;
    for (const [name, want] of [...names].slice(0, limit - results.length)) {
      const origin: NameOrigin = { name, inFile };
      if (want.kind === 'not-exported' && want.module) {
        // The import is right; the declaration in that module lacks an export.
        const target = relative(root, resolve(dirname(resolve(root, inFile)), want.module)).replace(/\.js$/, '.ts');
        const d = await declare(name, target);
        origin.declaredIn = d ? `${d.file}:${d.line}` : target; origin.exported = false;
        origin.note = `already imported from ${want.module}; add the export keyword to the declaration at ${origin.declaredIn}: replace_lines edit { start: ${d?.line ?? '?'}, end: ${d?.line ?? '?'}, newText: "", prepend: "export " } on ${d?.file ?? target}`;
        results.push(origin); continue;
      }
      if (want.kind === 'wrong-module') {
        const d = await declare(name);
        if (d) {
          origin.declaredIn = `${d.file}:${d.line}`; origin.exported = d.exported;
          origin.importLine = `import ${d.typeLike ? 'type ' : ''}{ ${name} } from "${relPath(inFile, d.file).replace(/\.ts$/, '.js')}";`;
          origin.note = `${want.module} does not export it; replace that import with this one${d.exported ? '' : ` and add export to the declaration at ${origin.declaredIn}`}`;
        } else origin.note = `${want.module} does not export ${name} and no declaration was found in the repository`;
        results.push(origin); continue;
      }
      for (const other of editedFiles.filter(f => f !== inFile)) {
        const text = await header(other);
        const imp = text.match(new RegExp(`import\\s+(type\\s+)?\\{[^}]*?\\b(type\\s+)?${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b(?!\\s+as\\b)[^}]*\\}\\s*from\\s+["']([^"']+)["']`, 's'));
        if (imp) {
          const spec = imp[3]!; const typeOnly = Boolean(imp[1] || imp[2]);
          const module = spec.startsWith('.') ? relPath(inFile, resolve(dirname(other), spec).replace(`${resolve(root)}/`, '')) : spec;
          origin.importedBy = other; origin.importLine = `import ${typeOnly ? 'type ' : ''}{ ${name} } from "${module}";`;
          break;
        }
      }
      if (!origin.importLine) {
        const d = await declare(name);
        if (d) {
          origin.declaredIn = `${d.file}:${d.line}`; origin.exported = d.exported;
          origin.importLine = `import ${d.typeLike ? 'type ' : ''}{ ${name} } from "${relPath(inFile, d.file).replace(/\.ts$/, '.js')}";`;
          if (!d.exported) origin.note = `not exported yet: add export to the declaration at ${origin.declaredIn}: replace_lines edit { start: ${d.line}, end: ${d.line}, newText: "", prepend: "export " } on ${d.file}`;
        }
      }
      if (!origin.importLine) origin.note = 'no import or declaration found in the repository; the name may be a builtin or a typo';
      results.push(origin);
      if (results.length >= limit) return results;
    }
  }
  return results;
}
export class ToolBox {
  constructor(readonly root: string, readonly artifacts: string, readonly config: Config,
    readonly snapshot: (path: string, text: string) => Promise<string> = async () => '') {}
  async execute(route: Route, a: Record<string, any>): Promise<ToolResult> {
    if (route === 'read_files') {
      const results: string[] = [];
      const hashes: Record<string, string> = {};
      // Cut at line boundaries inside the evidence budget. A mid-text clip would
      // hand Bonsai a truncated excerpt that it then pastes back as oldText.
      const share = Math.floor(this.config.toolChars / a.files.length);
      for (const f of a.files) {
        if (/[?*\[\]]/.test(f.path)) throw new Error(`read_files requires exact regular file paths; glob rejected: ${f.path}`);
        if (f.end < f.start) throw new Error(`Read ranges must contain 1..250 lines: end must be between start and start+249 (got ${f.start}..${f.end})`);
        if (f.end - f.start >= 250) f.end = f.start + 249; // clamp rather than fail: the budget cuts it anyway
        const artifact = f.path.startsWith('@artifact/');
        const path = artifact ? await safePath(this.artifacts, f.path.slice(10)) : await safePath(this.root, f.path);
        const text = await boundedRead(path, artifact ? 8 * 1024 * 1024 : 1024 * 1024);
        const lines = text.split('\n');
        if (!artifact) hashes[f.path] = hash(text);
        const end = Math.min(f.end, lines.length);
        // Reserve room for the header line and the continuation marker.
        const budget = Math.max(400, share - f.path.length - 240);
        const body: string[] = []; let size = 0; let shown = f.start - 1;
        for (let n = f.start; n <= end; n++) {
          const line = `${n}: ${lines[n - 1]}`;
          if (body.length && size + line.length + 1 > budget) break;
          body.push(clip(line, budget)); size += line.length + 1; shown = n;
          if (line.length > budget) break;
        }
        const cut = shown < end ? `\n[…truncated at the read budget after line ${shown}; request lines ${shown + 1}..${end} in a later read_files call or narrow the range…]` : '';
        results.push(`${f.path} sha256=${hash(text)} totalLines=${lines.length} shown=${f.start}..${shown}\n${body.join('\n') || '(no lines in range)'}${cut}`);
      }
      return { ok: true, text: results.join('\n\n'), hashes };
    }
    if (route === 'search_codebase') {
      const searchRoot = a.path === '@artifacts' ? this.artifacts : this.root;
      const path = await safePath(searchRoot, a.path === '@artifacts' ? '.' : a.path);
      const exclusions = ['!.git/**', '!.leana/**', '!node_modules/**', '!.env', '!.env.*', '!*.pem', '!*.key', '!id_rsa', '!id_ed25519'];
      const args = a.mode === 'files' ? ['--files'] : ['-n', '--no-heading', '--color', 'never', '-F', '--max-count', '50'];
      args.push('--max-filesize', '1M', ...exclusions.flatMap(g => ['--glob', g]));
      if (a.mode === 'text') args.push('-e', a.query);
      args.push('--', relative(searchRoot, path) || '.');
      const r = await runCommand('rg', args, searchRoot, 10000);
      const output = a.mode === 'files' ? r.output.split('\n').filter(p => p.includes(a.query)).slice(0, 200).join('\n') : r.output;
      const none = a.path === '.' || a.path === '@artifacts' ? '(no matches in the repository)' : `(no matches under ${a.path}; the text may live in another file, search path "." to check the whole repository)`;
      return { ok: !r.timedOut && !r.truncated && (r.code === 0 || r.code === 1),
        text: JSON.stringify({ ...r, output: output || none }) };
    }
    if (route === 'write') {
      if (!this.config.allowWrite) throw new Error('Writes disabled; restart with --allow-write');
      if (/[\\/]$/.test(a.path) || a.path === '.' || a.path === '..') throw new Error('write requires a regular file path; directory path rejected');
      const path = await safePath(this.root, a.path, true);
      const snapshots: Record<string, string> = {};
      let original: string | null = null;
      try { original = await boundedRead(path); } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
      if (original === null) {
        if (a.expectedHash !== 'new' || a.oldText !== '') throw new Error('New files require expectedHash=new and empty oldText');
        await mkdir(dirname(path), { recursive: true });
        await safePath(this.root, a.path, true);
        const handle = await open(path, 'wx', 0o644);
        try { await handle.writeFile(a.newText); } finally { await handle.close(); }
        snapshots[a.path] = '@new';
      } else {
        if (a.expectedHash === 'new') throw new StaleWriteError(`expectedHash=new is only valid for a new file; ${a.path} exists: read it with read_files and use the returned sha256`);
        if (hash(original) !== a.expectedHash) throw new StaleWriteError(`Stale file hash for ${a.path}: read the file again and use the sha256 from that result`);
        snapshots[a.path] = await this.snapshot(a.path, original);
        const matches = a.oldText ? original.split(a.oldText).length - 1 : 0;
        if (matches === 0) throw new Error('oldText must match exactly once: it was not found in the current file. Copy a small anchor exactly from the latest read_files result of this path; never paste a truncated excerpt');
        if (matches > 1) throw new Error(`oldText must match exactly once: it matches ${matches} times. Include more surrounding lines so the anchor is unique`);
        const updated = original.replace(a.oldText, () => a.newText);
        if (updated === original) throw new Error('Write produced no change: newText equals oldText. oldText is the exact existing anchor; newText must be the modified text that replaces it');
        assertBalancePreserved(original, updated, a.path);
        await assertParses(a.path, original, updated);
        assertNoBulkDuplication(original, a.newText.split('\n'), a.path);
        const temp = `${path}.leana-${randomUUID()}.tmp`;
        try {
          const h = await open(temp, 'wx', (await stat(path)).mode & 0o777);
          try { await h.writeFile(updated); } finally { await h.close(); }
          if (hash(await boundedRead(path)) !== a.expectedHash) throw new StaleWriteError('File changed while preparing edit; read it again');
          await rename(temp, path);
        } finally { await unlink(temp).catch(() => {}); }
      }
      const updatedHash = hash(await boundedRead(path));
      return { ok: true, changed: [a.path], hashes: { [a.path]: updatedHash }, snapshots, text: `Updated ${a.path}; sha256=${updatedHash}. Run focused validation.` };
    }
    if (route === 'replace_lines') {
      if (!this.config.allowWrite) throw new Error('Writes disabled; restart with --allow-write');
      const path = await safePath(this.root, a.path);
      const original = await boundedRead(path);
      if (hash(original) !== a.expectedHash) throw new StaleWriteError(`Stale file hash for ${a.path}: read the file again and use the sha256 from that result`);
      const snapshots = { [a.path]: await this.snapshot(a.path, original) };
      const lines = original.split('\n');
      // All ranges refer to the file as read; apply from the bottom up so no
      // edit shifts the line numbers of another. Overlaps are rejected.
      // prepend: prefix every line in the range with the text, keeping the lines
      // themselves; the model supplies numbers and a prefix, never retyped code.
      // A file ending in a newline splits into a trailing empty element; appending
      // at totalLines + 1 must land before it so the file keeps its final newline.
      const trailing = lines.length > 1 && lines.at(-1) === '';
      const all = [...a.edits as { start: number; end: number; newText: string; prepend?: string }[]]
        .map(e => trailing && e.end === e.start - 1 && e.start === lines.length + 1 ? { ...e, start: lines.length, end: lines.length - 1 } : e)
        .sort((x, y) => y.start - x.start);
      for (const [i, e] of all.entries()) {
        // end = start - 1 is an insertion before start (start = totalLines + 1 appends).
        const insert = e.end === e.start - 1;
        if (!insert && (e.end < e.start || e.end - e.start >= 2000)) throw new Error(`Range ${e.start}..${e.end} must contain 1..2000 lines, or end = start - 1 to insert before start`);
        if (insert && e.prepend) throw new Error(`Range ${e.start}..${e.end} is an insertion; prepend applies to existing lines only`);
        if (insert && !e.newText) throw new Error(`Range ${e.start}..${e.end} is an insertion and needs newText`);
        if ((insert ? e.start - 1 : e.end) > lines.length) throw new Error(`Range ${e.start}..${e.end} exceeds ${a.path} (${lines.length} lines)`);
        const next = all[i + 1];
        if (next && Math.max(next.end, next.start - 1) >= e.start && !(insert && next.end < e.start)) throw new Error(`Ranges ${next.start}..${next.end} and ${e.start}..${e.end} overlap; merge them into one edit`);
        if (e.prepend) for (let n = e.start; n <= e.end; n++) {
          const line = lines[n - 1] ?? '';
          if (/^\s*$/.test(line)) throw new Error(`Line ${n} is blank; prepend "${e.prepend}" belongs on the declaration line`);
          if (/^\s*(import|export)\b/.test(line) && /^\s*export\s*$/.test(e.prepend)) throw new Error(`Line ${n} already starts with ${line.trim().split(/\s+/)[0]} (${JSON.stringify(line.trim().slice(0, 60))}); export is prepended only to a declaration line`);
        }
      }
      // An edit that leaves its lines as they are is skipped, not fatal: in a
      // batch of forty deletions one redundant rewrite must not void the rest.
      const rendered = (e: { start: number; end: number; newText: string; prepend?: string }): string[] =>
        e.prepend ? lines.slice(e.start - 1, e.end).map(l => `${e.prepend}${l}`) : e.newText === '' ? [] : e.newText.replace(/\n$/, '').split('\n');
      const same = (x: string[], y: string[]) => x.length === y.length && x.every((l, i) => l === y[i]);
      // A deletion is never a no-op; a rewrite is one only when every line is unchanged.
      const skipped = all.filter(e => e.end >= e.start && !(e.newText === '' && !e.prepend) && same(lines.slice(e.start - 1, e.end), rendered(e)));
      const edits = all.filter(e => !skipped.includes(e));
      if (!edits.length) throw new Error(`replace_lines produced no change: every newText equals the current lines (${all.map(e => `${e.start}..${e.end}`).join(', ')})`);
      let result = lines; let delta = 0;
      for (const e of edits) {
        const fresh = rendered(e);
        const removed = Math.max(0, e.end - e.start + 1);
        result = [...result.slice(0, e.start - 1), ...fresh, ...result.slice(e.start - 1 + removed)];
        delta += fresh.length - removed;
      }
      const updated = result.join('\n');
      assertBalancePreserved(original, updated, a.path);
      await assertParses(a.path, original, updated);
      assertNoBulkDuplication(original, edits.filter(e => !e.prepend).flatMap(e => rendered(e)), a.path);
      const temp = `${path}.leana-${randomUUID()}.tmp`;
      try {
        const h = await open(temp, 'wx', (await stat(path)).mode & 0o777);
        try { await h.writeFile(updated); } finally { await h.close(); }
        if (hash(await boundedRead(path)) !== a.expectedHash) throw new StaleWriteError('File changed while preparing edit; read it again');
        await rename(temp, path);
      } finally { await unlink(temp).catch(() => {}); }
      const summary = edits.map(e => `${e.start}..${e.end}`).reverse().join(', ');
      const note = skipped.length ? ` Skipped ${skipped.length} unchanged range(s): ${skipped.map(e => `${e.start}..${e.end}`).reverse().join(', ')}.` : '';
      return { ok: true, changed: [a.path], hashes: { [a.path]: hash(updated) }, snapshots,
        text: `Replaced ${edits.length} range(s) ${summary} of ${a.path}; sha256=${hash(updated)} totalLines=${updated.split('\n').length}.${note} Line numbers below the first edit shifted by ${delta} in total; re-read before addressing them. Run focused validation.` };
    }
    if (route === 'move_lines') {
      if (!this.config.allowWrite) throw new Error('Writes disabled; restart with --allow-write');
      if (a.source === a.destination) throw new Error('source and destination must differ');
      if (a.end < a.start || a.end - a.start >= 2000) throw new Error('move_lines ranges must contain 1..2000 lines');
      const sourcePath = await safePath(this.root, a.source);
      const destinationPath = await safePath(this.root, a.destination, true);
      if (/[\\/]$/.test(a.destination)) throw new Error('destination must be a regular file path');
      const original = await boundedRead(sourcePath);
      if (hash(original) !== a.expectedHash) throw new StaleWriteError(`Stale file hash for ${a.source}: read the file again and use the sha256 from that result`);
      const lines = original.split('\n');
      if (a.end > lines.length) throw new Error(`Range ${a.start}..${a.end} exceeds ${a.source} (${lines.length} lines)`);
      const snapshots = { [a.source]: await this.snapshot(a.source, original) };
      let existing: string | null = null;
      try { existing = await boundedRead(destinationPath); } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
      if (existing === null && a.destinationHash !== 'new') throw new StaleWriteError(`${a.destination} does not exist; use destinationHash=new to create it`);
      if (existing !== null && a.destinationHash === 'new') throw new StaleWriteError(`${a.destination} exists: read it and use its sha256 as destinationHash`);
      if (existing !== null && hash(existing) !== a.destinationHash) throw new StaleWriteError(`Stale file hash for ${a.destination}: read it again`);
      if (existing !== null) snapshots[a.destination] = await this.snapshot(a.destination, existing); else snapshots[a.destination] = '@new';
      const moved = lines.slice(a.start - 1, a.end).join('\n');
      // A range that cuts through a block leaves both files broken. Bracket
      // balance is a cheap proxy for a complete declaration in C-like syntax.
      const count = (text: string, ch: string): number => stripLiterals(text).split(ch).length - 1;
      const skew = ([open, close]: readonly [string, string]) => count(moved, open) - count(moved, close);
      const unbalanced = ([['{', '}'], ['(', ')'], ['[', ']']] as const).map(pair => [pair, skew(pair)] as const).filter(([, n]) => n !== 0);
      if (unbalanced.length) {
        const detail = unbalanced.map(([[open, close], n]) => n > 0 ? `${n} more '${open}' than '${close}'` : `${-n} more '${close}' than '${open}'`).join(', ');
        // The harness has the whole file: find where the range would balance.
        const balanced = (from: number, to: number) => ([['{', '}'], ['(', ')'], ['[', ']']] as const)
          .every(([open, close]) => { const t = lines.slice(from - 1, to).join('\n'); return count(t, open) === count(t, close); });
        let hint = unbalanced[0]![1] > 0 ? `The block probably ends after line ${a.end}; read from line ${a.end + 1} to find its closing line` : `The block probably starts before line ${a.start}`;
        if (unbalanced[0]![1] > 0) { for (let to = a.end + 1; to <= Math.min(lines.length, a.end + 3000); to++) if (balanced(a.start, to)) { hint = `The block starting at line ${a.start} closes at line ${to}: retry with end=${to}`; break; } }
        else { for (let from = a.start - 1; from >= Math.max(1, a.start - 3000); from--) if (balanced(from, a.end)) { hint = `The block ending at line ${a.end} opens at line ${from}: retry with start=${from}`; break; } }
        throw new Error(`Range ${a.start}..${a.end} of ${a.source} is not a complete block: ${detail}. ${hint}.`);
      }
      const remaining = [...lines.slice(0, a.start - 1), ...(a.replacement ? a.replacement.split('\n') : []), ...lines.slice(a.end)].join('\n');
      const output = existing === null ? `${a.prefix ? a.prefix.replace(/\n?$/, '\n') : ''}${moved}\n`
        : `${existing.replace(/\n?$/, '\n')}\n${moved}\n`;
      assertBalancePreserved(original, remaining, a.source);
      assertBalancePreserved(existing ?? '', output, a.destination);
      await assertParses(a.source, original, remaining);
      await assertParses(a.destination, existing ?? '', output);
      if (existing !== null) assertNoBulkDuplication(existing, `${a.prefix ?? ''}\n${moved}`.split('\n'), a.destination, false);
      await mkdir(dirname(destinationPath), { recursive: true });
      const temp = `${sourcePath}.leana-${randomUUID()}.tmp`;
      try {
        const h = await open(temp, 'wx', (await stat(sourcePath)).mode & 0o777);
        try { await h.writeFile(remaining); } finally { await h.close(); }
        const d = await open(destinationPath, existing === null ? 'wx' : 'w', 0o644);
        try { await d.writeFile(output); } finally { await d.close(); }
        if (hash(await boundedRead(sourcePath)) !== a.expectedHash) throw new StaleWriteError('File changed while preparing edit; read it again');
        await rename(temp, sourcePath);
      } finally { await unlink(temp).catch(() => {}); }
      return { ok: true, changed: [a.source, a.destination], hashes: { [a.source]: hash(remaining), [a.destination]: hash(output) }, snapshots,
        text: `Moved lines ${a.start}..${a.end} (${a.end - a.start + 1} lines) from ${a.source} to ${a.destination}. ` +
        `${a.source} sha256=${hash(remaining)} totalLines=${remaining.split('\n').length}; ${a.destination} sha256=${hash(output)} totalLines=${output.split('\n').length}. ` +
        (a.replacement ? 'Run the focused check next; its errors list any imports the moved code still needs in the destination.'
          : 'The source no longer imports the moved names; add that import with write, then run the focused check.') };
    }
    if (route === 'bash') {
      if (!this.config.allowBash) throw new Error('Shell disabled; restart with --allow-bash');
      // Preserve failures hidden by commands such as `pnpm test 2>&1 | tail`.
      // Without pipefail, the tail process masks the test runner's exit code.
      const r = await runCommand('bash', ['--noprofile', '--norc', '-o', 'pipefail', '-c', a.command], this.root, this.config.commandTimeoutMs);
      // With a configured check command, only that command is verification; the
      // regex is a fallback for sessions that did not declare one.
      const looksLikeCheck = this.config.checkCommand ? a.command.trim() === this.config.checkCommand.trim()
        : /(?:^|[\s:&|;])(?:npm|pnpm|yarn|bun|node|python|pytest|cargo|go|mvn|gradle|tsc|eslint|prettier|ruff)(?:\s|$)|\b(?:test|build|check|lint|typecheck|tsc)\b/i.test(a.command);
      return { ok: r.code === 0 && !r.truncated && !r.timedOut, check: looksLikeCheck && r.code === 0 && !r.truncated && !r.timedOut, verification: looksLikeCheck,
        text: JSON.stringify({ command: a.command, purpose: a.purpose, ...r }) };
    }
    throw new Error(`Not an executable filesystem tool: ${route}`);
  }
}
