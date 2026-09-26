import { createHash, randomUUID } from 'node:crypto';
import { open, readFile, realpath, rename, stat, unlink, mkdir, readdir } from 'node:fs/promises';
import { dirname, isAbsolute, posix, relative, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { builtinModules } from 'node:module';
import type { CheckSummary, Config, Route, SourceEvidence, ToolResult } from './types.js';
import { clip } from './context.js';
// The first 16 hex digits (64 bits) of SHA-256: enough to tell one version of a
// file from another in a session, and a quarter of the tokens every prompt pays for.
export const hash = (text: string | Buffer): string => createHash('sha256').update(text).digest('hex').slice(0, 16);
// A write whose target was never read, or was read before it changed. Only this
// failure class requires a fresh read; other edit failures are argument mistakes.
export class StaleWriteError extends Error {}
// An import or export line the file already has is dropped from an insertion:
// the intent (have that import) is already met, so the edit is repaired, not
// refused. Returns the lines to insert and the ones dropped.
export function dropDuplicateImports(before: string, inserted: string[]): { kept: string[]; dropped: string[] } {
  const norm = (l: string) => l.trim().replace(/'/g, '"').replace(/;$/, '').replace(/\s+/g, ' ');
  const present = new Set(before.split('\n').map(norm));
  const kept: string[] = []; const dropped: string[] = [];
  for (const line of inserted) { if (/^\s*(import|export)\b.*\bfrom\b/.test(line) && present.has(norm(line))) dropped.push(line); else kept.push(line); }
  return { kept, dropped };
}
// An edit that pastes a block the file already contains (a header copied
// again, a function duplicated) is wrong content, the recurring way a small
// model breaks a file: refused, so the worker generates something else.
export function assertNoBulkDuplication(before: string, inserted: string[], label: string, countRule = true): void {
  const trimmed = (xs: string[]) => xs.map(l => l.trim());
  const beforeLines = trimmed(before.split('\n'));
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
// A large range whose new text mostly equals the old is a retype. The lines
// that differ are the change the worker meant, so the edit is applied and the
// note names them; refusing it would only discard the generation.
export function nearRetype(oldLines: string[], newLines: string[], start: number): string | null {
  if (oldLines.length < 12 || newLines.length !== oldLines.length) return null;
  const differing = oldLines.map((l, i) => l.trim() === newLines[i]!.trim() ? -1 : start + i).filter(n => n >= 0);
  if (differing.length === 0 || differing.length > Math.max(2, Math.floor(oldLines.length * .2))) return null;
  return `this rewrote ${oldLines.length} lines of which only ${differing.length} changed (line${differing.length > 1 ? 's' : ''} ${differing.join(', ')}); next time edit only those lines, in ranges of their own`;
}
// The exported surface of a file as short signatures: what another file may
// import from it. Interfaces and type aliases are shown whole when short; a
// function, class or const shows its first line up to the body.
export async function exportedSignatures(path: string, text: string, limit = 14): Promise<string[]> {
  if (tsModule === undefined) { try { const m: any = await import('typescript'); tsModule = m.default ?? m; } catch { tsModule = null; } }
  if (!tsModule || !parseable.test(path)) return [];
  const ts = tsModule; const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const hasExport = (st: any) => (ts.canHaveModifiers(st) ? ts.getModifiers(st) ?? [] : []).some((m: any) => m.kind === ts.SyntaxKind.ExportKeyword);
  const isDefault = (st: any) => (ts.canHaveModifiers(st) ? ts.getModifiers(st) ?? [] : []).some((m: any) => m.kind === ts.SyntaxKind.DefaultKeyword);
  const upTo = (st: any, pos: number) => text.slice(st.getStart(sf), pos).replace(/\s+$/, '').replace(/\s+/g, ' ');
  for (const st of sf.statements) {
    if (out.length >= limit) break;
    if (ts.isExportAssignment(st)) { out.push(`export default ${clip(st.expression.getText(sf).split('\n')[0]!, 120)}`); continue; }
    if (ts.isExportDeclaration(st)) { out.push(clip(st.getText(sf).replace(/\s+/g, ' '), 160)); continue; }
    if (!hasExport(st)) continue;
    const full = st.getText(sf);
    if ((ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st) || ts.isEnumDeclaration(st)) && full.split('\n').length <= 24) { out.push(full); continue; }
    // A function or class shows its head up to the body; an arrow function up to its arrow.
    if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st))) { const body = ts.isFunctionDeclaration(st) ? st.body : null; const at = body ? body.getStart(sf) : ts.isClassDeclaration(st) ? full.indexOf('{') + st.getStart(sf) : st.getEnd(); out.push(clip(upTo(st, at), 200)); continue; }
    if (ts.isVariableStatement(st)) {
      const init = st.declarationList.declarations[0]?.initializer;
      if (init && ts.isArrowFunction(init)) { out.push(clip(upTo(st, init.equalsGreaterThanToken.getEnd()), 200)); continue; }
      if (init && ts.isFunctionExpression(init)) { out.push(clip(upTo(st, init.body.getStart(sf)), 200)); continue; }
    }
    out.push(clip(full.split('\n')[0]!.replace(/\s*\{\s*$/, ''), 160) + (isDefault(st) ? '' : ''));
  }
  return out;
}
// The relative imports of a file (a spec starting with . or /), with the local
// names each binds: 'default', '*', the named bindings, or none for a
// side-effect import such as a stylesheet.
export async function relativeImports(path: string, text: string, all = false): Promise<{ spec: string; names: string[]; typeOnly?: boolean }[]> {
  if (tsModule === undefined) { try { const m: any = await import('typescript'); tsModule = m.default ?? m; } catch { tsModule = null; } }
  if (!tsModule || !parseable.test(path)) return [];
  const ts = tsModule; const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const out: { spec: string; names: string[]; typeOnly?: boolean }[] = [];
  for (const st of sf.statements) {
    let spec: string | null = null; const names: string[] = []; let typeOnly = false;
    if (ts.isImportDeclaration(st)) {
      spec = st.moduleSpecifier.text; const c = st.importClause; typeOnly = Boolean(c?.isTypeOnly);
      if (c?.name) names.push('default');
      if (c?.namedBindings && ts.isNamespaceImport(c.namedBindings)) names.push('*');
      if (c?.namedBindings && ts.isNamedImports(c.namedBindings)) { const els = c.namedBindings.elements; for (const b of els) names.push(b.propertyName?.text ?? b.name.text); if (els.length && els.every((b: any) => b.isTypeOnly)) typeOnly = true; }
    } else if (ts.isExportDeclaration(st) && st.moduleSpecifier) {
      spec = st.moduleSpecifier.text; typeOnly = Boolean(st.isTypeOnly);
      for (const b of st.exportClause && ts.isNamedExports(st.exportClause) ? st.exportClause.elements : []) names.push(b.propertyName?.text ?? b.name.text);
    }
    if (spec && (all || /^\.\.?\//.test(spec))) out.push({ spec, names, ...(typeOnly ? { typeOnly: true } : {}) });
  }
  return out;
}
// The repository paths an import specifier can denote, in resolution order:
// the exact path, then the source extensions, then an index file.
export function importCandidates(importer: string, spec: string): string[] {
  const cleaned = posix.normalize(posix.join(posix.dirname(importer.replace(/\\/g, '/')), spec)).replace(/^\.\//, '');
  if (/\.(?:[cm]?[jt]sx?|json|css|scss|svg|png|jpe?g|webp|gif|md)$/i.test(cleaned)) {
    // TypeScript convention: an import of ./x.js may denote ./x.ts.
    const swapped = cleaned.replace(/\.js$/, '.ts').replace(/\.jsx$/, '.tsx').replace(/\.mjs$/, '.mts');
    return [...new Set([cleaned, swapped])];
  }
  return [cleaned, ...['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json'].map(e => `${cleaned}.${e}`), ...['ts', 'tsx', 'js', 'jsx'].map(e => `${cleaned}/index.${e}`)];
}
// The smallest line range containing from..to that starts and ends at
// top-level statement boundaries, so a region rewrite never cuts a declaration.
export async function statementBounds(path: string, text: string, from: number, to: number): Promise<{ start: number; end: number }> {
  const total = text.split('\n').length;
  let start = Math.max(1, Math.min(from, total)); let end = Math.max(start, Math.min(to, total));
  if (tsModule === undefined) { try { const m: any = await import('typescript'); tsModule = m.default ?? m; } catch { tsModule = null; } }
  if (!tsModule || !parseable.test(path)) return { start, end };
  const ts = tsModule; const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const spans: { a: number; b: number }[] = sf.statements.map((st: any) => ({ a: sf.getLineAndCharacterOfPosition(st.getStart(sf)).line + 1, b: sf.getLineAndCharacterOfPosition(st.getEnd()).line + 1 }));
  let startFound = false; let endFound = false;
  for (const { a, b } of spans) {
    if (a <= start && b >= start) { start = a; startFound = true; }
    if (a <= end && b >= end) { end = b; endFound = true; }
  }
  // A bound that fell between statements moves to the nearest statement edge
  // inside the range, so the region never begins or ends on blank lines.
  if (!startFound) { const next = spans.filter(x => x.a > start && x.a <= end).map(x => x.a); if (next.length) start = Math.min(...next); }
  if (!endFound) { const prev = spans.filter(x => x.b < end && x.b >= start).map(x => x.b); if (prev.length) end = Math.max(...prev); }
  return { start, end };
}
// Top-level declarations of a file by name, with their line ranges.
export async function topLevelDeclarations(path: string, text: string): Promise<Map<string, { start: number; end: number; kind: string; exported: boolean }>> {
  const out = new Map<string, { start: number; end: number; kind: string; exported: boolean }>();
  if (tsModule === undefined) { try { const m: any = await import('typescript'); tsModule = m.default ?? m; } catch { tsModule = null; } }
  if (!tsModule || !parseable.test(path)) return out;
  const ts = tsModule; const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  for (const st of sf.statements) {
    const names: string[] = [];
    if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st) || ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st) || ts.isEnumDeclaration(st)) && st.name) names.push(st.name.text);
    if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name)) names.push(d.name.text);
    if (!names.length) continue;
    const start = sf.getLineAndCharacterOfPosition(st.getStart(sf)).line + 1; const end = sf.getLineAndCharacterOfPosition(st.getEnd()).line + 1;
    const exported = (ts.canHaveModifiers(st) ? ts.getModifiers(st) ?? [] : []).some((m: any) => m.kind === ts.SyntaxKind.ExportKeyword);
    const kind = ts.isVariableStatement(st) ? 'VariableStatement' : ts.SyntaxKind[st.kind]; // SyntaxKind[] yields the enum alias FirstStatement
    for (const n of names) out.set(n, { start, end, kind, exported });
  }
  return out;
}
// A configured check that cannot run here: its directory is missing or its
// executable is not installed. Such a command is dropped, not retried forever.
export async function checkUnusable(root: string, command: string, prefix = ''): Promise<string | null> {
  const dir = command.match(/(?:--dir|-C|--prefix)\s+(\S+)/)?.[1] ?? command.match(/^\s*cd\s+(\S+)/)?.[1];
  if (dir) { try { await stat(resolve(root, dir)); } catch { return `its directory ${dir} does not exist in this repository`; } }
  const exe = command.replace(/^\s*cd\s+\S+\s*(?:&&|;)\s*/, '').trim().split(/\s+/)[0] ?? '';
  if (exe && !exe.includes('/')) { const r = await runCommand('bash', ['--noprofile', '--norc', '-c', `${prefix}command -v -- ${JSON.stringify(exe)}`], root, 5000).catch(() => null); if (!r || r.code !== 0) return `${exe} is not installed on this machine`; }
  return null;
}
// What the repository looks like right now, for inference: git status, the
// package scripts, and the top-level entries. Works without git.
export async function repositoryStatus(root: string): Promise<{ git: boolean; changed: string[]; changedCount: number; scripts: Record<string, string>; topLevel: string[]; packages: { dir: string; scripts: Record<string, string>; tools: string[] }[] }> {
  const ignore = /(^|\/)(node_modules|dist|build|\.leana|\.git|coverage|target|__pycache__)(\/|$)/;
  const r = await runCommand('git', ['status', '--porcelain=v1', '--untracked-files=all'], root, 10000).catch(() => null);
  const git = Boolean(r && r.code === 0);
  const all = git ? r!.output.split('\n').filter(Boolean).map(l => l.slice(3).trim().replace(/^"|"$/g, '')).filter(p => !ignore.test(p)) : [];
  let scripts: Record<string, string> = {};
  try { const pkg = JSON.parse(await boundedRead(await safePath(root, 'package.json'))); if (pkg && typeof pkg.scripts === 'object') scripts = Object.fromEntries(Object.entries(pkg.scripts).slice(0, 20).map(([k, v]) => [k, String(v).slice(0, 120)])); } catch { /* none */ }
  let topLevel: string[] = [];
  try { topLevel = (await readdir(root)).filter(n => !/^(node_modules|\.git|\.leana)$/.test(n)).sort().slice(0, 40); } catch { /* none */ }
  // Packages below the root, to depth 3: a monorepo's checks live with the package.
  const packages: { dir: string; scripts: Record<string, string>; tools: string[] }[] = [];
  const manifests = ['package.json', 'tsconfig.json', 'pyproject.toml', 'setup.py', 'Cargo.toml', 'go.mod', 'Makefile', 'pom.xml', 'build.gradle'];
  const walk = async (dir: string, depth: number) => {
    if (depth > 3 || packages.length >= 12) return;
    let entries: string[]; try { entries = await readdir(resolve(root, dir)); } catch { return; }
    const found = entries.filter(n => manifests.includes(n));
    if (found.length && dir !== '.') {
      let pkgScripts: Record<string, string> = {};
      if (found.includes('package.json')) { try { const pkg = JSON.parse(await boundedRead(resolve(root, dir, 'package.json'))); if (pkg && typeof pkg.scripts === 'object') pkgScripts = Object.fromEntries(Object.entries(pkg.scripts).slice(0, 12).map(([k, v]) => [k, String(v).slice(0, 100)])); } catch { /* none */ } }
      packages.push({ dir, scripts: pkgScripts, tools: found });
    }
    for (const n of entries) if (!/^(node_modules|\.git|\.leana|dist|build|coverage|target|vendor|\.[^/]*)$/.test(n)) { try { if ((await stat(resolve(root, dir, n))).isDirectory()) await walk(dir === '.' ? n : `${dir}/${n}`, depth + 1); } catch { /* skip */ } }
  };
  await walk('.', 0);
  return { git, changed: all.slice(0, 40), changedCount: all.length, scripts, topLevel, packages };
}
// The packages a generated file may import: the manifest's dependencies, so
// the worker never invents one.
export async function installedPackages(root: string): Promise<string[]> {
  let pkg: any; try { pkg = JSON.parse(await boundedRead(await safePath(root, 'package.json'))); } catch { return []; }
  const names = (o: unknown) => o && typeof o === 'object' ? Object.entries(o as Record<string, string>).map(([k, v]) => `${k}@${String(v).replace(/^[\^~]/, '')}`) : [];
  return [...new Set([...names(pkg?.dependencies), ...names(pkg?.devDependencies), ...names(pkg?.peerDependencies)])];
}
// A trial that failed for want of dependencies, and the install the manifest implies.
export async function installCommand(root: string, dir = '.', force = false): Promise<string | null> {
  const has = async (p: string) => { try { await stat(resolve(root, dir, p)); return true; } catch { return false; } };
  if (await has('package.json')) {
    if (!force && await has('node_modules')) return null;
    // A forced install follows a manifest change: the lockfile no longer
    // matches it, so the frozen forms (npm ci, --frozen-lockfile) would refuse.
    const cmd = await has('pnpm-lock.yaml') ? (force ? 'pnpm install --no-frozen-lockfile' : 'pnpm install --frozen-lockfile') : await has('yarn.lock') ? (force ? 'yarn install' : 'yarn install --frozen-lockfile') : (await has('bun.lockb') || await has('bun.lock')) ? 'bun install' : (!force && await has('package-lock.json')) ? 'npm ci --no-audit --no-fund' : 'npm install --no-audit --no-fund';
    return dir === '.' ? cmd : `cd ${dir} && ${cmd}`;
  }
  if (await has('requirements.txt')) return `${dir === '.' ? '' : `cd ${dir} && `}python3 -m pip install -r requirements.txt`;
  if (await has('pyproject.toml')) return `${dir === '.' ? '' : `cd ${dir} && `}python3 -m pip install -e .`;
  return null;
}
// A check whose output depends on a cache is not a verification: incremental
// tsc reuses a file's cached diagnostics until that file itself changes, so a
// new module that stops declaring globals leaves stale results elsewhere.
export async function checkAdvice(root: string, command: string): Promise<string | null> {
  if (!command || /--incremental\s+false|--force\b/.test(command)) return null;
  const dir = command.match(/(?:--dir|-C|--prefix|cd)\s+(\S+)/)?.[1] ?? '.';
  const tsc = /\btsc\b/.test(command) || /\b(lint|typecheck|check|build)\b/.test(command);
  if (!tsc) return null;
  for (const name of ['tsconfig.json', 'tsconfig.build.json']) {
    try {
      const text = await readFile(resolve(root, dir, name), 'utf8');
      if (/"incremental"\s*:\s*true/.test(text) || /"composite"\s*:\s*true/.test(text)) return `${command} runs tsc with incremental mode (${dir}/${name}); its error list depends on the previous run's cache, so rollbacks would be judged on stale results. Use a non-incremental check, for example: pnpm --dir ${dir === '.' ? '.' : dir} exec tsc --noEmit --incremental false`;
    } catch { /* absent */ }
  }
  return null;
}
// Fresh, parser-backed facts for completion. Historical edits can be evicted or
// conservatively rejected by an old rollback; current imports and declarations
// still establish the final structure. Names are selected from the objective,
// never inferred from a worker's claim. Comments and strings are not declarations.
export async function completionSource(root: string, paths: string[], objective: string): Promise<SourceEvidence[]> {
  if (tsModule === undefined) { try { const m: any = await import('typescript'); tsModule = m.default ?? m; } catch { tsModule = null; } }
  const wanted = new Set(objective.match(/[A-Za-z_$][\w$]*/g) ?? []);
  const out: SourceEvidence[] = [];
  let remaining = 6500;
  for (const path of [...new Set(paths)].slice(0, 12)) {
    const evidence: SourceEvidence = { path, facts: [] };
    try {
      const text = await boundedRead(await safePath(root, path));
      evidence.hash = hash(text);
      if (tsModule && parseable.test(path)) {
        const ts = tsModule;
        const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
        for (const st of sf.statements) {
          const line = sf.getLineAndCharacterOfPosition(st.getStart(sf)).line + 1;
          const endLine = sf.getLineAndCharacterOfPosition(st.getEnd() - 1).line + 1;
          const exported = Boolean(st.modifiers?.some((m: any) => m.kind === ts.SyntaxKind.ExportKeyword));
          if (ts.isImportDeclaration(st)) {
            const c = st.importClause;
            const bindings = [...(c?.name ? [{ name: c.name, propertyName: { text: 'default' } }] : []), ...(c?.namedBindings?.elements ?? []),
              ...(c?.namedBindings?.name ? [{ name: c.namedBindings.name, propertyName: { text: '*' } }] : [])];
            for (const b of bindings) if (wanted.has(b.name.text) || wanted.has(b.propertyName?.text))
              evidence.facts.push({ line, endLine, kind: 'import', name: b.name.text, imported: b.propertyName?.text ?? b.name.text, from: st.moduleSpecifier.text, typeOnly: Boolean(c.isTypeOnly || b.isTypeOnly) });
          } else if (ts.isExportDeclaration(st)) {
            for (const b of st.exportClause?.elements ?? []) if (wanted.has(b.name.text) || wanted.has(b.propertyName?.text))
              evidence.facts.push({ line, endLine, kind: 'export', name: b.name.text, local: b.propertyName?.text ?? b.name.text, from: st.moduleSpecifier?.text });
          } else if (ts.isVariableStatement(st)) {
            for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name) && wanted.has(d.name.text))
              evidence.facts.push({ line, endLine, kind: 'variable', name: d.name.text, exported });
          } else if (st.name && ts.isIdentifier(st.name) && wanted.has(st.name.text)) {
            evidence.facts.push({ line, endLine, kind: ts.SyntaxKind[st.kind], name: st.name.text, exported });
          }
        }
      }
      const all = evidence.facts.length;
      evidence.facts = evidence.facts.slice(0, 16);
      if (!all) evidence.excerpt = clip(text.split('\n').slice(0, 20).join('\n'), 600);
      while (Buffer.byteLength(JSON.stringify(evidence)) > remaining && evidence.facts.length) evidence.facts.pop();
      if (evidence.facts.length < all) evidence.omitted = all - evidence.facts.length;
      if (Buffer.byteLength(JSON.stringify(evidence)) > remaining) evidence.excerpt = undefined;
    } catch (e) { evidence.error = clip((e as Error).message, 160); }
    remaining -= Buffer.byteLength(JSON.stringify(evidence));
    out.push(evidence);
    if (remaining < 500) break;
  }
  return out;
}
export async function sourceHashes(root: string, paths: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const path of new Set(paths)) {
    try { out[path] = hash(await boundedRead(await safePath(root, path))); }
    catch { out[path] = 'unavailable'; }
  }
  return out;
}
// A check's result as facts: its exit code, and the repository files its
// output names. No tool's format is parsed: a path token counts only when it
// resolves to a file of the repository (not of an installed dependency), and
// a line number is kept when one follows it (path:12, path(12,5), path", line 12).
// A path printed relative to a subdirectory the check ran in resolves through
// the known files that end with it, when exactly one does.
const dependencyTree = /(^|\/)(?:node_modules|\.git|\.leana|\.venv|venv|site-packages)\//;
export async function summarizeCheck(text: string, root: string, known: string[] = []): Promise<CheckSummary> {
  let output = text; let code: number | null = null;
  try { const parsed = JSON.parse(text); if (typeof parsed?.output === 'string') output = parsed.output; if (typeof parsed?.code === 'number') code = parsed.code; } catch { /* plain text */ }
  const prefix = `${root.replace(/\/$/, '')}/`;
  const files: Record<string, number[]> = {}; const resolved = new Map<string, string | null>();
  const resolvePath = async (token: string): Promise<string | null> => {
    if (resolved.has(token)) return resolved.get(token)!;
    let p: string | null = token.replace(/^file:\/\//, '');
    if (p.startsWith('/')) p = p.startsWith(prefix) ? p.slice(prefix.length) : null;
    if (p !== null) p = posix.normalize(p).replace(/^\.\//, '');
    if (p !== null && (p.startsWith('../') || dependencyTree.test(p))) p = null;
    if (p !== null) {
      const isFile = await stat(resolve(root, p)).then(s => s.isFile(), () => false);
      if (!isFile) { const ends = known.filter(f => f.endsWith(`/${p}`)); p = ends.length === 1 ? ends[0]! : null; }
    }
    resolved.set(token, p); return p;
  };
  for (const m of output.matchAll(/(?:^|[\s"'`(\[<=,:])((?:file:\/\/)?(?:\/|\.{1,2}\/)?(?:[\w@+.-]+\/)*[\w@+-][\w@+.-]*\.[A-Za-z]\w{0,7})(?:(?::|\(|", line )(\d+))?/g)) {
    if (resolved.size >= 300) break;
    const p = await resolvePath(m[1]!); if (!p) continue;
    const lines = files[p] ??= []; const n = Number(m[2] ?? 0);
    if (n && lines.length < 12 && !lines.includes(n)) lines.push(n);
  }
  return { code, files: Object.fromEntries(Object.entries(files).slice(0, 20)) };
}
// What a failed install says the manifest got wrong: a version that does not
// exist (ETARGET) or a package that does not (E404). Repairing either is code's
// work: look the real version up, or drop the dependency.
export function manifestFailures(output: string): { name: string; kind: 'notarget' | 'notfound' }[] {
  const out = new Map<string, 'notarget' | 'notfound'>();
  for (const m of output.matchAll(/No matching version found for ((?:@[\w.-]+\/)?[\w.-]+)@/g)) out.set(m[1]!, 'notarget');
  for (const m of output.matchAll(/404\s+(?:Not Found\s+-\s+GET\s+\S+\/((?:@[\w.-]+(?:%2f|\/))?[\w.-]+)(?:\s|$)|'((?:@[\w.-]+\/)?[\w.-]+)@[^']*' is not in this registry)/g)) { const n = (m[1] ?? m[2] ?? '').replace('%2f', '/'); if (n && !out.has(n)) out.set(n, 'notfound'); }
  return [...out.entries()].map(([name, kind]) => ({ name, kind }));
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
  const json = /\.json$/i.test(path);
  if (!parseable.test(path) && !json) return [];
  if (tsModule === undefined) { try { const m: any = await import('typescript'); tsModule = m.default ?? m; } catch { tsModule = null; } }
  if (!tsModule) { if (json) { try { JSON.parse(text); return []; } catch (e) { return [`invalid JSON: ${(e as Error).message}`]; } } return []; }
  const ts = tsModule;
  const where = (d: any) => d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start) : null;
  const message = (d: any) => { const w = where(d); return `${w ? `line ${w.line + 1}: ` : ''}${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`; };
  // JSON with the parser tsconfig uses: comments and trailing commas allowed.
  if (json) return (ts.parseJsonText(path, text).parseDiagnostics ?? []).slice(0, 5).map(message);
  const out = ts.transpileModule(text, { reportDiagnostics: true, fileName: path, compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.Preserve, allowJs: true } });
  return (out.diagnostics ?? []).slice(0, 5).map(message);
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
// What a shell command did to the tree, whatever the command was: every file's
// size and modification time before and after it. Installed environments
// (node_modules, a Python virtual environment, marked by its pyvenv.cfg) are the
// package manager's, not edits; in a git repository so is everything git ignores
// (build output, caches). Null when the tree is too large to walk each command.
export type TreeSnapshot = Map<string, string>;
export async function treeSnapshot(root: string, limit = 20000): Promise<TreeSnapshot | null> {
  const out: TreeSnapshot = new Map();
  async function visit(dir: string, prefix: string): Promise<boolean> {
    let entries; try { entries = await readdir(dir, { withFileTypes: true }); } catch { return true; }
    if (prefix && entries.some(e => e.name === 'pyvenv.cfg')) return true;
    for (const entry of entries) {
      if (['.git', '.leana', 'node_modules'].includes(entry.name)) continue;
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) { if (!(await visit(path, `${prefix}${entry.name}/`))) return false; }
      else if (entry.isFile()) { try { const s = await stat(path); out.set(`${prefix}${entry.name}`, `${s.size}:${s.mtimeMs}`); } catch { /* gone */ } if (out.size > limit) return false; }
    }
    return true;
  }
  return (await visit(root, '')) ? out : null;
}
export async function treeChanges(root: string, before: TreeSnapshot, after: TreeSnapshot): Promise<{ changed: string[]; created: string[]; deleted: string[] }> {
  const created = [...after.keys()].filter(p => !before.has(p));
  const deleted = [...before.keys()].filter(p => !after.has(p));
  const modified = [...after.keys()].filter(p => before.has(p) && before.get(p) !== after.get(p));
  let all = [...modified, ...created, ...deleted];
  if (all.length) {
    const r = await new Promise<string | null>(done => {
      const child = spawn('git', ['check-ignore', '--no-index', '--stdin'], { cwd: root, stdio: ['pipe', 'pipe', 'ignore'] });
      let text = ''; child.stdout.on('data', d => { text += String(d); }); child.on('error', () => done(null));
      child.on('close', code => done(code === 0 || code === 1 ? text : null));
      child.stdin.end(all.join('\n') + '\n');
    });
    const ignored = new Set((r ?? '').split('\n').filter(Boolean));
    all = all.filter(p => !ignored.has(p));
  }
  const keep = new Set(all);
  return { changed: all, created: created.filter(p => keep.has(p)), deleted: deleted.filter(p => keep.has(p)) };
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
    // No terminal is attached: tools that would prompt are told so, the way
    // continuous integration tells them, and npm's own prompts are pre-answered.
    Object.assign(env, { CI: '1', FORCE_COLOR: '0', npm_config_yes: 'true', DEBIAN_FRONTEND: 'noninteractive' });
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
export async function boundedRead(path: string, limit = 1024 * 1024): Promise<string> {
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
export class ToolBox {
  // What the repository's ecosystem prefixes every command with (its
  // environment's tools on the path), set by the loop from the profiles.
  commandPrefix: (() => Promise<string>) | null = null;
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
        if (f.end < f.start) throw new Error(`A read range needs end >= start (got ${f.start}..${f.end})`);
        // No line cap of its own: the character budget below decides how much of the range is shown.
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
    if (route === 'create_file') {
      // Creation has one meaning: a file that does not exist gets this content.
      // The content is validated after it lands, never refused for its shape:
      // a parse problem is reported to the worker as a fact, and the
      // relative imports are reported.
      if (!this.config.allowWrite) throw new Error('Writes disabled; restart with --allow-write');
      if (typeof a.path !== 'string' || /[\\/]$/.test(a.path) || a.path === '.' || a.path === '..') throw new Error('create_file requires a regular file path; directory path rejected');
      const content = typeof a.content === 'string' ? a.content : '';
      if (!content.trim()) throw new Error(`create_file for ${a.path} produced no content`);
      const path = await safePath(this.root, a.path, true);
      let exists = true; try { await stat(path); } catch (e: any) { if (e.code !== 'ENOENT') throw e; exists = false; }
      if (exists) throw new Error(`${a.path} already exists; edit it with replace_lines or write instead of creating it`);
      await mkdir(dirname(path), { recursive: true });
      await safePath(this.root, a.path, true);
      const handle = await open(path, 'wx', 0o644);
      try { await handle.writeFile(content); } finally { await handle.close(); }
      const parseErrors = await syntaxErrors(a.path, content);
      const imports = await relativeImports(a.path, content);
      const h = hash(content);
      return { ok: true, changed: [a.path], hashes: { [a.path]: h }, snapshots: { [a.path]: '@new' }, parseErrors, imports,
        text: `Created ${a.path} (${content.split('\n').length} lines); sha256=${h}.${parseErrors.length ? ` It does not parse yet (${parseErrors.join('; ')}); it stays as written until an edit fixes it.` : ''}${imports.length ? ` Imports ${imports.map(i => i.spec).join(', ')}.` : ''}` };
    }
    if (route === 'write') {
      // An anchor replacement in a file that exists; nothing else.
      if (!this.config.allowWrite) throw new Error('Writes disabled; restart with --allow-write');
      if (/[\\/]$/.test(a.path) || a.path === '.' || a.path === '..') throw new Error('write requires a regular file path; directory path rejected');
      const path = await safePath(this.root, a.path, true);
      let original: string | null = null;
      try { original = await boundedRead(path); } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
      if (original === null) throw new StaleWriteError(`${a.path} does not exist: write replaces an anchor in an existing file; a new file is made with create_file`);
      if (a.expectedHash === 'new') throw new StaleWriteError(`expectedHash=new is not a hash; ${a.path} exists: read it with read_files and use the returned sha256`);
      if (hash(original) !== a.expectedHash) throw new StaleWriteError(`Stale file hash for ${a.path}: read the file again and use the sha256 from that result`);
      const snapshots = { [a.path]: await this.snapshot(a.path, original) };
      const matches = a.oldText ? original.split(a.oldText).length - 1 : 0;
      if (matches === 0) throw new Error('oldText must match exactly once: it was not found in the current file. Copy a small anchor exactly from the latest read_files result of this path; never paste a truncated excerpt');
      if (matches > 1) throw new Error(`oldText must match exactly once: it matches ${matches} times. Include more surrounding lines so the anchor is unique`);
      // An import the file already has is dropped from the replacement, not refused.
      const { kept, dropped } = dropDuplicateImports(original.replace(a.oldText, ''), String(a.newText).split('\n'));
      const newText = kept.join('\n');
      const updated = original.replace(a.oldText, () => newText);
      if (updated === original) throw new Error(dropped.length ? `Write produced no change: the only new lines were imports ${a.path} already has (${dropped.map(l => l.trim()).join('; ')})` : 'Write produced no change: newText equals oldText. oldText is the exact existing anchor; newText must be the modified text that replaces it');
      // A whole-file rewrite is a finished generation of the complete file: like a
      // created file it lands as written and its parse state is reported, never
      // refused. The shape guards are for anchor edits, which splice into a file.
      if (!a.wholeFile) {
        assertBalancePreserved(original, updated, a.path);
        await assertParses(a.path, original, updated);
        assertNoBulkDuplication(original.replace(a.oldText, ''), kept, a.path);
      }
      const temp = `${path}.leana-${randomUUID()}.tmp`;
      try {
        const h = await open(temp, 'wx', (await stat(path)).mode & 0o777);
        try { await h.writeFile(updated); } finally { await h.close(); }
        if (hash(await boundedRead(path)) !== a.expectedHash) throw new StaleWriteError('File changed while preparing edit; read it again');
        await rename(temp, path);
      } finally { await unlink(temp).catch(() => {}); }
      const updatedHash = hash(updated);
      const anchorLines = String(a.oldText).split('\n').length;
      const notes = [dropped.length ? `Dropped ${dropped.length} import line(s) the file already had.` : '', anchorLines > 6 && !a.wholeFile ? `The anchor was ${anchorLines} lines; replace_lines addresses a block by line number without retyping it.` : ''].filter(Boolean).join(' ');
      return { ok: true, changed: [a.path], hashes: { [a.path]: updatedHash }, snapshots, text: a.region ? `Replaced lines ${a.region.start}..${a.region.end} of ${a.path} with ${a.region.lines} generated line(s); the file now has ${updated.replace(/\n$/, '').split('\n').length} lines; sha256=${updatedHash}.` : a.wholeFile ? `Rewrote ${a.path} (${updated.split('\n').length} lines); sha256=${updatedHash}.` : `Updated ${a.path}; sha256=${updatedHash}.${notes ? ` ${notes}` : ''} Run focused validation.` };
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
          const lastWord = e.prepend.trim().split(/\s+/).pop() ?? '';
          if (lastWord && line.trimStart().startsWith(`${lastWord} `)) throw new Error(`Line ${n} already starts with ${JSON.stringify(lastWord)} (${JSON.stringify(line.trim().slice(0, 60))}); prepend adds only what is missing, so use prepend ${JSON.stringify(e.prepend.trim().split(/\s+/).slice(0, -1).join(' ') + ' ')}`);
        }
      }
      // An edit that leaves its lines as they are is skipped, not fatal: in a
      // batch of forty deletions one redundant rewrite must not void the rest.
      // Import lines the file already has (outside the replaced ranges) are
      // dropped from the inserted text: the intent is met, so the edit is repaired.
      const outsideText = lines.filter((_, i) => !all.some(e => e.end >= e.start && i + 1 >= e.start && i + 1 <= e.end)).join('\n');
      const droppedImports: string[] = [];
      const rendered = (e: { start: number; end: number; newText: string; prepend?: string }): string[] => {
        if (e.prepend) return lines.slice(e.start - 1, e.end).map(l => `${e.prepend}${l}`);
        if (e.newText === '') return [];
        const { kept, dropped } = dropDuplicateImports(outsideText, e.newText.replace(/\n$/, '').split('\n'));
        for (const d of dropped) if (!droppedImports.includes(d)) droppedImports.push(d);
        return kept;
      };
      const same = (x: string[], y: string[]) => x.length === y.length && x.every((l, i) => l === y[i]);
      // A deletion is never a no-op; a rewrite is one only when every line is unchanged.
      const skipped = all.filter(e => e.end >= e.start && !(e.newText === '' && !e.prepend) && same(lines.slice(e.start - 1, e.end), rendered(e)));
      const edits = all.filter(e => !skipped.includes(e) && !(e.end < e.start && rendered(e).length === 0));
      if (!edits.length) throw new Error(droppedImports.length ? `replace_lines produced no change: the only new lines were imports ${a.path} already has (${droppedImports.map(l => l.trim()).join('; ')})` : `replace_lines produced no change: every newText equals the current lines (${all.map(e => `${e.start}..${e.end}`).join(', ')})`);
      // A harness-chosen rewrite (a region the code picked, validated before
      // it got here) is applied as it is: the paste and retype rules are for
      // the worker's own line edits.
      const harness = a.harness === true;
      const retypes: string[] = [];
      if (!harness) for (const e of edits) if (!e.prepend && e.end >= e.start) { const why = nearRetype(lines.slice(e.start - 1, e.end), rendered(e), e.start); if (why) retypes.push(why); }
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
      // Retyping a range in place is a rewrite, not a paste: judge the inserted
      // lines against the file without the ranges they replace.
      const outside = lines.filter((_, i) => !edits.some(e => e.end >= e.start && i + 1 >= e.start && i + 1 <= e.end)).join('\n');
      if (!harness) assertNoBulkDuplication(outside, edits.filter(e => !e.prepend).flatMap(e => rendered(e)), a.path);
      const temp = `${path}.leana-${randomUUID()}.tmp`;
      try {
        const h = await open(temp, 'wx', (await stat(path)).mode & 0o777);
        try { await h.writeFile(updated); } finally { await h.close(); }
        if (hash(await boundedRead(path)) !== a.expectedHash) throw new StaleWriteError('File changed while preparing edit; read it again');
        await rename(temp, path);
      } finally { await unlink(temp).catch(() => {}); }
      const summary = edits.map(e => `${e.start}..${e.end}`).reverse().join(', ');
      const newLines = updated.split('\n'); const lo = Math.max(1, Math.min(...edits.map(e => e.start)) - 3); const hi = Math.min(newLines.length, Math.max(...edits.map(e => e.end)) + delta + 3);
      const region = hi >= lo && hi - lo < 120 ? `\nThe file now reads, lines ${lo}..${hi}:\n${newLines.slice(lo - 1, hi).map((l, i) => `${lo + i}: ${l}`).join('\n')}` : '';
      const note = [skipped.length ? ` Skipped ${skipped.length} unchanged range(s): ${skipped.map(e => `${e.start}..${e.end}`).reverse().join(', ')}.` : '',
        droppedImports.length ? ` Dropped ${droppedImports.length} import line(s) the file already had.` : '', retypes.length ? ` Note: ${retypes.join('; ')}.` : ''].join('');
      return { ok: true, changed: [a.path], hashes: { [a.path]: hash(updated) }, snapshots,
        text: `Replaced ${edits.length} range(s) ${summary} of ${a.path}; sha256=${hash(updated)} totalLines=${updated.split('\n').length}.${note} Line numbers below the first edit shifted by ${delta} in total.${region} Run focused validation.` };
    }
    if (route === 'move_lines') {
      // A plain cut and paste: the lines leave source and are appended to
      // destination as they were. Nothing else in either file is changed.
      if (!this.config.allowWrite) throw new Error('Writes disabled; restart with --allow-write');
      if (a.source === a.destination) throw new Error('source and destination must differ');
      if (a.end < a.start || a.end - a.start >= 2000) throw new Error('move_lines ranges must contain 1..2000 lines');
      if (/[\\/]$/.test(a.destination)) throw new Error('destination must be a regular file path');
      const sourcePath = await safePath(this.root, a.source);
      const destinationPath = await safePath(this.root, a.destination, true);
      const original = await boundedRead(sourcePath);
      if (hash(original) !== a.expectedHash) throw new StaleWriteError(`Stale file hash for ${a.source}: read the file again and use the sha256 from that result`);
      const lines = original.split('\n');
      if (a.end > lines.length) throw new Error(`Range ${a.start}..${a.end} exceeds ${a.source} (${lines.length} lines)`);
      const snapshots: Record<string, string> = { [a.source]: await this.snapshot(a.source, original) };
      let existing: string | null = null;
      try { existing = await boundedRead(destinationPath); } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
      if (existing === null && a.destinationHash !== 'new') throw new StaleWriteError(`${a.destination} does not exist; use destinationHash=new to create it`);
      if (existing !== null && a.destinationHash === 'new') throw new StaleWriteError(`${a.destination} exists: read it and use its sha256 as destinationHash`);
      // Appending does not depend on the destination's content: a stale destination
      // hash is noted, not refused, as long as the source (whose lines are cut) is current.
      const destinationStale = existing !== null && hash(existing) !== a.destinationHash;
      snapshots[a.destination] = existing !== null ? await this.snapshot(a.destination, existing) : '@new';
      const moved = lines.slice(a.start - 1, a.end).join('\n');
      const remaining = [...lines.slice(0, a.start - 1), ...lines.slice(a.end)].join('\n');
      const output = existing === null || existing === '' ? `${moved}\n` : `${existing.replace(/\n?$/, '\n')}${moved}\n`;
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
        text: `Moved lines ${a.start}..${a.end} (${a.end - a.start + 1} lines) from ${a.source} to the end of ${a.destination}, unchanged; nothing else in either file was changed. ` +
        `${a.source} sha256=${hash(remaining)} totalLines=${remaining.split('\n').length}; ${a.destination} sha256=${hash(output)} totalLines=${output.split('\n').length}.` +
        (destinationStale ? ` (destinationHash was stale; the current ${a.destination} was appended to.)` : '') };
    }
    if (route === 'bash') {
      if (!this.config.allowBash) throw new Error('Shell disabled; restart with --allow-bash');
      // Preserve failures hidden by commands such as `pnpm test 2>&1 | tail`.
      // Without pipefail, the tail process masks the test runner's exit code.
      const prefix = this.commandPrefix ? await this.commandPrefix().catch(() => '') : '';
      const r = await runCommand('bash', ['--noprofile', '--norc', '-o', 'pipefail', '-c', `${prefix}${a.command}`], this.root, this.config.commandTimeoutMs);
      // With a configured check command, only that command is verification; the
      // command words of the profiles are a fallback for sessions that did not declare one.
      // A command is verification when the worker says so, or when it is the configured check; never by its words.
      const looksLikeCheck = a.check === true || Boolean(this.config.checkCommand && a.command.trim() === this.config.checkCommand.trim());
      return { ok: r.code === 0 && !r.truncated && !r.timedOut, check: looksLikeCheck && r.code === 0 && !r.truncated && !r.timedOut, verification: looksLikeCheck,
        text: JSON.stringify({ command: a.command, purpose: a.purpose, ...r }) };
    }
    throw new Error(`Not an executable filesystem tool: ${route}`);
  }
}

// A package script that only runs tsc against a solution tsconfig (references
// and no include) checks nothing: the verification of record must be a config
// that includes the sources.
export async function solutionTsconfigReferences(root: string): Promise<string[] | null> {
  let cfg: any; try { cfg = JSON.parse((await boundedRead(await safePath(root, 'tsconfig.json'))).replace(/\/\*[\s\S]*?\*\/|(^|\s)\/\/[^\n]*/g, '')); } catch { return null; }
  const refs = Array.isArray(cfg?.references) ? cfg.references.map((r: any) => String(r?.path ?? '')).filter(Boolean) : [];
  const includes = (Array.isArray(cfg?.include) && cfg.include.length) || (Array.isArray(cfg?.files) && cfg.files.length);
  return refs.length && !includes ? refs : null;
}
