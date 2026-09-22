import { createHash, randomUUID } from 'node:crypto';
import { open, readFile, realpath, rename, stat, unlink, mkdir, readdir } from 'node:fs/promises';
import { dirname, isAbsolute, posix, relative, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { builtinModules } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { CheckSummary, Config, NameOrigin, Route, SourceEvidence, ToolResult } from './types.js';
import { clip } from './context.js';
export const hash = (text: string | Buffer): string => createHash('sha256').update(text).digest('hex');
// A write whose target was never read, or was read before it changed. Only this
// failure class requires a fresh read; other edit failures are argument mistakes.
export class StaleWriteError extends Error {}
// Did a check get worse after edits? Any in-scope increase, or new in-scope syntax
// errors without a net decrease, is a regression and is rolled back with no vote;
// a structural move is judged on syntax only. Anything else is committed.
// Only edits of files that existed are judged here: a created file is never
// rolled back (its errors are work for the fixer, not grounds to discard a
// generation), so callers pass the edited paths as the scope.
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
  // Fewer errors in the files the transaction edited is progress whatever
  // appears elsewhere: once its own errors are fixed the check reaches a later
  // stage (a bundler after the type checker) or type-checks other files against
  // it, and what it reports there is work, not this edit's regression.
  const own = (s: CheckSummary) => Object.entries(s.byFile).reduce((n, [f, v]) => n + (f !== '(other)' && matches(f) ? v.count : 0), 0);
  if (attributed && own(after) < own(before)) return 'fine';
  // Fewer syntax errors is progress whatever the total does: a file that did
  // not parse was not checked at all, so the errors its repair surfaces are
  // the ones that were always there, now visible.
  if (a.syntax < b.syntax) return 'fine';
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
// What an extraction needs beyond cutting and pasting, computed from the
// TypeScript AST: export on the moved top-level declarations, the source's
// import lines that the block uses (re-based to the destination), the import the
// source needs for names it still references, and the source's own top-level
// declarations the block depends on (which need an export or a move).
export async function movePlan(source: string, text: string, start: number, end: number, destination: string, replacementText = ''): Promise<{
  moved: string; declared: string[]; exported: string[]; prefix: string[]; replacement: string[]; stillUsed: string[]; localDeps: { name: string; line: number }[];
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
  // The parser, not a regex over stripped text: one unbalanced quote in a large
  // file would otherwise blank everything after it.
  const restUsed = new Set<string>();
  const rf = ts.createSourceFile(source, restRaw, ts.ScriptTarget.Latest, true);
  const walkRest = (n: any) => { if (ts.isIdentifier(n)) { const p = n.parent; const isProp = p && ((ts.isPropertyAccessExpression(p) && p.name === n) || (ts.isPropertyAssignment(p) && p.name === n) || (ts.isQualifiedName(p) && p.right === n)); if (!isProp) restUsed.add(n.text); } ts.forEachChild(n, walkRest); };
  walkRest(rf);
  const toDest = (() => { const r = relative(dirname(source), destination).replace(/\\/g, '/').replace(/\.[cm]?ts$/, '.js'); return r.startsWith('.') ? r : `./${r}`; })();
  // Names the source (or the worker's own replacement) already imports from the destination.
  const imported = new Set<string>();
  for (const m of restRaw.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+["']([^"']+)["']/g)) if (m[2] === toDest) for (const part of m[1]!.split(',')) { const local = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/).pop()!.trim(); if (local) imported.add(local); }
  const stillUsed = declared.filter(d => !imported.has(d.name) && restUsed.has(d.name));
  const replacement: string[] = [];
  const types = stillUsed.filter(d => d.typeOnly).map(d => d.name); const values = stillUsed.filter(d => !d.typeOnly).map(d => d.name);
  if (types.length) replacement.push(`import type { ${types.join(', ')} } from "${toDest}";`);
  if (values.length) replacement.push(`import { ${values.join(', ')} } from "${toDest}";`);
  return { moved, declared: declared.map(d => d.name), exported, prefix, replacement, stillUsed: stillUsed.map(d => d.name), localDeps };
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
export async function removeImportBindings(path: string, text: string, names: string[], atLine: Record<string, number> = {}): Promise<{ start: number; end: number; newText: string; prepend: string }[]> {
  if (tsModule === undefined) { try { const m: any = await import('typescript'); tsModule = m.default ?? m; } catch { tsModule = null; } }
  if (!tsModule || !parseable.test(path)) return [];
  const ts = tsModule; const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const edits: { start: number; end: number; newText: string; prepend: string }[] = [];
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !st.importClause) continue;
    const c = st.importClause;
    const stStart = sf.getLineAndCharacterOfPosition(st.getStart(sf)).line + 1; const stEnd = sf.getLineAndCharacterOfPosition(st.getEnd()).line + 1;
    // A name restricted to a line is dropped only from the declaration spanning it.
    const drop = new Set(names.filter(n => atLine[n] === undefined || (atLine[n]! >= stStart && atLine[n]! <= stEnd)));
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
// Files declaring a name at top level, test and fixture files excluded.
export async function declarationFiles(root: string, name: string): Promise<string[]> {
  const r = await runCommand('rg', ['-l', '--color', 'never', '-g', '!node_modules/**', '-g', '!.leana/**', '-g', '!dist/**', '-g', '*.{ts,tsx,mts,cts,js,mjs,cjs}', '-e', `^(export )?(declare )?(type|interface|const|let|function|async function|class|enum) ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, '--', '.'], root, 10000).catch(() => null);
  const isTest = (f: string) => /(^|\/)(tests?|__tests__|spec|fixtures?|test-fixtures|tests-ts)\/|\.(test|spec)\.[cm]?[jt]sx?$/.test(f);
  return (r?.output.split('\n') ?? []).map(l => l.trim().replace(/^\.\//, '')).filter(f => f && !isTest(f));
}
// The last line of the top-level statement that starts at (or spans) a line.
export async function declarationEnd(root: string, file: string, line: number): Promise<number | null> {
  if (tsModule === undefined) { try { const m: any = await import('typescript'); tsModule = m.default ?? m; } catch { tsModule = null; } }
  if (!tsModule || !parseable.test(file)) return null;
  let text: string; try { text = await boundedRead(await safePath(root, file)); } catch { return null; }
  const ts = tsModule; const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  for (const st of sf.statements) {
    const from = sf.getLineAndCharacterOfPosition(st.getStart(sf)).line + 1; const to = sf.getLineAndCharacterOfPosition(st.getEnd()).line + 1;
    if (line >= from && line <= to) return to;
  }
  return null;
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
export async function relativeImports(path: string, text: string): Promise<{ spec: string; names: string[]; typeOnly?: boolean }[]> {
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
    if (spec && /^\.\.?\//.test(spec)) out.push({ spec, names, ...(typeOnly ? { typeOnly: true } : {}) });
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
// The import bindings of a file: local name and module.
export async function importBindings(path: string, text: string): Promise<{ name: string; from: string; typeOnly: boolean }[]> {
  const out: { name: string; from: string; typeOnly: boolean }[] = [];
  if (tsModule === undefined) { try { const m: any = await import('typescript'); tsModule = m.default ?? m; } catch { tsModule = null; } }
  if (!tsModule || !parseable.test(path)) return out;
  const ts = tsModule; const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !st.importClause) continue;
    const c = st.importClause; const from = st.moduleSpecifier.text;
    if (c.name) out.push({ name: c.name.text, from, typeOnly: Boolean(c.isTypeOnly) });
    if (c.namedBindings && ts.isNamespaceImport(c.namedBindings)) out.push({ name: c.namedBindings.name.text, from, typeOnly: Boolean(c.isTypeOnly) });
    if (c.namedBindings && ts.isNamedImports(c.namedBindings)) for (const b of c.namedBindings.elements) out.push({ name: b.name.text, from, typeOnly: Boolean(c.isTypeOnly || b.isTypeOnly) });
  }
  return out;
}
// A configured check that cannot run here: its directory is missing or its
// executable is not installed. Such a command is dropped, not retried forever.
export async function checkUnusable(root: string, command: string): Promise<string | null> {
  const dir = command.match(/(?:--dir|-C|--prefix)\s+(\S+)/)?.[1] ?? command.match(/^\s*cd\s+(\S+)/)?.[1];
  if (dir) { try { await stat(resolve(root, dir)); } catch { return `its directory ${dir} does not exist in this repository`; } }
  const exe = command.replace(/^\s*cd\s+\S+\s*(?:&&|;)\s*/, '').trim().split(/\s+/)[0] ?? '';
  if (exe && !exe.includes('/')) { const r = await runCommand('bash', ['--noprofile', '--norc', '-c', `command -v -- ${JSON.stringify(exe)}`], root, 5000).catch(() => null); if (!r || r.code !== 0) return `${exe} is not installed on this machine`; }
  // A script that is only `tsc` against a solution tsconfig checks no file.
  let body = command;
  const script = command.match(/^\s*(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?([\w:-]+)\s*$/)?.[1];
  if (script) { try { const pkg = JSON.parse(await boundedRead(await safePath(root, 'package.json'))); if (typeof pkg?.scripts?.[script] === 'string') body = pkg.scripts[script]; } catch { /* keep */ } }
  if (/^\s*(?:npx\s+)?tsc\b[^&|;]*$/.test(body) && !/(?:^|\s)(?:-p|--project|-b|--build)\b/.test(body)) {
    const refs = await solutionTsconfigReferences(root);
    if (refs) return `it checks no source files: tsconfig.json is a solution file (references ${refs.join(', ')}, no include); use tsc -p ${refs[0]}`;
  }
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
export function missingDependencies(output: string): boolean {
  return /command not found|Cannot find module|Cannot find package|ERR_MODULE_NOT_FOUND|ModuleNotFoundError|No module named|is not recognized as|not found: /i.test(output);
}
export async function installCommand(root: string, dir = '.', force = false): Promise<string | null> {
  const has = async (p: string) => { try { await stat(resolve(root, dir, p)); return true; } catch { return false; } };
  if (await has('package.json')) {
    if (!force && await has('node_modules')) return null;
    const cmd = await has('pnpm-lock.yaml') ? 'pnpm install --frozen-lockfile' : await has('yarn.lock') ? 'yarn install --frozen-lockfile' : await has('bun.lockb') ? 'bun install' : await has('package-lock.json') ? 'npm ci --no-audit --no-fund' : 'npm install --no-audit --no-fund';
    return dir === '.' ? cmd : `cd ${dir} && ${cmd}`;
  }
  if (await has('requirements.txt')) return `${dir === '.' ? '' : `cd ${dir} && `}python3 -m pip install -r requirements.txt`;
  if (await has('pyproject.toml')) return `${dir === '.' ? '' : `cd ${dir} && `}python3 -m pip install -e .`;
  return null;
}
// A bare package the check cannot find that a file this session wrote imports:
// installing it is mechanical (the manager and its flag are known from the
// lockfile), never a manifest edit for the worker to generate. Relative and
// built-in specifiers, packages the manifest already declares, and names no
// written file imports are not candidates.
export function missingPackages(summary: CheckSummary, importers: Record<string, string>, installed: string[]): { name: string; importers: string[] }[] {
  const have = new Set(installed.map(i => i.replace(/@[^@]*$/, '')));
  const builtin = new Set(builtinModules);
  const out = new Map<string, Set<string>>();
  for (const v of Object.values(summary.byFile)) for (const d of v.diagnostics?.length ? v.diagnostics : v.samples) {
    for (const m of d.matchAll(/Cannot find (?:package|module) '([^'\s]+)'|Failed to resolve import "([^"\s]+)"|Cannot find package "([^"\s]+)"/g)) {
      const spec = m[1] ?? m[2] ?? m[3] ?? '';
      if (!spec || /^[./#]/.test(spec) || spec.startsWith('node:') || builtin.has(spec)) continue;
      const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]!;
      if (!name || have.has(name)) continue;
      const users = Object.entries(importers).filter(([, text]) => new RegExp(`(?:from\\s*|import\\s*|require\\(\\s*)['"]${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:/[^'"]*)?['"]`).test(text)).map(([p]) => p);
      if (!users.length) continue;
      const set = out.get(name) ?? new Set<string>(); for (const u of users) set.add(u); out.set(name, set);
    }
  }
  return [...out.entries()].map(([name, users]) => ({ name, importers: [...users] }));
}
// The command that adds packages to the manifest and installs them, by the
// package manager the lockfile implies.
export async function addPackagesCommand(root: string, names: string[], dev: boolean): Promise<string> {
  const has = async (p: string) => { try { await stat(resolve(root, p)); return true; } catch { return false; } };
  const list = names.map(n => `'${n}'`).join(' ');
  if (await has('pnpm-lock.yaml')) return `pnpm add ${dev ? '-D ' : ''}${list}`;
  if (await has('yarn.lock')) return `yarn add ${dev ? '-D ' : ''}${list}`;
  if (await has('bun.lockb') || await has('bun.lock')) return `bun add ${dev ? '-d ' : ''}${list}`;
  return `npm install ${dev ? '--save-dev ' : ''}--no-audit --no-fund ${list}`;
}
// A shell command that only reads is an inspection, not an action.
export function readOnlyCommand(command: string): boolean {
  const parts = command.split(/\s*(?:&&|\|\||;|\|)\s*/).map(p => p.trim()).filter(Boolean);
  return parts.length > 0 && parts.every(p => /^(?:ls|cat|head|tail|grep|rg|find|echo|pwd|wc|stat|tree|file|which|type|printf|du|df|env|git (?:status|log|diff|show|ls-files)|node -e ["']require\(['"]fs['"]\)\.readFileSync)/.test(p));
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
// Rewrite `name` in the import declaration spanning `line` as `actual as name`.
export async function aliasImportBinding(path: string, text: string, name: string, actual: string, line: number): Promise<{ start: number; end: number; newText: string; prepend: string } | null> {
  if (tsModule === undefined) { try { const m: any = await import('typescript'); tsModule = m.default ?? m; } catch { tsModule = null; } }
  if (!tsModule || !parseable.test(path)) return null;
  const ts = tsModule; const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !st.importClause?.namedBindings || !ts.isNamedImports(st.importClause.namedBindings)) continue;
    const start = sf.getLineAndCharacterOfPosition(st.getStart(sf)).line + 1; const end = sf.getLineAndCharacterOfPosition(st.getEnd()).line + 1;
    if (line < start || line > end) continue;
    const c = st.importClause; const parts = c.namedBindings.elements.map((b: any) => b.name.text === name && !b.propertyName ? `${b.isTypeOnly ? 'type ' : ''}${actual} as ${name}` : `${b.isTypeOnly ? 'type ' : ''}${b.propertyName ? `${b.propertyName.text} as ` : ''}${b.name.text}`);
    if (!c.namedBindings.elements.some((b: any) => b.name.text === name && !b.propertyName)) return null;
    return { start, end, newText: `import ${c.isTypeOnly ? 'type ' : ''}${c.name ? `${c.name.text}, ` : ''}{ ${parts.join(', ')} } from ${st.moduleSpecifier.getText(sf)};`, prepend: '' };
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
export function summarizeCheck(text: string, root?: string): CheckSummary {
  let output = text;
  try { const parsed = JSON.parse(text); if (typeof parsed?.output === 'string') output = parsed.output; } catch { /* plain text */ }
  const byFile: CheckSummary['byFile'] = {}; let errors = 0; let syntax = 0; let resolution = 0;
  // Test runners report failures without the word error: TAP 'not ok', Jest 'FAIL',
  // Node's AssertionError. Summary lines ('# fail 1') are not failures.
  // A bundler's heading ("error during build:") introduces the diagnostics that follow; it is not one.
  const isHeading = (line: string) => /^errors? (?:during|while|in) [\w -]+:$/i.test(line);
  const isError = (line: string) => !isHeading(line) && (/\berror\b/i.test(line) || /\bAssertionError\b|\bSyntaxError\b|\bFAIL(?:ED)?\b|^not ok\b/.test(line));
  // A diagnostic is an error line with its continuation lines (indented, as tsc
  // prints the property that does not exist, or a bundler the file and line).
  // A heading introduces the line that follows it, whatever that line says; a
  // heading nothing follows is the diagnostic itself.
  const blocks: { head: string; tail: string[] }[] = []; let current: { head: string; tail: string[] } | null = null; let heading: string | null = null;
  for (const raw of output.split('\n')) {
    const line = raw.trim();
    if (isHeading(line)) { if (heading) blocks.push({ head: heading, tail: [] }); heading = line; current = null; continue; }
    if (isError(line) || (heading && line)) { current = { head: line, tail: [] }; blocks.push(current); heading = null; continue; }
    // Continuations are indented, a code frame's gutter lines ("10 |  <p>", "   |  ^^^"), or a bundler's "file: path".
    if (current && line && (/^\s+\S/.test(raw) || /^\s*\d*\s*\|/.test(raw) || /^file:\s/.test(raw))) current.tail.push(raw.replace(/\s+$/, '')); else current = null;
  }
  if (heading) blocks.push({ head: heading, tail: [] });
  const whole = (s: string) => s.length > 900 ? `${s.slice(0, 900)} …` : s;
  const prefix = root ? `${root.replace(/\/$/, '')}/` : null;
  for (const { head, tail } of blocks) {
    errors++;
    const isSyntax = /\bTS1\d{3}\b|SyntaxError|Unexpected token|[a-z')\]}] expected\.$/.test(head);
    if (isSyntax) syntax++;
    // A name or module the checker cannot resolve: the class of error an
    // extraction leaves behind, and the one a correct fix removes first.
    const isResolution = !isSyntax && /\bTS(?:2304|2305|2306|2307|2459|2503|2552|2613|2614|2694|2724|7016)\b|Cannot find (?:name|module)|has no exported member|is not exported|Could not find a declaration file/.test(head);
    if (isResolution) resolution++;
    const m = head.match(/^([\w@./\\-]+\.\w+)(?:\((\d+)|:(\d+))?/);
    let file = m?.[1] ?? '(other)'; let at = Number(m?.[2] ?? m?.[3] ?? 0);
    // A tool that names the file only on a later line (a bundler's "at /abs/path:10:7",
    // "file: /abs/path", rustc's "--> path:10:7") still attributes the error, relative
    // to the repository when the path is absolute; a path in node_modules is not the file.
    if (file === '(other)') for (const t of tail) {
      const n = t.match(/^\s*(?:at\s+|file:\s+|-->\s+)((?:\/|\.{1,2}\/)?[\w@./\\-]+\.\w+)(?::(\d+)(?::\d+)?)?\s*$/);
      if (!n || n[1]!.includes('/node_modules/') || n[1]!.startsWith('file:')) continue;
      let p = n[1]!; if (p.startsWith('/')) { if (prefix && p.startsWith(prefix)) p = p.slice(prefix.length); else continue; }
      file = p.replace(/^\.\//, ''); at = Number(n[2] ?? 0); break;
    }
    const f = byFile[file] ??= { count: 0, syntax: 0, resolution: 0, lines: [], samples: [] };
    f.count++; if (isSyntax) f.syntax++; if (isResolution) f.resolution = (f.resolution ?? 0) + 1;
    if (at && f.lines.length < 12 && !f.lines.includes(at)) f.lines.push(at);
    if (f.samples.length < 3) f.samples.push(clip(head, 140));
    f.diagnostics ??= [];
    if (f.diagnostics.length < 6) f.diagnostics.push(whole([head, ...tail].join('\n')));
  }
  return { errors, syntax, resolution, byFile: Object.fromEntries(Object.entries(byFile).sort((a, b) => b[1].count - a[1].count)) };
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
export async function resolveMissingNames(root: string, checkOutput: string, editedFiles: string[], limit = 40, deliverables: Set<string> = new Set(), direction: { source: string; destination: string } | null = null): Promise<NameOrigin[]> {
  // name -> { file it is missing in, kind, module named by the error (if any) }
  const results: NameOrigin[] = [];
  const wanted = new Map<string, Map<string, { kind: 'missing' | 'not-exported' | 'wrong-module'; module?: string }>>();
  const add = (file: string, name: string, kind: 'missing' | 'not-exported' | 'wrong-module', module?: string) => {
    if (!wanted.has(file)) wanted.set(file, new Map()); if (!wanted.get(file)!.has(name)) wanted.get(file)!.set(name, { kind, module });
  };
  for (const m of checkOutput.matchAll(/^(\S+?)\(\d+,\d+\): error TS(?:2304|2552): Cannot find name '([^']+)'/gm)) add(m[1]!, m[2]!, 'missing');
  // A relative module the file cannot find, when a file of that name exists
  // once in the repository at another relative path: the specifier is
  // rewritten, mechanically. A module nobody has yet is left to the ledger.
  for (const m of checkOutput.matchAll(/^(\S+?)\((\d+),\d+\): error TS2307: Cannot find module '(\.[^']+)'/gm)) {
    const inFile = editedFiles.find(f => f.endsWith(m[1]!) || m[1]!.endsWith(f)); const spec = m[3]!; if (!inFile) continue;
    if (results.some(r => r.kind === 'respec' && r.inFile === inFile && r.name === spec)) continue;
    const exists = async (p: string) => { try { await stat(await safePath(root, p)); return true; } catch { return false; } };
    let found = false; for (const c of importCandidates(inFile, spec)) if (await exists(c)) { found = true; break; }
    if (found) continue;
    const base = spec.replace(/\/$/, '').split('/').pop()!.replace(/\.[cm]?[jt]sx?$/, '');
    if (!/^[\w.-]+$/.test(base)) continue;
    const r = await runCommand('rg', ['--files', '-g', '!node_modules/**', '-g', '!.leana/**', '-g', '!dist/**', '-g', `**/${base}.{ts,tsx,js,jsx,mts,cts,mjs,cjs}`, '-g', `**/${base}/index.{ts,tsx,js,jsx}`, '--', '.'], root, 10000).catch(() => null);
    const files = [...new Set((r?.output.split('\n') ?? []).map(f => f.trim().replace(/^\.\//, '')).filter(Boolean))].sort();
    if (files.length !== 1) continue;
    const target = files[0]!; const rel = relative(dirname(inFile), target.replace(/\/index\.[cm]?[jt]sx?$/, '')).replace(/\\/g, '/').replace(/\.(tsx?|jsx?|mts|cts|mjs|cjs)$/, '');
    const keepExt = /\.[cm]?[jt]sx?$/.test(spec) ? target.slice(target.lastIndexOf('.')).replace(/\.tsx?$/, '.js') : '';
    const to = (rel.startsWith('.') ? rel : `./${rel}`) + keepExt;
    if (to === spec) continue;
    results.push({ name: spec, inFile, kind: 'respec', line: Number(m[2]), importLine: to, note: `${spec} does not resolve from ${inFile}; ${target} does, so the harness rewrites the specifier to ${to}` });
  }
  // React 19's types declare JSX under the react module, not globally: a
  // file that names JSX.Element imports the namespace, mechanically.
  for (const m of checkOutput.matchAll(/^(\S+?)\((\d+),\d+\): error TS2503: Cannot find namespace 'JSX'/gm)) {
    const inFile = editedFiles.find(f => f.endsWith(m[1]!) || m[1]!.endsWith(f)); if (!inFile || results.some(r => r.name === 'JSX' && r.inFile === inFile)) continue;
    results.push({ name: 'JSX', inFile, importLine: 'import type { JSX } from "react";', line: Number(m[2]), note: 'JSX is a namespace of the react module; the harness imports it' });
  }
  for (const m of checkOutput.matchAll(/^(\S+?)\(\d+,\d+\): error TS2459: Module '"([^"]+)"' declares '([^']+)' locally, but it is not exported/gm)) add(m[1]!, m[3]!, 'not-exported', m[2]!);
  for (const m of checkOutput.matchAll(/^(\S+?)\((\d+),\d+\): error TS(?:2305|2724): (?:Module )?'"([^"]+)"' has no exported member(?: named)? '([^']+)'\.(?: Did you mean '([^']+)'\?)?/gm)) {
    // The checker names the export that exists: alias the import to it, usage untouched.
    if (m[5]) { const inFile = editedFiles.find(f => f.endsWith(m[1]!) || m[1]!.endsWith(f)); if (inFile) { results.push({ name: m[4]!, inFile, kind: 'alias', line: Number(m[2]), note: `${m[3]} exports ${m[5]}, not ${m[4]}; the harness imports it as ${m[5]} as ${m[4]}`, importLine: m[5] }); continue; } }
    add(m[1]!, m[4]!, 'wrong-module', m[3]!);
  }
  // An unused import binding is mechanical to remove, and removing the whole
  // line is the classic mistake when it also carries a used binding.
  for (const m of checkOutput.matchAll(/^(\S+?)\((\d+),\d+\): error TS(?:6133|6196): '([^']+)' is declared but (?:its value is never read|never used)/gm)) {
    const reported = m[1]!; const line = Number(m[2]); const name = m[3]!;
    const inFile = editedFiles.find(f => f.endsWith(reported) || reported.endsWith(f)); if (!inFile) continue;
    let text: string; try { text = await boundedRead(await safePath(root, inFile)); } catch { continue; }
    if (await importBindingAt(inFile, text, line, name)) results.push({ name, inFile, kind: 'unused', line, note: 'unused import binding; the harness removes it' });
  }
  // A binding imported twice (TS2300 on import lines) keeps its first import; an
  // import that conflicts with a local declaration (TS2440) goes.
  const dup = new Map<string, { inFile: string; name: string; lines: number[] }>();
  for (const m of checkOutput.matchAll(/^(\S+?)\((\d+),\d+\): error TS2300: Duplicate identifier '([^']+)'/gm)) {
    const inFile = editedFiles.find(f => f.endsWith(m[1]!) || m[1]!.endsWith(f)); if (!inFile) continue;
    const key = `${inFile}:${m[3]}`; const d = dup.get(key) ?? { inFile, name: m[3]!, lines: [] }; d.lines.push(Number(m[2])); dup.set(key, d);
  }
  for (const d of dup.values()) {
    let text: string; try { text = await boundedRead(await safePath(root, d.inFile)); } catch { continue; }
    const importLines: number[] = []; for (const l of d.lines) if (await importBindingAt(d.inFile, text, l, d.name)) importLines.push(l);
    if (importLines.length >= 2) for (const l of importLines.sort((a, b) => a - b).slice(1)) results.push({ name: d.name, inFile: d.inFile, kind: 'unused', line: l, note: 'imported twice; the harness removes the later binding' });
  }
  for (const m of checkOutput.matchAll(/^(\S+?)\((\d+),\d+\): error TS2440: Import declaration conflicts with local declaration of '([^']+)'/gm)) {
    const inFile = editedFiles.find(f => f.endsWith(m[1]!) || m[1]!.endsWith(f)); if (!inFile) continue;
    let text: string; try { text = await boundedRead(await safePath(root, inFile)); } catch { continue; }
    if (await importBindingAt(inFile, text, Number(m[2]), m[3]!)) results.push({ name: m[3]!, inFile, kind: 'unused', line: Number(m[2]), note: 'imported and declared locally; the harness removes the import' });
  }
  const headers = new Map<string, string>();
  const header = async (rel: string): Promise<string> => {
    if (!headers.has(rel)) { try { headers.set(rel, (await boundedRead(await safePath(root, rel))).split('\n').slice(0, 400).join('\n')); } catch { headers.set(rel, ''); } }
    return headers.get(rel)!;
  };
  const relPath = (from: string, to: string) => { const r = relative(resolve(root, dirname(from)), resolve(root, to)).replace(/\\/g, '/'); return r.startsWith('.') ? r : `./${r}`; };
  const ambiguous = new Map<string, string[]>();
  const declare = async (name: string, only?: string): Promise<{ file: string; line: string; exported: boolean; typeLike: boolean; endLine: number | null } | null> => {
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
    if (!m) return null;
    const file = m[1]!.replace(/^\.\//, '');
    return { file, line: m[2]!, exported: /^export /.test(m[3]!), typeLike: /^(export )?(declare )?(type|interface)\b/.test(m[3]!), endLine: await declarationEnd(root, file, Number(m[2])) };
  };
  // A deliverable declared in an edited file is moved, not imported back or exported:
  // importing it would satisfy the checker and defeat the extraction.
  const toMove = (name: string, d: { file: string; line: string; endLine: number | null } | null, inFile: string): NameOrigin | null => {
    if (!d || !deliverables.has(name) || !editedFiles.some(f => f === d.file || f.endsWith(`/${d.file}`) || d.file.endsWith(`/${f}`)) || d.file === inFile) return null;
    // With a known direction, only source -> destination is a move; a name the
    // source now lacks is imported from the destination like any other.
    const same = (a: string, b: string) => a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
    if (direction && !(same(d.file, direction.source) && same(inFile, direction.destination))) return null;
    const origin: NameOrigin = { name, inFile, kind: 'move', declaredIn: `${d.file}:${d.line}` };
    if (d.endLine) { origin.move = { source: d.file, start: Number(d.line), end: d.endLine }; origin.note = `named by the objective as something to extract and still declared in ${d.file} at lines ${d.line}-${d.endLine}; the harness moves it into ${inFile}`; }
    else origin.note = `named by the objective as something to extract and still declared at ${origin.declaredIn}: move that declaration into ${inFile} with move_lines (read its closing line first); do not import it back`;
    return origin;
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
        const mv = toMove(name, d, inFile); if (mv) { results.push(mv); if (results.length >= limit) return results; continue; }
        origin.declaredIn = d ? `${d.file}:${d.line}` : target; origin.exported = false;
        origin.note = `already imported from ${want.module}; add the export keyword to the declaration at ${origin.declaredIn}: replace_lines edit { start: ${d?.line ?? '?'}, end: ${d?.line ?? '?'}, newText: "", prepend: "export " } on ${d?.file ?? target}`;
        results.push(origin); continue;
      }
      if (want.kind === 'wrong-module') {
        const d = await locate(name, inFile);
        // An importer the session never touched lost a name to a move: the edited
        // module it imports from re-exports the name from where it now lives.
        const importerEdited = editedFiles.some(f => f === inFile || f.endsWith(`/${inFile}`) || inFile.endsWith(`/${f}`));
        if (!importerEdited && want.module && d?.exported) {
          const moduleTs = relative(root, resolve(root, dirname(inFile), want.module)).replace(/\\/g, '/').replace(/\.js$/, '.ts');
          const target = editedFiles.find(f => f === moduleTs || f.endsWith(`/${moduleTs}`) || moduleTs.endsWith(`/${f}`));
          if (target && target !== d.file && !d.file.endsWith(`/${target}`)) {
            if (results.some(r => r.kind === 'reexport' && r.name === name && r.inFile === target)) continue;
            results.push({ name, inFile: target, kind: 'reexport', declaredIn: `${d.file}:${d.line}`, exported: true, importLine: `export { ${name} } from "${relPath(target, d.file).replace(/\.ts$/, '.js')}";`, note: `${inFile} imports ${name} from ${target}, which no longer declares it; the harness re-exports it from ${d.file}` });
            if (results.length >= limit) return results; continue;
          }
        }
        const mv = toMove(name, d, inFile); if (mv) { results.push(mv); if (results.length >= limit) return results; continue; }
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
        const mv = toMove(name, d, inFile); if (mv) { results.push(mv); if (results.length >= limit) return results; continue; }
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
    if (route === 'create_file') {
      // Creation has one meaning: a file that does not exist gets this content.
      // The content is validated after it lands, never refused for its shape:
      // a parse problem is reported for the harness's own repair, and the
      // relative imports are reported so the deliverables they imply can be added.
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
        text: `Created ${a.path} (${content.split('\n').length} lines); sha256=${h}.${parseErrors.length ? ` It does not parse yet (${parseErrors.join('; ')}); the harness repairs that region next.` : ''}${imports.length ? ` Imports ${imports.map(i => i.spec).join(', ')}.` : ''}` };
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
      assertBalancePreserved(original, updated, a.path);
      await assertParses(a.path, original, updated);
      assertNoBulkDuplication(original.replace(a.oldText, ''), kept, a.path);
      const temp = `${path}.leana-${randomUUID()}.tmp`;
      try {
        const h = await open(temp, 'wx', (await stat(path)).mode & 0o777);
        try { await h.writeFile(updated); } finally { await h.close(); }
        if (hash(await boundedRead(path)) !== a.expectedHash) throw new StaleWriteError('File changed while preparing edit; read it again');
        await rename(temp, path);
      } finally { await unlink(temp).catch(() => {}); }
      const updatedHash = hash(updated);
      const anchorLines = String(a.oldText).split('\n').length;
      const notes = [dropped.length ? `Dropped ${dropped.length} import line(s) the file already had.` : '', anchorLines > 6 ? `The anchor was ${anchorLines} lines; replace_lines addresses a block by line number without retyping it.` : ''].filter(Boolean).join(' ');
      return { ok: true, changed: [a.path], hashes: { [a.path]: updatedHash }, snapshots, text: `Updated ${a.path}; sha256=${updatedHash}.${notes ? ` ${notes}` : ''} Run focused validation.` };
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
      const note = [skipped.length ? ` Skipped ${skipped.length} unchanged range(s): ${skipped.map(e => `${e.start}..${e.end}`).reverse().join(', ')}.` : '',
        droppedImports.length ? ` Dropped ${droppedImports.length} import line(s) the file already had.` : '', retypes.length ? ` Note: ${retypes.join('; ')}.` : ''].join('');
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
      // Appending does not depend on the destination's content: a stale destination
      // hash is noted, not refused, as long as the source (whose lines are cut) is current.
      const destinationStale = existing !== null && hash(existing) !== a.destinationHash;
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
      // Dedupe at the binding level: a name the destination already imports, under
      // whatever line text, is not imported again; a line left empty is dropped.
      const already = new Set((existing !== null ? await importBindings(a.destination, existing) : []).map(b => b.name));
      const declaredNow = plan ? new Set(plan.declared) : new Set<string>();
      const trimImport = (l: string): string | null => {
        const m = l.match(/^(\s*import\s+)(type\s+)?\{([^}]*)\}(\s+from\s+.*)$/); if (!m) return l;
        const kept = m[3]!.split(',').map(x => x.trim()).filter(Boolean).filter(x => { const local = x.replace(/^type\s+/, '').split(/\s+as\s+/).pop()!.trim(); if (already.has(local) || declaredNow.has(local)) return false; already.add(local); return true; });
        return kept.length ? `${m[1]}${m[2] ?? ''}{ ${kept.join(', ')} }${m[4]}` : null;
      };
      const prefix = prefixLines.map(trimImport).filter((l): l is string => l !== null).filter(l => { const k = norm2(l); if (!k || seen.has(k)) return false; seen.add(k); return true; });
      let output: string;
      if (existing === null) output = `${prefix.length ? `${prefix.join('\n')}\n${plan ? '\n' : ''}` : ''}${movedOut}\n`;
      else {
        // An import in the destination of a name the move now declares there would conflict: drop it first.
        let base = existing;
        const conflicting = plan ? plan.declared.filter(n => already.has(n)) : [];
        if (conflicting.length) { const bl = base.split('\n'); for (const e of (await removeImportBindings(a.destination, base, conflicting)).sort((x, y) => y.start - x.start)) bl.splice(e.start - 1, e.end - e.start + 1, ...(e.newText ? [e.newText] : [])); base = bl.join('\n'); }
        const el = base.replace(/\n?$/, '\n').split('\n');
        if (prefix.length) el.splice(await importInsertLine(a.destination, base) - 1, 0, ...prefix);
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
        (destinationStale ? `(destinationHash was stale; the current ${a.destination} was appended to.) ` : '') +
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

// Tailwind v4 emits utility classes only through its Vite or PostCSS plugin: a
// stylesheet that imports tailwindcss in a Vite project whose config does not
// load @tailwindcss/vite builds without error and styles nothing. The wiring is
// mechanical: the import and the plugin entry, added to the config as text.
export function wireTailwindVite(config: string): string | null {
  if (/@tailwindcss\/vite/.test(config)) return null;
  const quote = /from\s+"/.test(config) ? '"' : "'"; const semi = /;\s*$/m.test(config) ? ';' : '';
  const line = `import tailwindcss from ${quote}@tailwindcss/vite${quote}${semi}`;
  const lines = config.split('\n'); let last = -1;
  for (let i = 0; i < lines.length; i++) if (/^import\b/.test(lines[i]!)) last = i;
  lines.splice(last + 1, 0, line);
  let text = lines.join('\n');
  if (/plugins\s*:\s*\[\s*\]/.test(text)) text = text.replace(/plugins\s*:\s*\[\s*\]/, 'plugins: [tailwindcss()]');
  else if (/plugins\s*:\s*\[/.test(text)) text = text.replace(/plugins\s*:\s*\[/, m => `${m}tailwindcss(), `);
  else if (/defineConfig\(\s*\{/.test(text)) text = text.replace(/defineConfig\(\s*\{/, m => `${m}\n  plugins: [tailwindcss()],`);
  else return null;
  return text;
}
// Class tokens that are never a style: an arbitrary value that closes with
// the wrong bracket ("h-[300px)") is repaired; a negative margin measured in
// viewport heights ("-mt-[calc(100vh-100px)]"), which pulls a section off the
// top of the page, is removed.
export function fixClassBrackets(text: string): { text: string; fixed: string[] } {
  const fixed: string[] = [];
  const out = text.replace(/(className\s*=\s*(?:"[^"]*"|'[^']*'|\{`[^`]*`\}))/g, attr => attr
    // A token whose arbitrary value never closes its bracket and ends with one
    // closing parenthesis too many: that parenthesis is the bracket.
    .replace(/([-\w:/.!]+\[)([^\]\s"'`]*)\)(?=[\s"'`]|$)/g, (m, head, value) => { const opens = (value.match(/\(/g) ?? []).length; const closes = (value.match(/\)/g) ?? []).length + 1; if (closes <= opens) return m; fixed.push(m); return `${head}${value}]`; })
    .replace(/(^|[\s"'`{])((?:[a-z]+:)*-m[tbxylrse]?-\[[^\]\s]*\d+(?:d|s|l)?vh[^\]\s]*\])(?=[\s"'`}]|$)/g, (_m, before, token) => { fixed.push(token); return before; })
    .replace(/  +(?=[^\s"'`])/g, ' '));
  return { text: out, fixed };
}

// Quality the checks cannot see, judged by code right after a file is written:
// a heading or paragraph nested in its own kind (invalid HTML), and class
// tokens the project's Tailwind cannot compile (a colour no theme defines, an
// invented utility), asked of Tailwind's own parser loaded from the project's
// node_modules with the project's stylesheet. Each finding is a diagnostic in
// the checker's own form, so the repair path is the same as for any error.
const designSystems = new Map<string, any>();
export async function invalidTailwindClasses(root: string, path: string, text: string): Promise<string[]> {
  try {
    let css = '';
    const names = await readdir(resolve(root, 'src'), { recursive: true }).catch(() => [] as string[]);
    for (const f of names.filter(f => f.endsWith('.css'))) { const c = await boundedRead(resolve(root, 'src', f)).catch(() => ''); if (/@import\s+["']tailwindcss["']/.test(c)) css += `${c}\n`; }
    if (!css) return [];
    const key = `${root}@${hash(css)}`;
    let ds = designSystems.get(key);
    if (!ds) {
      let mod: any = null;
      try { mod = await import(pathToFileURL(resolve(root, 'node_modules', '@tailwindcss', 'node', 'dist', 'index.mjs')).href); } catch { return []; }
      if (typeof mod?.__unstable__loadDesignSystem !== 'function') return [];
      ds = await mod.__unstable__loadDesignSystem(css, { base: resolve(root, 'src') });
      designSystems.set(key, ds);
    }
    const bad = new Map<string, number>();
    for (const m of text.matchAll(/className\s*=\s*(?:"([^"]*)"|'([^']*)'|\{`([^`]*)`\})/g)) {
      const value = (m[1] ?? m[2] ?? m[3] ?? '').replace(/\$\{[^}]*\}/g, ' ');
      const line = text.slice(0, m.index).split('\n').length;
      for (const token of value.split(/\s+/).filter(Boolean)) {
        if (bad.has(token) || /^(?:group|peer)(?:[/-]|$)/.test(token) || token.includes('$')) continue;
        const out = ds.candidatesToCss([token]);
        if (Array.isArray(out) && out[0] === null) bad.set(token, line);
      }
      if (bad.size >= 12) break;
    }
    return [...bad.entries()].map(([token, line]) => `${path}(${line},1): error: class "${token}" is not a utility the project's Tailwind can compile (no theme or plugin defines it); use a built-in utility, a colour the theme defines, or an arbitrary value`);
  } catch { return []; }
}
export async function qualityDiagnostics(root: string, path: string, text: string): Promise<string[]> {
  if (!/\.(?:[jt]sx|html)$/.test(path)) return [];
  const out: string[] = [];
  for (const m of text.matchAll(/<(h[1-6]|p)\b[^>]*>\s*<\1\b/g)) { const line = text.slice(0, m.index).split('\n').length; out.push(`${path}(${line},1): error: <${m[1]}> is nested inside another <${m[1]}>, which is invalid HTML (React reports a DOM nesting error); keep one element`); }
  out.push(...await invalidTailwindClasses(root, path, text));
  return out;
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
