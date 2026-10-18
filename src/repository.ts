// The repository as a project: its status, packages and installs, the checks it offers, what a check's
// output names, and the sources a completion is judged on.
import { readFile, stat, readdir } from 'node:fs/promises';
import { isAbsolute, posix, relative, resolve } from 'node:path';
import { bashPathOf } from './shell.js';
import type { CheckSummary, SourceEvidence } from './types.js';
import { clip } from './context.js';
import { runCommand } from './commands.js';
import { boundedRead, hash, safePath } from './files.js';
import { parseable, typescript } from './code.js';
// A configured check that cannot run here: its directory is missing or its
// executable is not installed. Such a command is dropped, not retried forever.
export async function checkUnusable(root: string, command: string, prefix = ''): Promise<string | null> {
  const dir = command.match(/(?:--dir|-C|--prefix)\s+(\S+)/)?.[1] ?? command.match(/^\s*cd\s+(\S+)/)?.[1];
  if (dir) {
    try {
      await stat(resolve(root, dir));
    } catch {
      return `its directory ${dir} does not exist in this repository`;
    }
  }
  const exe =
    command
      .replace(/^\s*cd\s+\S+\s*(?:&&|;)\s*/, '')
      .trim()
      .split(/\s+/)[0] ?? '';
  if (exe && !exe.includes('/')) {
    const r = await runCommand(
      'bash',
      ['--noprofile', '--norc', '-c', `${prefix}command -v -- ${JSON.stringify(exe)}`],
      root,
      5000,
    ).catch(() => null);
    if (!r || r.code !== 0) return `${exe} is not installed on this machine`;
  }
  return null;
}
// What the repository looks like right now, for inference: git status, the
// package scripts, and the top-level entries. Works without git.
export async function repositoryStatus(root: string): Promise<{
  git: boolean;
  changed: string[];
  changedCount: number;
  scripts: Record<string, string>;
  topLevel: string[];
  packages: { dir: string; scripts: Record<string, string>; tools: string[] }[];
}> {
  const ignore = /(^|\/)(node_modules|dist|build|\.leana|\.git|coverage|target|__pycache__)(\/|$)/;
  const r = await runCommand('git', ['status', '--porcelain=v1', '--untracked-files=all'], root, 10000).catch(
    () => null,
  );
  const git = Boolean(r && r.code === 0);
  const all = git
    ? r!.output
        .split('\n')
        .filter(Boolean)
        .map(l => l.slice(3).trim().replace(/^"|"$/g, ''))
        .filter(p => !ignore.test(p))
    : [];
  let scripts: Record<string, string> = {};
  try {
    const pkg = JSON.parse(await boundedRead(await safePath(root, 'package.json')));
    if (pkg && typeof pkg.scripts === 'object')
      scripts = Object.fromEntries(
        Object.entries(pkg.scripts)
          .slice(0, 20)
          .map(([k, v]) => [k, String(v).slice(0, 120)]),
      );
  } catch {
    /* none */
  }
  let topLevel: string[] = [];
  try {
    topLevel = (await readdir(root))
      .filter(n => !/^(node_modules|\.git|\.leana)$/.test(n))
      .sort()
      .slice(0, 40);
  } catch {
    /* none */
  }
  // Packages below the root, to depth 3: a monorepo's checks live with the package.
  const packages: { dir: string; scripts: Record<string, string>; tools: string[] }[] = [];
  const manifests = [
    'package.json',
    'tsconfig.json',
    'pyproject.toml',
    'setup.py',
    'Cargo.toml',
    'go.mod',
    'Makefile',
    'pom.xml',
    'build.gradle',
  ];
  const walk = async (dir: string, depth: number) => {
    if (depth > 3 || packages.length >= 12) return;
    let entries: string[];
    try {
      entries = await readdir(resolve(root, dir));
    } catch {
      return;
    }
    const found = entries.filter(n => manifests.includes(n));
    if (found.length && dir !== '.') {
      let pkgScripts: Record<string, string> = {};
      if (found.includes('package.json')) {
        try {
          const pkg = JSON.parse(await boundedRead(resolve(root, dir, 'package.json')));
          if (pkg && typeof pkg.scripts === 'object')
            pkgScripts = Object.fromEntries(
              Object.entries(pkg.scripts)
                .slice(0, 12)
                .map(([k, v]) => [k, String(v).slice(0, 100)]),
            );
        } catch {
          /* none */
        }
      }
      packages.push({ dir, scripts: pkgScripts, tools: found });
    }
    for (const n of entries)
      if (!/^(node_modules|\.git|\.leana|dist|build|coverage|target|vendor|\.[^/]*)$/.test(n)) {
        try {
          if ((await stat(resolve(root, dir, n))).isDirectory()) await walk(dir === '.' ? n : `${dir}/${n}`, depth + 1);
        } catch {
          /* skip */
        }
      }
  };
  await walk('.', 0);
  return { git, changed: all.slice(0, 40), changedCount: all.length, scripts, topLevel, packages };
}
// The packages a generated file may import: the manifest's dependencies, so
// the worker never invents one.
export async function installedPackages(root: string): Promise<string[]> {
  let pkg: any;
  try {
    pkg = JSON.parse(await boundedRead(await safePath(root, 'package.json')));
  } catch {
    return [];
  }
  const names = (o: unknown) =>
    o && typeof o === 'object'
      ? Object.entries(o as Record<string, string>).map(([k, v]) => `${k}@${String(v).replace(/^[\^~]/, '')}`)
      : [];
  return [...new Set([...names(pkg?.dependencies), ...names(pkg?.devDependencies), ...names(pkg?.peerDependencies)])];
}
// A trial that failed for want of dependencies, and the install the manifest implies.
export async function installCommand(root: string, dir = '.', force = false): Promise<string | null> {
  const has = async (p: string) => {
    try {
      await stat(resolve(root, dir, p));
      return true;
    } catch {
      return false;
    }
  };
  if (await has('package.json')) {
    if (!force && (await has('node_modules'))) return null;
    // A forced install follows a manifest change: the lockfile no longer
    // matches it, so the frozen forms (npm ci, --frozen-lockfile) would refuse.
    const cmd = (await has('pnpm-lock.yaml'))
      ? force
        ? 'pnpm install --no-frozen-lockfile'
        : 'pnpm install --frozen-lockfile'
      : (await has('yarn.lock'))
        ? force
          ? 'yarn install'
          : 'yarn install --frozen-lockfile'
        : (await has('bun.lockb')) || (await has('bun.lock'))
          ? 'bun install'
          : !force && (await has('package-lock.json'))
            ? 'npm ci --no-audit --no-fund'
            : 'npm install --no-audit --no-fund';
    return dir === '.' ? cmd : `cd ${dir} && ${cmd}`;
  }
  if (await has('requirements.txt'))
    return `${dir === '.' ? '' : `cd ${dir} && `}python3 -m pip install -r requirements.txt`;
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
      if (/"incremental"\s*:\s*true/.test(text) || /"composite"\s*:\s*true/.test(text))
        return `${command} runs tsc with incremental mode (${dir}/${name}); its error list depends on the previous run's cache, so rollbacks would be judged on stale results. Use a non-incremental check, for example: pnpm --dir ${dir === '.' ? '.' : dir} exec tsc --noEmit --incremental false`;
    } catch {
      /* absent */
    }
  }
  return null;
}
// Fresh, parser-backed facts for completion. Historical edits can be evicted or
// conservatively rejected by an old rollback; current imports and declarations
// still establish the final structure. Names are selected from the objective,
// never inferred from a worker's claim. Comments and strings are not declarations.
export async function completionSource(root: string, paths: string[], objective: string): Promise<SourceEvidence[]> {
  const tsModule = await typescript();
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
            const bindings = [
              ...(c?.name ? [{ name: c.name, propertyName: { text: 'default' } }] : []),
              ...(c?.namedBindings?.elements ?? []),
              ...(c?.namedBindings?.name ? [{ name: c.namedBindings.name, propertyName: { text: '*' } }] : []),
            ];
            for (const b of bindings)
              if (wanted.has(b.name.text) || wanted.has(b.propertyName?.text))
                evidence.facts.push({
                  line,
                  endLine,
                  kind: 'import',
                  name: b.name.text,
                  imported: b.propertyName?.text ?? b.name.text,
                  from: st.moduleSpecifier.text,
                  typeOnly: Boolean(c.isTypeOnly || b.isTypeOnly),
                });
          } else if (ts.isExportDeclaration(st)) {
            for (const b of st.exportClause?.elements ?? [])
              if (wanted.has(b.name.text) || wanted.has(b.propertyName?.text))
                evidence.facts.push({
                  line,
                  endLine,
                  kind: 'export',
                  name: b.name.text,
                  local: b.propertyName?.text ?? b.name.text,
                  from: st.moduleSpecifier?.text,
                });
          } else if (ts.isVariableStatement(st)) {
            for (const d of st.declarationList.declarations)
              if (ts.isIdentifier(d.name) && wanted.has(d.name.text))
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
    } catch (e) {
      evidence.error = clip((e as Error).message, 160);
    }
    remaining -= Buffer.byteLength(JSON.stringify(evidence));
    out.push(evidence);
    if (remaining < 500) break;
  }
  return out;
}
export async function sourceHashes(root: string, paths: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const path of new Set(paths)) {
    try {
      out[path] = hash(await boundedRead(await safePath(root, path)));
    } catch {
      out[path] = 'unavailable';
    }
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
  let output = text;
  let code: number | null = null;
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed?.output === 'string') output = parsed.output;
    if (typeof parsed?.code === 'number') code = parsed.code;
  } catch {
    /* plain text */
  }
  const prefix = `${root.replace(/\/$/, '')}/`;
  // On Windows a tool names a file of the repository by its Windows path (C:\repo\src\a.py, C:/repo/...,
  // or /c/repo/... from bash): it is read with forward slashes, relative to the root.
  if (process.platform === 'win32') {
    const forward = (s: string) => s.replace(/\\/g, '/');
    output = forward(output);
    for (const r of new Set([forward(root), bashPathOf(root)]))
      output = output.replace(new RegExp(`${r.replace(/\/$/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`, 'gi'), '');
  }
  const files: Record<string, number[]> = {};
  const resolved = new Map<string, string | null>();
  const resolvePath = async (token: string): Promise<string | null> => {
    if (resolved.has(token)) return resolved.get(token)!;
    let p: string | null = token.replace(/^file:\/\//, '');
    if (p.startsWith('/')) p = p.startsWith(prefix) ? p.slice(prefix.length) : null;
    if (p !== null) p = posix.normalize(p).replace(/^\.\//, '');
    if (p !== null && (p.startsWith('../') || dependencyTree.test(p))) p = null;
    if (p !== null) {
      const isFile = await stat(resolve(root, p)).then(
        s => s.isFile(),
        () => false,
      );
      if (!isFile) {
        const ends = known.filter(f => f.endsWith(`/${p}`));
        p = ends.length === 1 ? ends[0]! : null;
      }
    }
    resolved.set(token, p);
    return p;
  };
  for (const m of output.matchAll(
    /(?:^|[\s"'`(\[<=,:])((?:file:\/\/)?(?:\/|\.{1,2}\/)?(?:[\w@+.-]+\/)*[\w@+-][\w@+.-]*\.[A-Za-z]\w{0,7})(?:(?::|\(|", line )(\d+))?/g,
  )) {
    if (resolved.size >= 300) break;
    const p = await resolvePath(m[1]!);
    if (!p) continue;
    const lines = (files[p] ??= []);
    const n = Number(m[2] ?? 0);
    if (n && lines.length < 12 && !lines.includes(n)) lines.push(n);
  }
  return { code, files: Object.fromEntries(Object.entries(files).slice(0, 20)) };
}
// What a failed install says the manifest got wrong: a version that does not
// exist (ETARGET) or a package that does not (E404). Repairing either is code's
// work: look the real version up, or drop the dependency.
export function manifestFailures(output: string): { name: string; kind: 'notarget' | 'notfound' }[] {
  const out = new Map<string, 'notarget' | 'notfound'>();
  for (const m of output.matchAll(/No matching version found for ((?:@[\w.-]+\/)?[\w.-]+)@/g))
    out.set(m[1]!, 'notarget');
  for (const m of output.matchAll(
    /404\s+(?:Not Found\s+-\s+GET\s+\S+\/((?:@[\w.-]+(?:%2f|\/))?[\w.-]+)(?:\s|$)|'((?:@[\w.-]+\/)?[\w.-]+)@[^']*' is not in this registry)/g,
  )) {
    const n = (m[1] ?? m[2] ?? '').replace('%2f', '/');
    if (n && !out.has(n)) out.set(n, 'notfound');
  }
  return [...out.entries()].map(([name, kind]) => ({ name, kind }));
}
// A package script that only runs tsc against a solution tsconfig (references
// and no include) checks nothing: the verification of record must be a config
// that includes the sources.
export async function solutionTsconfigReferences(root: string): Promise<string[] | null> {
  let cfg: any;
  try {
    cfg = JSON.parse(
      (await boundedRead(await safePath(root, 'tsconfig.json'))).replace(/\/\*[\s\S]*?\*\/|(^|\s)\/\/[^\n]*/g, ''),
    );
  } catch {
    return null;
  }
  const refs = Array.isArray(cfg?.references)
    ? cfg.references.map((r: any) => String(r?.path ?? '')).filter(Boolean)
    : [];
  const includes =
    (Array.isArray(cfg?.include) && cfg.include.length) || (Array.isArray(cfg?.files) && cfg.files.length);
  return refs.length && !includes ? refs : null;
}
// The package a start command runs (in the directory of its leading `cd <dir> &&`, else the root) when its
// package.json has no script that starts it as that command does, with the scripts it has; null when one does, or
// when there is no package.json there. Its user starts a project from its scripts (npm run dev, npm start): a
// command only the worker typed is not one they know. (Run brunner, 2026-10-17: a Vite scene observed twelve
// times through `npx vite preview` was finished with package.json's scripts still npm init's "test" alone, and
// its user, opening index.html from disk, saw nothing.)
export async function unscriptedStart(
  root: string,
  start: string,
): Promise<{ dir: string; command: string; scripts: string[] } | null> {
  const m = start.trim().match(/^cd\s+("[^"]+"|'[^']+'|[^\s;&|]+)\s*&&\s*([\s\S]*)$/);
  const command = (m ? m[2]! : start).trim();
  let dir = m ? m[1]!.replace(/^(["'])(.*)\1$/, '$2') : '.';
  if (!command || dir.startsWith('~')) return null;
  // The shell's own spelling of a Windows path (/c/Users/...), as Git Bash writes it.
  if (process.platform === 'win32') dir = dir.replace(/^\/([A-Za-z])(?=\/|$)/, (_, d: string) => `${d.toUpperCase()}:`);
  const rel = relative(root, resolve(root, dir)) || '.';
  if (rel.startsWith('..') || isAbsolute(rel)) return null;
  const where = rel.split(/[\\/]/).join('/');
  let scripts: Record<string, unknown>;
  try {
    scripts = JSON.parse(await boundedRead(await safePath(root, posix.join(where, 'package.json')))).scripts ?? {};
  } catch {
    return null;
  }
  const named = command.match(
    /^(?:npm\s+(?:run(?:-script)?\s+(\S+)|(start|test|stop|restart)\b)|(?:yarn|pnpm|bun)\s+(?:run\s+)?(\S+))/,
  );
  const script = named && (named[1] ?? named[2] ?? named[3]);
  if (script && typeof scripts[script] === 'string') return null;
  // The program it runs (npx vite preview: vite): a script running the same program starts it the same way.
  const program = command
    .replace(/^(?:npx|bunx|pnpm\s+(?:exec|dlx)|yarn\s+(?:exec|dlx))\s+(?:-\S+\s+)*/, '')
    .split(/\s+/)[0];
  const runs = (v: unknown) =>
    typeof v === 'string' && v.split(/&&|\|\||;/).some(part => part.trim().split(/\s+/)[0] === program);
  if (program && Object.values(scripts).some(runs)) return null;
  return { dir: where, command, scripts: Object.keys(scripts) };
}
