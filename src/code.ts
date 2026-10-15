// What code says, read by its parser: syntax errors, exported signatures, imports, declarations.
import { posix } from 'node:path';
import { clip } from './context.js';
// The TypeScript compiler, loaded once when first needed; null where it is not installed.
let compiler: any | null | undefined;
export async function typescript(): Promise<any | null> {
  if (compiler === undefined) {
    try {
      const m: any = await import('typescript');
      compiler = m.default ?? m;
    } catch {
      compiler = null;
    }
  }
  return compiler;
}
// The exported surface of a file as short signatures: what another file may
// import from it. Interfaces and type aliases are shown whole when short; a
// function, class or const shows its first line up to the body.
export async function exportedSignatures(path: string, text: string, limit = 14): Promise<string[]> {
  const tsModule = await typescript();
  if (!tsModule || !parseable.test(path)) return [];
  const ts = tsModule;
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const hasExport = (st: any) =>
    (ts.canHaveModifiers(st) ? (ts.getModifiers(st) ?? []) : []).some(
      (m: any) => m.kind === ts.SyntaxKind.ExportKeyword,
    );
  const isDefault = (st: any) =>
    (ts.canHaveModifiers(st) ? (ts.getModifiers(st) ?? []) : []).some(
      (m: any) => m.kind === ts.SyntaxKind.DefaultKeyword,
    );
  const upTo = (st: any, pos: number) => text.slice(st.getStart(sf), pos).replace(/\s+$/, '').replace(/\s+/g, ' ');
  for (const st of sf.statements) {
    if (out.length >= limit) break;
    if (ts.isExportAssignment(st)) {
      out.push(`export default ${clip(st.expression.getText(sf).split('\n')[0]!, 120)}`);
      continue;
    }
    if (ts.isExportDeclaration(st)) {
      out.push(clip(st.getText(sf).replace(/\s+/g, ' '), 160));
      continue;
    }
    if (!hasExport(st)) continue;
    const full = st.getText(sf);
    if (
      (ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st) || ts.isEnumDeclaration(st)) &&
      full.split('\n').length <= 24
    ) {
      out.push(full);
      continue;
    }
    // A function or class shows its head up to the body; an arrow function up to its arrow.
    if (ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) {
      const body = ts.isFunctionDeclaration(st) ? st.body : null;
      const at = body
        ? body.getStart(sf)
        : ts.isClassDeclaration(st)
          ? full.indexOf('{') + st.getStart(sf)
          : st.getEnd();
      out.push(clip(upTo(st, at), 200));
      continue;
    }
    if (ts.isVariableStatement(st)) {
      const init = st.declarationList.declarations[0]?.initializer;
      if (init && ts.isArrowFunction(init)) {
        out.push(clip(upTo(st, init.equalsGreaterThanToken.getEnd()), 200));
        continue;
      }
      if (init && ts.isFunctionExpression(init)) {
        out.push(clip(upTo(st, init.body.getStart(sf)), 200));
        continue;
      }
    }
    out.push(clip(full.split('\n')[0]!.replace(/\s*\{\s*$/, ''), 160) + (isDefault(st) ? '' : ''));
  }
  return out;
}
// The relative imports of a file (a spec starting with . or /), with the local
// names each binds: 'default', '*', the named bindings, or none for a
// side-effect import such as a stylesheet.
export async function relativeImports(
  path: string,
  text: string,
  all = false,
): Promise<{ spec: string; names: string[]; typeOnly?: boolean }[]> {
  const tsModule = await typescript();
  if (!tsModule || !parseable.test(path)) return [];
  const ts = tsModule;
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const out: { spec: string; names: string[]; typeOnly?: boolean }[] = [];
  for (const st of sf.statements) {
    let spec: string | null = null;
    const names: string[] = [];
    let typeOnly = false;
    if (ts.isImportDeclaration(st)) {
      spec = st.moduleSpecifier.text;
      const c = st.importClause;
      typeOnly = Boolean(c?.isTypeOnly);
      if (c?.name) names.push('default');
      if (c?.namedBindings && ts.isNamespaceImport(c.namedBindings)) names.push('*');
      if (c?.namedBindings && ts.isNamedImports(c.namedBindings)) {
        const els = c.namedBindings.elements;
        for (const b of els) names.push(b.propertyName?.text ?? b.name.text);
        if (els.length && els.every((b: any) => b.isTypeOnly)) typeOnly = true;
      }
    } else if (ts.isExportDeclaration(st) && st.moduleSpecifier) {
      spec = st.moduleSpecifier.text;
      typeOnly = Boolean(st.isTypeOnly);
      for (const b of st.exportClause && ts.isNamedExports(st.exportClause) ? st.exportClause.elements : [])
        names.push(b.propertyName?.text ?? b.name.text);
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
    const swapped = cleaned
      .replace(/\.js$/, '.ts')
      .replace(/\.jsx$/, '.tsx')
      .replace(/\.mjs$/, '.mts');
    return [...new Set([cleaned, swapped])];
  }
  return [
    cleaned,
    ...['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json'].map(e => `${cleaned}.${e}`),
    ...['ts', 'tsx', 'js', 'jsx'].map(e => `${cleaned}/index.${e}`),
  ];
}
// The smallest line range containing from..to that starts and ends at
// top-level statement boundaries, so a region rewrite never cuts a declaration.
export async function statementBounds(
  path: string,
  text: string,
  from: number,
  to: number,
): Promise<{ start: number; end: number }> {
  const total = text.split('\n').length;
  let start = Math.max(1, Math.min(from, total));
  let end = Math.max(start, Math.min(to, total));
  const tsModule = await typescript();
  if (!tsModule || !parseable.test(path)) return { start, end };
  const ts = tsModule;
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const spans: { a: number; b: number }[] = sf.statements.map((st: any) => ({
    a: sf.getLineAndCharacterOfPosition(st.getStart(sf)).line + 1,
    b: sf.getLineAndCharacterOfPosition(st.getEnd()).line + 1,
  }));
  let startFound = false;
  let endFound = false;
  for (const { a, b } of spans) {
    if (a <= start && b >= start) {
      start = a;
      startFound = true;
    }
    if (a <= end && b >= end) {
      end = b;
      endFound = true;
    }
  }
  // A bound that fell between statements moves to the nearest statement edge
  // inside the range, so the region never begins or ends on blank lines.
  if (!startFound) {
    const next = spans.filter(x => x.a > start && x.a <= end).map(x => x.a);
    if (next.length) start = Math.min(...next);
  }
  if (!endFound) {
    const prev = spans.filter(x => x.b < end && x.b >= start).map(x => x.b);
    if (prev.length) end = Math.max(...prev);
  }
  return { start, end };
}
// Top-level declarations of a file by name, with their line ranges.
export async function topLevelDeclarations(
  path: string,
  text: string,
): Promise<Map<string, { start: number; end: number; kind: string; exported: boolean }>> {
  const out = new Map<string, { start: number; end: number; kind: string; exported: boolean }>();
  const tsModule = await typescript();
  if (!tsModule || !parseable.test(path)) return out;
  const ts = tsModule;
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  for (const st of sf.statements) {
    const names: string[] = [];
    if (
      (ts.isFunctionDeclaration(st) ||
        ts.isClassDeclaration(st) ||
        ts.isInterfaceDeclaration(st) ||
        ts.isTypeAliasDeclaration(st) ||
        ts.isEnumDeclaration(st)) &&
      st.name
    )
      names.push(st.name.text);
    if (ts.isVariableStatement(st))
      for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name)) names.push(d.name.text);
    if (!names.length) continue;
    const start = sf.getLineAndCharacterOfPosition(st.getStart(sf)).line + 1;
    const end = sf.getLineAndCharacterOfPosition(st.getEnd()).line + 1;
    const exported = (ts.canHaveModifiers(st) ? (ts.getModifiers(st) ?? []) : []).some(
      (m: any) => m.kind === ts.SyntaxKind.ExportKeyword,
    );
    const kind = ts.isVariableStatement(st) ? 'VariableStatement' : ts.SyntaxKind[st.kind]; // SyntaxKind[] yields the enum alias FirstStatement
    for (const n of names) out.set(n, { start, end, kind, exported });
  }
  return out;
}
// Bracket balance of code, ignoring string literals and comments so an ANSI
// escape such as "\u001B[?25l" or a "{" in a comment does not skew the count.
// An edit that leaves a file with more unmatched brackets than before is refused
// before it lands on disk; its caller states what each range does to them (editFacts).
// An edit that leaves a TypeScript or JavaScript file unparseable is refused
// with the parser's own message: cheaper than a lint, a rollback and a rejected
// edit, and it names the exact line. Uses the harness's TypeScript when present.
// A parse problem as the harness states it: the line the parser names, and the
// column with the text that starts there within its whitespace-delimited run
// when the parser gives a position; the parser's own message (its first line);
// and the text of that line when it has any. The position is an offset into the text or a line
// and 1-based column; an offset that does not fall on the line given is not used.
export function problemAt(
  text: string,
  message: string,
  at: { offset?: number; line?: number; column?: number },
): string {
  const said = (message.split('\n')[0] ?? '').trim().replace(/\.$/, '');
  let line = at.line;
  let column = at.column;
  if (!(line && column) && typeof at.offset === 'number' && at.offset >= 0 && at.offset <= text.length) {
    const before = text.slice(0, at.offset);
    const n = before.split('\n').length;
    if (!line || line === n) {
      line = n;
      column = at.offset - before.lastIndexOf('\n');
    }
  }
  const lines = line ? text.split('\n') : [];
  const src = lines[line ? line - 1 : -1];
  if (!line || src === undefined) return line ? `line ${line}: ${said}` : said;
  const line80 = src.trim();
  const cut = line80.length > 80 && /[\ud800-\udbff]/.test(line80[79]!) ? 79 : 80;
  const quoted = line80 ? `: ${JSON.stringify(line80.slice(0, cut))}` : '';
  if (!column) return `line ${line}: ${said}${quoted}`;
  const i = column - 1;
  const content = src.replace(/\s+$/, '');
  let where: string;
  if (i >= content.length)
    where = lines.slice(line).some(l => l.trim()) ? 'at the end of the line' : 'at the end of the file';
  else if (/\s/.test(src[i]!)) where = 'at whitespace';
  else {
    let s = i;
    while (s > 0 && !/\s/.test(src[s - 1]!)) s--;
    let e = i;
    while (e < src.length && !/\s/.test(src[e]!)) e++;
    // Bounds that never split a surrogate pair (a character outside the basic plane is two UTF-16 units).
    const low = (k: number) => /[\udc00-\udfff]/.test(src[k] ?? '');
    let from = Math.max(s, i - 24);
    if (from > s && low(from)) from--;
    let to = Math.min(e, i + 24);
    if (to < e && low(to)) to++;
    const at = i > s && low(i) ? i - 1 : i;
    const rest = src.slice(at, to);
    const run = src.slice(from, to);
    where = `at ${JSON.stringify(rest)}${run === rest ? '' : ` of ${JSON.stringify(run)}`}`;
  }
  return `line ${line}, column ${column} (${where}): ${said}${quoted}`;
}
// What names a problem across versions of a file: all of it but its line and
// column numbers (the message, the text at the column and the line's text), so a
// problem an edit moved without changing is the same problem.
export const problemKey = (problem: string): string => problem.replace(/^line \d+(?:, column \d+)?/, '');
export const parseable = /\.(?:[cm]?[jt]sx?)$/i;
export async function syntaxErrors(path: string, text: string): Promise<string[]> {
  const json = /\.json$/i.test(path);
  if (!parseable.test(path) && !json) return [];
  const tsModule = await typescript();
  if (!tsModule) {
    if (json) {
      try {
        JSON.parse(text);
        return [];
      } catch (e) {
        return [`invalid JSON: ${(e as Error).message}`];
      }
    }
    return [];
  }
  const ts = tsModule;
  const message = (d: any) =>
    problemAt(
      text,
      ts.flattenDiagnosticMessageText(d.messageText, ' '),
      d.file && typeof d.start === 'number' ? { offset: d.start } : {},
    );
  // JSON with the parser tsconfig uses: comments and trailing commas allowed.
  if (json) return (ts.parseJsonText(path, text).parseDiagnostics ?? []).slice(0, 5).map(message);
  // A declaration file has no output to transpile (transpileModule throws "Debug Failure. Output generation failed"): its parse is judged.
  if (/\.d\.[cm]?ts$/i.test(path))
    return (ts.createSourceFile(path, text, ts.ScriptTarget.ESNext, true).parseDiagnostics ?? [])
      .slice(0, 5)
      .map(message);
  const out = ts.transpileModule(text, {
    reportDiagnostics: true,
    fileName: path,
    compilerOptions: {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      jsx: ts.JsxEmit.Preserve,
      allowJs: true,
    },
  });
  return (out.diagnostics ?? []).slice(0, 5).map(message);
}
