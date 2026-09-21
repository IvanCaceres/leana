import { createHash, randomUUID } from 'node:crypto';
import { open, readFile, realpath, rename, stat, unlink, mkdir, readdir } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import type { CheckSummary, Config, NameOrigin, Route, SourceEvidence, ToolResult } from './types.js';
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
    if (!attributed) return { errors: s.errors, syntax: s.syntax, resolution: s.resolution ?? 0 };
    let errors = 0; let syntax = 0; let resolution = 0;
    for (const [f, v] of Object.entries(s.byFile)) if (f === '(other)' || matches(f)) { errors += v.count; syntax += v.syntax; resolution += v.resolution ?? 0; }
    return { errors, syntax, resolution };
  };
  const b = inScope(before); const a = inScope(after);
  // New syntax errors with no net progress are a regression. New syntax errors
  // alongside a net decrease are progress with one known line to fix: keep them.
  if (a.syntax > b.syntax && a.errors >= b.errors) return 'worse';
  // Unresolved names and modules come first: an edit that adds one is never
  // progress, and one that removes one is progress even when the types it
  // brings in surface further errors (an any-typed import hides them).
  // (Net progress with one new unresolved name, such as an import line removed
  // that also carried a used binding, is kept: the resolver repairs that name.)
  if (!scope.structural && a.resolution > b.resolution && a.errors >= b.errors) return 'worse';
  if (a.resolution < b.resolution) return 'fine';
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
// What an extraction needs beyond cutting and pasting, computed from the
// TypeScript AST: export on the moved top-level declarations, the source's
// import lines that the block uses (re-based to the destination), the import the
// source needs for names it still references, and the source's own top-level
// declarations the block depends on (which need an export or a move).
export async function movePlan(source: string, text: string, start: number, end: number, destination: string, replacementText = ''): Promise<{
  moved: string; exported: string[]; prefix: string[]; replacement: string[]; stillUsed: string[]; localDeps: { name: string; line: number }[];
} | null> {
  if (tsModule === undefined) { try { const m: any = await import('typescript'); tsModule = m.default ?? m; } catch { tsModule = null; } }
  if (!tsModule) return null;
  const ts = tsModule;
  const lines = text.split('\n');
  const block = lines.slice(start - 1, end).join('\n');
  const bf = ts.createSourceFile(source, block, ts.ScriptTarget.Latest, true);
  const declName = (st: any): string | null => {
    if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st) || ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st) || ts.isEnumDeclaration(st)) && st.name) return st.name.text;
    if (ts.isVariableStatement(st)) { const d = st.declarationList.declarations[0]; return d && ts.isIdentifier(d.name) ? d.name.text : null; }
    return null;
  };
  const hasExport = (st: any) => (ts.canHaveModifiers(st) ? ts.getModifiers(st) ?? [] : []).some((m: any) => m.kind === ts.SyntaxKind.ExportKeyword);
  const typeOnly = (st: any) => ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st);
  const declared: { name: string; typeOnly: boolean }[] = []; const exported: string[] = []; const inserts: number[] = [];
  for (const st of bf.statements) {
    const name = declName(st); if (!name) continue;
    declared.push({ name, typeOnly: typeOnly(st) });
    if (!hasExport(st)) { exported.push(name); inserts.push(st.getStart(bf)); }
  }
  let moved = block;
  for (const pos of inserts.sort((x, y) => y - x)) moved = `${moved.slice(0, pos)}export ${moved.slice(pos)}`;
  // Identifiers the block uses (excluding property names and its own declarations).
  const used = new Set<string>();
  const walk = (n: any) => {
    if (ts.isIdentifier(n)) {
      const p = n.parent;
      const isProperty = (p && ((ts.isPropertyAccessExpression(p) && p.name === n) || (ts.isPropertyAssignment(p) && p.name === n) || (ts.isQualifiedName(p) && p.right === n)
        || ((ts.isPropertySignature(p) || ts.isMethodSignature(p) || ts.isPropertyDeclaration(p) || ts.isMethodDeclaration(p) || ts.isEnumMember(p)) && p.name === n)));
      if (!isProperty) used.add(n.text);
    }
    ts.forEachChild(n, walk);
  };
  walk(bf);
  for (const d of declared) used.delete(d.name);
  // The source's imports and top-level declarations, outside the block.
  const sf = ts.createSourceFile(source, text, ts.ScriptTarget.Latest, true);
  const rebase = (spec: string) => { if (!spec.startsWith('.')) return spec; const r = relative(dirname(destination), resolve(dirname(source), spec)).replace(/\\/g, '/'); return r.startsWith('.') ? r : `./${r}`; };
  const prefix: string[] = []; const covered = new Set<string>();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !st.importClause) continue;
    const c = st.importClause; const spec = st.moduleSpecifier.text; const mod = rebase(spec);
    const named = (c.namedBindings && ts.isNamedImports(c.namedBindings) ? c.namedBindings.elements : []).filter((b: any) => used.has(b.name.text));
    const def = c.name && used.has(c.name.text) ? c.name.text : null;
    const ns = c.namedBindings && ts.isNamespaceImport(c.namedBindings) && used.has(c.namedBindings.name.text) ? c.namedBindings.name.text : null;
    if (def) { prefix.push(`import ${c.isTypeOnly ? 'type ' : ''}${def} from "${mod}";`); covered.add(def); }
    if (ns) { prefix.push(`import ${c.isTypeOnly ? 'type ' : ''}* as ${ns} from "${mod}";`); covered.add(ns); }
    if (named.length) {
      const parts = named.map((b: any) => `${b.isTypeOnly && !c.isTypeOnly ? 'type ' : ''}${b.propertyName ? `${b.propertyName.text} as ` : ''}${b.name.text}`);
      prefix.push(`import ${c.isTypeOnly ? 'type ' : ''}{ ${parts.join(', ')} } from "${mod}";`);
      for (const b of named) covered.add(b.name.text);
    }
  }
  const blockStart = lines.slice(0, start - 1).join('\n').length + (start > 1 ? 1 : 0); const blockEnd = blockStart + block.length;
  const localDeps: { name: string; line: number }[] = [];
  for (const st of sf.statements) {
    if (st.getStart(sf) >= blockStart && st.getEnd() <= blockEnd) continue;
    const name = declName(st);
    if (name && used.has(name) && !covered.has(name) && !hasExport(st)) localDeps.push({ name, line: sf.getLineAndCharacterOfPosition(st.getStart(sf)).line + 1 });
  }
  // Names the source still references after the cut need an import from the destination.
  const restRaw = `${lines.slice(0, start - 1).join('\n')}\n${replacementText}\n${lines.slice(end).join('\n')}`;
  const rest = stripLiterals(restRaw);
  const toDest = (() => { const r = relative(dirname(source), destination).replace(/\\/g, '/').replace(/\.[cm]?ts$/, '.js'); return r.startsWith('.') ? r : `./${r}`; })();
  // Names the source (or the worker's own replacement) already imports from the destination.
  const imported = new Set<string>();
  for (const m of restRaw.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+["']([^"']+)["']/g)) if (m[2] === toDest) for (const part of m[1]!.split(',')) { const local = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/).pop()!.trim(); if (local) imported.add(local); }
  const stillUsed = declared.filter(d => !imported.has(d.name) && new RegExp(`\\b${d.name.replace(/[$]/g, '\\$&')}\\b`).test(rest));
  const replacement: string[] = [];
  const types = stillUsed.filter(d => d.typeOnly).map(d => d.name); const values = stillUsed.filter(d => !d.typeOnly).map(d => d.name);
  if (types.length) replacement.push(`import type { ${types.join(', ')} } from "${toDest}";`);
  if (values.length) replacement.push(`import { ${values.join(', ')} } from "${toDest}";`);
  return { moved, exported, prefix, replacement, stillUsed: stillUsed.map(d => d.name), localDeps };
}
// Is the TS6133 at this line an import binding (not a local declaration)?
export async function importBindingAt(path: string, text: string, line: number, name: string): Promise<boolean> {
  if (tsModule === undefined) { try { const m: any = await import('typescript'); tsModule = m.default ?? m; } catch { tsModule = null; } }
  if (!tsModule || !parseable.test(path)) return false;
  const ts = tsModule; const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !st.importClause) continue;
    const from = sf.getLineAndCharacterOfPosition(st.getStart(sf)).line + 1; const to = sf.getLineAndCharacterOfPosition(st.getEnd()).line + 1;
    if (line < from || line > to) continue;
    const c = st.importClause;
    if (c.name?.text === name) return true;
    if (c.namedBindings && ts.isNamespaceImport(c.namedBindings) && c.namedBindings.name.text === name) return true;
    if (c.namedBindings && ts.isNamedImports(c.namedBindings) && c.namedBindings.elements.some((b: any) => b.name.text === name)) return true;
  }
  return false;
}
// Line edits that drop the named bindings from a file's import declarations: a
// declaration left empty is deleted, one still carrying other bindings is
// rewritten on one line with the rest intact.
export async function removeImportBindings(path: string, text: string, names: string[]): Promise<{ start: number; end: number; newText: string; prepend: string }[]> {
  if (tsModule === undefined) { try { const m: any = await import('typescript'); tsModule = m.default ?? m; } catch { tsModule = null; } }
  if (!tsModule || !parseable.test(path)) return [];
  const ts = tsModule; const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const drop = new Set(names); const edits: { start: number; end: number; newText: string; prepend: string }[] = [];
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !st.importClause) continue;
    const c = st.importClause;
    const def = c.name && !drop.has(c.name.text) ? c.name.text : null; const defDropped = Boolean(c.name && drop.has(c.name.text));
    const ns = c.namedBindings && ts.isNamespaceImport(c.namedBindings) ? c.namedBindings.name.text : null;
    const nsDropped = Boolean(ns && drop.has(ns));
    const named = c.namedBindings && ts.isNamedImports(c.namedBindings) ? c.namedBindings.elements : [];
    const kept = named.filter((b: any) => !drop.has(b.name.text));
    if (!defDropped && !nsDropped && kept.length === named.length) continue;
    const start = sf.getLineAndCharacterOfPosition(st.getStart(sf)).line + 1; const end = sf.getLineAndCharacterOfPosition(st.getEnd()).line + 1;
    const parts: string[] = [];
    if (def) parts.push(def);
    if (ns && !nsDropped) parts.push(`* as ${ns}`);
    if (kept.length) parts.push(`{ ${kept.map((b: any) => `${b.isTypeOnly ? 'type ' : ''}${b.propertyName ? `${b.propertyName.text} as ` : ''}${b.name.text}`).join(', ')} }`);
    const spec = st.moduleSpecifier.getText(sf);
    edits.push({ start, end, newText: parts.length ? `import ${c.isTypeOnly ? 'type ' : ''}${parts.join(', ')} from ${spec};` : '', prepend: '' });
  }
  return edits;
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
// A compact, comparable view of a check's output: error counts overall and per
// file, with the lines they name. Syntax errors are singled out because a file
// that fails to parse is not semantically checked, so a broken edit can make the
// total drop while the code is worse.
export function summarizeCheck(text: string): CheckSummary {
  let output = text;
  try { const parsed = JSON.parse(text); if (typeof parsed?.output === 'string') output = parsed.output; } catch { /* plain text */ }
  const byFile: CheckSummary['byFile'] = {}; let errors = 0; let syntax = 0; let resolution = 0;
  for (const raw of output.split('\n')) {
    const line = raw.trim();
    // Test runners report failures without the word error: TAP 'not ok', Jest 'FAIL',
    // Node's AssertionError. Summary lines ('# fail 1') are not failures.
    if (!/\berror\b/i.test(line) && !/\bAssertionError\b|\bSyntaxError\b|\bFAIL(?:ED)?\b|^not ok\b/.test(line)) continue;
    errors++;
    const isSyntax = /\bTS1\d{3}\b|SyntaxError|Unexpected token|[a-z')\]}] expected\.$/.test(line);
    if (isSyntax) syntax++;
    // A name or module the checker cannot resolve: the class of error an
    // extraction leaves behind, and the one a correct fix removes first.
    const isResolution = !isSyntax && /\bTS(?:2304|2305|2306|2307|2459|2503|2552|2613|2614|2694|2724|7016)\b|Cannot find (?:name|module)|has no exported member|is not exported|Could not find a declaration file/.test(line);
    if (isResolution) resolution++;
    const m = line.match(/^([\w@./\\-]+\.\w+)(?:\((\d+)|:(\d+))?/);
    const file = m?.[1] ?? '(other)'; const at = Number(m?.[2] ?? m?.[3] ?? 0);
    const f = byFile[file] ??= { count: 0, syntax: 0, resolution: 0, lines: [], samples: [] };
    f.count++; if (isSyntax) f.syntax++; if (isResolution) f.resolution = (f.resolution ?? 0) + 1;
    if (at && f.lines.length < 12 && !f.lines.includes(at)) f.lines.push(at);
    if (f.samples.length < 3) f.samples.push(clip(line, 140));
  }
  return { errors, syntax, resolution, byFile: Object.fromEntries(Object.entries(byFile).sort((a, b) => b[1].count - a[1].count)) };
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
// Identifiers an objective or its referenced plan names: `Writable`, SignalName,
// PROGRESS_REFRESH_MILLISECONDS, invokedAsMain(). These are deliverables.
export function namedIdentifiers(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/`([A-Za-z_$][\w$]*)(?:\(\))?`/g)) out.add(m[1]!);
  for (const m of text.matchAll(/\b([A-Z][A-Z0-9]+(?:_[A-Z0-9]+)+|[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+)\b/g)) out.add(m[1]!);
  return out;
}
export async function resolveMissingNames(root: string, checkOutput: string, editedFiles: string[], limit = 40, deliverables: Set<string> = new Set()): Promise<NameOrigin[]> {
  // name -> { file it is missing in, kind, module named by the error (if any) }
  const wanted = new Map<string, Map<string, { kind: 'missing' | 'not-exported' | 'wrong-module'; module?: string }>>();
  const add = (file: string, name: string, kind: 'missing' | 'not-exported' | 'wrong-module', module?: string) => {
    if (!wanted.has(file)) wanted.set(file, new Map()); if (!wanted.get(file)!.has(name)) wanted.get(file)!.set(name, { kind, module });
  };
  for (const m of checkOutput.matchAll(/^(\S+?)\(\d+,\d+\): error TS(?:2304|2552): Cannot find name '([^']+)'/gm)) add(m[1]!, m[2]!, 'missing');
  for (const m of checkOutput.matchAll(/^(\S+?)\(\d+,\d+\): error TS2459: Module '"([^"]+)"' declares '([^']+)' locally, but it is not exported/gm)) add(m[1]!, m[3]!, 'not-exported', m[2]!);
  for (const m of checkOutput.matchAll(/^(\S+?)\(\d+,\d+\): error TS(?:2305|2724): (?:Module )?'"([^"]+)"' has no exported member(?: named)? '([^']+)'/gm)) add(m[1]!, m[3]!, 'wrong-module', m[2]!);
  const results: NameOrigin[] = [];
  // An unused import binding is mechanical to remove, and removing the whole
  // line is the classic mistake when it also carries a used binding.
  for (const m of checkOutput.matchAll(/^(\S+?)\((\d+),\d+\): error TS6133: '([^']+)' is declared but its value is never read/gm)) {
    const reported = m[1]!; const line = Number(m[2]); const name = m[3]!;
    const inFile = editedFiles.find(f => f.endsWith(reported) || reported.endsWith(f)); if (!inFile) continue;
    let text: string; try { text = await boundedRead(await safePath(root, inFile)); } catch { continue; }
    if (await importBindingAt(inFile, text, line, name)) results.push({ name, inFile, kind: 'unused', line, note: 'unused import binding; the harness removes it' });
  }
  const headers = new Map<string, string>();
  const header = async (rel: string): Promise<string> => {
    if (!headers.has(rel)) { try { headers.set(rel, (await boundedRead(await safePath(root, rel))).split('\n').slice(0, 400).join('\n')); } catch { headers.set(rel, ''); } }
    return headers.get(rel)!;
  };
  const relPath = (from: string, to: string) => { const r = relative(resolve(root, dirname(from)), resolve(root, to)).replace(/\\/g, '/'); return r.startsWith('.') ? r : `./${r}`; };
  const ambiguous = new Map<string, string[]>();
  const declare = async (name: string, only?: string): Promise<{ file: string; line: string; exported: boolean; typeLike: boolean } | null> => {
    const r = await runCommand('rg', ['-n', '-H', '--no-heading', '--color', 'never', '--max-count', '3', '-g', '!node_modules/**', '-g', '!.leana/**', '-g', '!dist/**', '-e', `^(export )?(declare )?(type|interface|const|let|function|async function|class|enum) ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, '--', only ?? '.'], root, 10000).catch(() => null);
    const all = (r?.output.split('\n') ?? []).map(line => line.match(/^(.*?):(\d+):(.*)$/)).filter((m): m is RegExpMatchArray => Boolean(m));
    // A repository-wide first match can be an unrelated test helper. Test and
    // fixture files never stand in for source; among source files only a unique
    // declaration is usable without a known module, and ambiguity is reported.
    const isTest = (f: string) => /(^|\/)(tests?|__tests__|spec|fixtures?|test-fixtures)\/|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]*$/.test(f);
    const hits = all.filter(m => !isTest(m[1]!)).length ? all.filter(m => !isTest(m[1]!)) : all;
    const files = [...new Set(hits.map(m => m[1]!.replace(/^\.\//, '')))].sort(); // ripgrep searches in parallel; the order must not depend on it
    if (files.length > 1) { ambiguous.set(name, files.slice(0, 5)); return null; }
    const m = hits[0];
    return m ? { file: m[1]!.replace(/^\.\//, ''), line: m[2]!, exported: /^export /.test(m[3]!), typeLike: /^(export )?(declare )?(type|interface)\b/.test(m[3]!) } : null;
  };
  const locate = async (name: string, inFile: string) => {
    for (const source of editedFiles.filter(f => f !== inFile)) {
      const found = await declare(name, source); if (found) return found;
    }
    return declare(name);
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
        const d = await locate(name, inFile);
        if (d) {
          origin.declaredIn = `${d.file}:${d.line}`; origin.exported = d.exported;
          origin.importLine = `import ${d.typeLike ? 'type ' : ''}{ ${name} } from "${relPath(inFile, d.file).replace(/\.ts$/, '.js')}";`;
          origin.note = `${want.module} does not export it; replace that import with this one${d.exported ? '' : ` and add export to the declaration at ${origin.declaredIn}`}`;
        } else origin.note = `${want.module} does not export ${name} and no declaration was found in the repository`;
        results.push(origin); continue;
      }
      for (const other of editedFiles.filter(f => f !== inFile)) {
        const text = await header(other);
        if (tsModule === undefined) { const m: any = await import('typescript'); tsModule = m.default ?? m; }
        const ts = tsModule;
        const sf = ts.createSourceFile(other, text, ts.ScriptTarget.Latest, true);
        for (const st of sf.statements) {
          if (!ts.isImportDeclaration(st) || !st.importClause) continue;
          const c = st.importClause;
          const spec = st.moduleSpecifier.text;
          const module = spec.startsWith('.') ? relPath(inFile, resolve(root, dirname(other), spec)) : spec;
          const binding = c.namedBindings?.elements?.find((b: any) => b.name.text === name);
          const localDefault = c.name?.text === name;
          const localNamespace = c.namedBindings && ts.isNamespaceImport(c.namedBindings) && c.namedBindings.name.text === name;
          if (!binding && !localDefault && !localNamespace) continue;
          const imported = binding ? `{ ${binding.propertyName ? `${binding.propertyName.text} as ` : ''}${name} }` : localDefault ? name : `* as ${name}`;
          origin.importedBy = other;
          origin.importLine = `import ${c.isTypeOnly || binding?.isTypeOnly ? 'type ' : ''}${imported} from "${module}";`;
          break;
        }
        if (origin.importLine) break;
      }
      if (!origin.importLine) {
        const d = await locate(name, inFile);
        // A deliverable declared in another edited file is to be moved, not imported
        // back: importing it would satisfy the checker and defeat the extraction.
        if (d && deliverables.has(name) && editedFiles.some(f => f === d.file || f.endsWith(`/${d.file}`) || d.file.endsWith(`/${f}`))) {
          origin.declaredIn = `${d.file}:${d.line}`;
          origin.note = `named by the objective as something to extract and still declared at ${origin.declaredIn}: move that declaration into ${inFile} with move_lines (read its closing line first); do not import it back`;
          results.push(origin); if (results.length >= limit) return results; continue;
        }
        if (d) {
          origin.declaredIn = `${d.file}:${d.line}`; origin.exported = d.exported;
          origin.importLine = `import ${d.typeLike ? 'type ' : ''}{ ${name} } from "${relPath(inFile, d.file).replace(/\.ts$/, '.js')}";`;
          if (!d.exported) origin.note = `not exported yet: add export to the declaration at ${origin.declaredIn}: replace_lines edit { start: ${d.line}, end: ${d.line}, newText: "", prepend: "export " } on ${d.file}`;
        }
      }
      if (!origin.importLine) origin.note = ambiguous.has(name)
        ? `declared in several files (${ambiguous.get(name)!.join(', ')}); none is the obvious source, so import it from the intended one or declare it in ${inFile}`
        : 'no import or declaration found in the repository; the name may be a builtin or a typo';
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
        // A write is a short anchor. A retyped block is where a small model drifts,
        // and the line tools already address blocks without retyping anything.
        const anchorLines = a.oldText.split('\n').length;
        if (anchorLines > 6) {
          const first = a.oldText.split('\n')[0]!.trim(); const at = original.split('\n').findIndex(l => l.trim() === first) + 1;
          throw new Error(`oldText is ${anchorLines} lines; a write anchor is at most 6. ${at ? `That block starts at line ${at}: ` : ''}use replace_lines with line numbers (prepend "export " to export a line, newText "" to delete, the insert form to add imports) or move_lines to relocate it.`);
        }
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
      // The mechanical part of an extraction is the harness's: the moved
      // declarations are exported, the imports they use are copied from the
      // source with re-based paths, and the source imports what it still uses.
      const plan = parseable.test(a.source) ? await movePlan(a.source, original, a.start, a.end, a.destination, a.replacement ?? '') : null;
      const movedOut = plan?.moved ?? moved;
      let remaining = [...lines.slice(0, a.start - 1), ...(a.replacement ? a.replacement.split('\n') : []), ...lines.slice(a.end)].join('\n');
      if (plan?.replacement.length) {
        const norm = (l: string) => l.trim().replace(/'/g, '"').replace(/;$/, '').replace(/\s+/g, ' ');
        const have = new Set(remaining.split('\n').map(norm));
        const missing = plan.replacement.filter(l => !have.has(norm(l)));
        if (missing.length) { const rl = remaining.split('\n'); const at = await importInsertLine(a.source, remaining); rl.splice(at - 1, 0, ...missing); remaining = rl.join('\n'); }
      }
      // The worker's prefix opens a new file; an existing file takes only the derived imports.
      const prefixLines = [...(a.prefix && existing === null ? a.prefix.replace(/\n?$/, '').split('\n') : []), ...(plan?.prefix ?? [])];
      const norm2 = (l: string) => l.trim().replace(/'/g, '"').replace(/;$/, '').replace(/\s+/g, ' ');
      const seen = new Set((existing ?? '').split('\n').map(norm2));
      const prefix = prefixLines.filter(l => { const k = norm2(l); if (!k || seen.has(k)) return false; seen.add(k); return true; });
      let output: string;
      if (existing === null) output = `${prefix.length ? `${prefix.join('\n')}\n${plan ? '\n' : ''}` : ''}${movedOut}\n`;
      else {
        const el = existing.replace(/\n?$/, '\n').split('\n');
        if (prefix.length) el.splice(await importInsertLine(a.destination, existing) - 1, 0, ...prefix);
        output = `${el.join('\n').replace(/\n?$/, '\n')}\n${movedOut}\n`;
      }
      assertBalancePreserved(original, remaining, a.source);
      assertBalancePreserved(existing ?? '', output, a.destination);
      await assertParses(a.source, original, remaining);
      await assertParses(a.destination, existing ?? '', output);
      if (existing !== null) assertNoBulkDuplication(existing, [...prefix, ...movedOut.split('\n')], a.destination, false);
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
        (plan ? `Exported ${plan.exported.length ? plan.exported.join(', ') : 'nothing new'}; copied ${plan.prefix.length} import line(s) into the destination; ${plan.replacement.length ? `${a.source} now imports ${plan.stillUsed.join(', ')} from the destination` : `${a.source} no longer referenced the moved names`}.` +
          (plan.localDeps.length ? ` The moved code also uses ${plan.localDeps.map(d => `${d.name} (declared at ${a.source}:${d.line}, not exported)`).join(', ')}: export those in ${a.source} and import them in ${a.destination}, or move them too; the check reports them next.` : '') +
          ' The check runs next.'
          : a.replacement ? 'Run the focused check next; its errors list any imports the moved code still needs in the destination.'
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
