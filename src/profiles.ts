import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { builtinModules } from 'node:module';
import type { CheckSummary } from './types.js';
import { boundedRead, exportedSignatures, hash, importCandidates, installCommand, installedPackages, manifestFailures, relativeImports, repositoryStatus, runCommand, safePath, solutionTsconfigReferences, syntaxErrors, topLevelDeclarations } from './tools.js';
type RepositoryStatus = Awaited<ReturnType<typeof repositoryStatus>>;
const nested = (repository: RepositoryStatus | undefined, ...manifests: string[]) => (repository?.packages ?? []).some(p => p.tools.some(f => manifests.includes(f)));
const neverCheck = /\b(dev|start|serve|preview|watch|format|fix|deploy|publish|storybook|release|clean)\b|--watch|--write|--fix/;

// Everything the harness knows about a particular ecosystem, language or
// stack lives here as data and small functions detected from the repository.
// The loop in runner.ts calls a profile; it never names a package manager, a
// framework or a domain. A rule that would name one belongs in this file, in
// the row of the profile it is about, gated on what the repository contains.

// ---------------------------------------------------------------------------
// Ecosystems: a manifest, an installer, its failure classes, the packages it
// can add, and how the checker's diagnostics name a package that is missing.
// ---------------------------------------------------------------------------
export type VerificationClass = 'static' | 'build' | 'test' | 'lint';
export interface EcosystemProfile {
  id: string;
  // The manifest the installer reads, and every file whose content defines the installed set.
  manifest: string; manifests: string[];
  // The files whose presence in a directory makes it a project of this ecosystem.
  markers: string[];
  // Configuration files of this ecosystem: created first, never a module to import.
  configFiles: RegExp;
  // Files that import packages of this ecosystem.
  sourceExtensions: RegExp;
  // Whether the repository belongs to this ecosystem: a manifest at the root,
  // or one the repository status found in a nested package.
  detect(root: string, repository?: RepositoryStatus): Promise<boolean>;
  // The install command; force means the manifest changed since the last install.
  installCommand(root: string, dir: string, force: boolean): Promise<string | null>;
  // What every command the harness runs in this repository is prefixed with:
  // the environment's own tools on the path.
  shellPrefix?(root: string): Promise<string>;
  // The lines of a failed install worth pinning.
  errorLines(output: string): string;
  // What a failed install said, as facts for the worker's manifest fix: the
  // package and version it named, and the registry's answer for it. Never a
  // verdict on whose fault the failure is.
  installFacts?(output: string, lookup: (name: string) => Promise<string | null>): Promise<string[]>;
  lookupLatest?(root: string, name: string): Promise<string | null>;
  // Packages the manifest declares (name@version) and whether one is present on disk.
  declared(root: string): Promise<string[]>;
  // What kind of verification a command is, from the command and the script body it runs.
  verificationClass(command: string, body: string): VerificationClass | null;
  // Verification commands the language tools offer for this repository, best first.
  // The commands that could verify the repository, strongest first. The
  // repository status carries the manifest scripts the loop already read.
  verificationCandidates(root: string, repository?: RepositoryStatus): Promise<{ command: string; source: string; body?: string }[]>;
  // The project's own linter for one file, when the repository declares or has one.
  lintCommand?(root: string, path: string): Promise<string | null>;
  // Command prefixes that name this ecosystem's tools (a verify item naming one is a command).
  commandWords: string[];
}
const exists = async (p: string) => { try { await stat(p); return true; } catch { return false; } };
const classOf = (text: string, table: [RegExp, VerificationClass][]): VerificationClass | null => { for (const [re, c] of table) if (re.test(text)) return c; return null; };

const node: EcosystemProfile = {
  id: 'node', manifest: 'package.json', markers: ['package.json'], manifests: ['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb'],
  configFiles: /(^|\/)(package\.json|tsconfig[^/]*\.json|jsconfig\.json|vite\.config\.[cm]?[jt]s|vitest\.config\.[cm]?[jt]s|webpack\.config\.[cm]?js|next\.config\.[cm]?js|tailwind\.config\.[cm]?[jt]s|postcss\.config\.[cm]?js|\.eslintrc[^/]*|eslint\.config\.[cm]?js|\.prettierrc[^/]*)$/,
  sourceExtensions: /\.[cm]?[jt]sx?$/,
  detect: async (root, repository) => (await exists(join(root, 'package.json'))) || Object.keys(repository?.scripts ?? {}).length > 0 || nested(repository, 'package.json'),
  installCommand: (root, dir, force) => installCommand(root, dir, force),
  installFacts: async (output, lookup) => { const out: string[] = []; for (const f of manifestFailures(output)) { if (f.kind === 'notfound') out.push(`${f.name}: the registry has no package of that name`); else { const latest = await lookup(f.name).catch(() => null); out.push(`${f.name}: the registry has no such version${latest ? `; its latest is ${latest}` : ''}`); } } return out; },
  errorLines: output => output.split('\n').filter(l => /error|ERR|not found|notarget|E404|ETARGET|EUNSUPPORTED|peer|EACCES|ETIMEDOUT|ENOTFOUND|ECONNRESET|network/i.test(l)).slice(0, 6).join(' | ') || output,
  lookupLatest: async (root, name) => {
    const r = await runCommand('npm', ['view', name, 'version'], root, 60000).catch(() => null);
    // The version is the line that looks like one: npm's update notice may follow it.
    const v = r && r.code === 0 ? r.output.split('\n').map(l => l.trim()).find(l => /^\d+\.\d+\.\d+/.test(l)) ?? '' : '';
    return v || null;
  },
  declared: root => installedPackages(root),
  verificationClass: (command, body) => classOf(`${command} ${body}`, [[/\btsc\b|\btypecheck\b|\btype-check\b/, 'static'], [/\bvite build\b|\bwebpack\b|\bnext build\b|\bbuild\b/, 'build'], [/\bvitest\b|\bjest\b|\bmocha\b|node --test|\btest\b/, 'test'], [/\beslint\b|\blint\b/, 'lint']]),
  verificationCandidates: async (root, repository) => {
    const out: { command: string; source: string; body?: string }[] = [];
    // A solution tsconfig (references, no include) makes a bare tsc check nothing: the referenced configs are the candidates.
    for (const ref of (await solutionTsconfigReferences(root).catch(() => null)) ?? []) if (/tsconfig[\w.-]*\.json$/.test(ref) || !/\./.test(ref)) out.push({ command: `npx tsc --noEmit -p ${ref}`, source: `tsconfig.json references ${ref}` });
    // The manifest's own scripts, by what their names promise; ones that serve, watch or write are not checks.
    const status = repository ?? await repositoryStatus(root).catch(() => null);
    const rank = ['typecheck', 'type-check', 'check', 'build', 'compile', 'test', 'lint'];
    const usable = ([k, v]: [string, string]) => !neverCheck.test(k) && !neverCheck.test(v);
    for (const name of rank) for (const [k, v] of Object.entries(status?.scripts ?? {})) if ((k === name || k.startsWith(`${name}:`)) && usable([k, v]) && !out.some(o => o.command === `npm run ${k}`)) out.push({ command: `npm run ${k}`, source: `package script ${k}: ${v}`, body: v });
    for (const pkg of status?.packages ?? []) for (const name of rank) for (const [k, v] of Object.entries(pkg.scripts)) if ((k === name || k.startsWith(`${name}:`)) && usable([k, v])) out.push({ command: `cd ${pkg.dir} && npm run ${k}`, source: `package ${pkg.dir} script ${k}: ${v}`, body: v });
    if (await exists(join(root, 'tsconfig.json')) && (await exists(join(root, 'node_modules', '.bin', 'tsc')) || await exists(join(root, 'node_modules', 'typescript')))) { const refs = await solutionTsconfigReferences(root).catch(() => null); out.push({ command: 'npx tsc --noEmit --incremental false -p tsconfig.json', source: `tsconfig.json with typescript installed${refs ? `; note: tsconfig.json is a solution file (references ${refs.join(', ')}, no include), so this bare tsc checks no source file` : ''}` }); }
    return out;
  },
  lintCommand: async (root, path) => {
    if (!(await exists(join(root, 'node_modules', '.bin', 'eslint')))) return null;
    const configs = ['eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', 'eslint.config.ts', '.eslintrc.json', '.eslintrc.js', '.eslintrc.cjs', '.eslintrc'];
    for (const c of configs) if (await exists(join(root, c))) return `npx eslint --format unix --no-warn-ignored ${JSON.stringify(path)}`;
    return null;
  },
  commandWords: ['npm', 'pnpm', 'yarn', 'bun', 'npx', 'node', 'tsc', 'vite', 'vitest', 'jest', 'eslint'],
};
// Python installs into a virtual environment of the project: system Python
// refuses installs (PEP 668), and the checks run with the environment's interpreter.
const pythonBin = async (root: string) => await exists(join(root, '.venv', 'bin', 'python')) ? '.venv/bin/python' : 'python3';
// The project's declared dependencies and every extras group, one per line, read with the interpreter's own TOML parser.
const declaredPython = "import tomllib,sys;d=tomllib.load(open('pyproject.toml','rb'));p=d.get('project',{});x=list(p.get('dependencies',[]))\nfor v in p.get('optional-dependencies',{}).values(): x+=list(v)\nfor v in d.get('dependency-groups',{}).values(): x+=[i for i in v if isinstance(i,str)]\nprint('\\n'.join(x))";
// Whether the project has any source of its own outside its environment and tests.
async function pythonSources(dir: string, depth = 0): Promise<boolean> {
  if (depth > 3) return false;
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (e.name.startsWith('.') || ['tests', 'test', 'node_modules', '__pycache__', 'build', 'dist'].includes(e.name)) continue;
    if (e.isFile() && /\.py$/.test(e.name) && !/^(?:setup|conftest)\.py$/.test(e.name)) return true;
    if (e.isDirectory() && await pythonSources(join(dir, e.name), depth + 1)) return true;
  }
  return false;
}
const python: EcosystemProfile = {
  id: 'python', manifest: 'pyproject.toml', markers: ['pyproject.toml', 'requirements.txt'], manifests: ['pyproject.toml', 'requirements.txt', 'poetry.lock', 'uv.lock'],
  configFiles: /(^|\/)(pyproject\.toml|requirements[^/]*\.txt|setup\.cfg|setup\.py|tox\.ini|mypy\.ini|pytest\.ini)$/,
  sourceExtensions: /\.py$/,
  detect: async (root, repository) => (await exists(join(root, 'pyproject.toml'))) || (await exists(join(root, 'requirements.txt'))) || nested(repository, 'pyproject.toml', 'requirements.txt'),
  // The environment is built in two stages so that nothing waits on code that
  // is not written yet: the declared dependencies (requirements, the project's
  // dependencies and extras) as soon as the manifest exists, and the project
  // itself as an editable install once it has sources. The marker records the
  // stage reached; a manifest change (force) rebuilds from the first.
  installCommand: async (root, dir, force) => {
    const at = (p: string) => join(root, dir, p); const prefix = dir === '.' ? '' : `cd ${dir} && `; const py = '.venv/bin/python';
    const venv = (await exists(at('.venv/bin/python'))) ? '' : 'python3 -m venv .venv && ';
    const stage = venv ? '' : (await boundedRead(at('.venv/.leana-installed')).catch(() => '')).trim();
    const project = await exists(at('pyproject.toml')); const requirements = await exists(at('requirements.txt'));
    if (!project && !requirements) return null;
    const sources = project && await pythonSources(join(root, dir));
    if (!force && (stage === 'project' || (stage === 'deps' && !sources))) return null;
    const steps: string[] = [];
    if (requirements && (force || !stage)) steps.push(`${py} -m pip install -r requirements.txt`);
    if (project && (force || !stage)) steps.push(`${py} -c "${declaredPython}" | xargs -r -d '\\n' ${py} -m pip install`);
    if (project && sources) steps.push(`${py} -m pip install --no-deps -e .`);
    const reached = project && !sources ? 'deps' : 'project';
    return `${prefix}${venv}${steps.join(' && ')} && printf '%s' '${reached}' > .venv/.leana-installed`;
  },
  shellPrefix: async root => (await exists(join(root, '.venv', 'bin'))) ? `export PATH=${JSON.stringify(join(root, '.venv', 'bin'))}:"$PATH"; ` : '',
  errorLines: output => output.split('\n').filter(l => /ERROR|error|No matching|Could not/i.test(l)).slice(0, 6).join(' | ') || output,
  declared: async root => { try { const t = await boundedRead(join(root, 'requirements.txt')); return t.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#')).map(l => l.replace(/\s*(?:[<>=!~]=?.*)$/, '') + '@'); } catch { return []; } },
  verificationClass: (command, body) => classOf(`${command} ${body}`, [[/\bmypy\b|\bpyright\b/, 'static'], [/\bcompileall\b|py_compile/, 'build'], [/\bpytest\b|unittest/, 'test'], [/\bruff\b|\bflake8\b|\bpylint\b/, 'lint']]),
  verificationCandidates: async root => {
    // The tools the project's environment has or declares, strongest first;
    // the interpreter's own syntax pass is always there as the weakest.
    const py = await pythonBin(root); const out: { command: string; source: string }[] = [];
    const pyproject = await boundedRead(join(root, 'pyproject.toml')).catch(() => '');
    const requirements = await boundedRead(join(root, 'requirements.txt')).catch(() => '');
    const tool = async (name: string) => (await exists(join(root, '.venv', 'bin', name))) || new RegExp(`(^|[^\\w-])${name}\\b`, 'm').test(`${pyproject}\n${requirements}`);
    if (/\[tool\.mypy\]/.test(pyproject) || await exists(join(root, 'mypy.ini')) || await tool('mypy')) out.push({ command: `${py} -m mypy .`, source: 'mypy in the environment or configuration' });
    if (await tool('pytest')) out.push({ command: `${py} -m pytest -q`, source: 'pytest in the environment or requirements' });
    out.push({ command: `${py} -m compileall -q -x '\\.venv' .`, source: 'python syntax check' });
    return out;
  },
  lintCommand: async (root, path) => { const py = await pythonBin(root); return (await exists(join(root, '.venv', 'bin', 'ruff'))) ? `${py} -m ruff check --output-format concise ${JSON.stringify(path)}` : null; },
  commandWords: ['python', 'python3', 'pip', 'pytest', 'mypy', 'ruff', '.venv/bin/python'],
};
const rust: EcosystemProfile = {
  id: 'rust', manifest: 'Cargo.toml', markers: ['Cargo.toml'], manifests: ['Cargo.toml', 'Cargo.lock'], configFiles: /(^|\/)(Cargo\.toml|rust-toolchain(?:\.toml)?|\.cargo\/config(?:\.toml)?)$/, sourceExtensions: /\.rs$/,
  detect: async (root, repository) => (await exists(join(root, 'Cargo.toml'))) || nested(repository, 'Cargo.toml'),
  installCommand: async (_root, dir) => dir === '.' ? 'cargo fetch' : `cd ${dir} && cargo fetch`,
  errorLines: output => output.split('\n').filter(l => /error/i.test(l)).slice(0, 6).join(' | ') || output,
  declared: async root => { try { const t = await boundedRead(join(root, 'Cargo.toml')); const dep = t.split(/\[dependencies\]|\[dev-dependencies\]/)[1] ?? ''; return dep.split('\n').map(l => l.trim()).filter(l => /^[\w-]+\s*=/.test(l)).map(l => `${l.split(/\s*=/)[0]}@`); } catch { return []; } },
  verificationClass: (command, body) => classOf(`${command} ${body}`, [[/cargo (?:check|clippy)/, 'static'], [/cargo build/, 'build'], [/cargo test/, 'test'], [/cargo fmt --check/, 'lint']]),
  verificationCandidates: async () => [{ command: 'cargo check', source: 'Cargo.toml' }, { command: 'cargo test', source: 'Cargo.toml' }],
  commandWords: ['cargo', 'rustc', 'rustfmt'],
};
const go: EcosystemProfile = {
  id: 'go', manifest: 'go.mod', markers: ['go.mod'], manifests: ['go.mod', 'go.sum'], configFiles: /(^|\/)(go\.mod|go\.work)$/, sourceExtensions: /\.go$/,
  detect: async (root, repository) => (await exists(join(root, 'go.mod'))) || nested(repository, 'go.mod'),
  installCommand: async (_root, dir) => dir === '.' ? 'go mod download' : `cd ${dir} && go mod download`,
  errorLines: output => output.split('\n').filter(l => /error|cannot|unknown|invalid/i.test(l)).slice(0, 6).join(' | ') || output,
  declared: async root => { try { const t = await boundedRead(join(root, 'go.mod')); return [...t.matchAll(/^\s*([\w.\-/]+)\s+v[\w.\-+]+/gm)].map(m => `${m[1]}@`); } catch { return []; } },
  verificationClass: (command, body) => classOf(`${command} ${body}`, [[/go vet|staticcheck/, 'static'], [/go build/, 'build'], [/go test/, 'test'], [/golangci-lint|gofmt/, 'lint']]),
  verificationCandidates: async () => [{ command: 'go vet ./...', source: 'go.mod' }, { command: 'go build ./...', source: 'go.mod' }, { command: 'go test ./...', source: 'go.mod' }],
  commandWords: ['go', 'gofmt'],
};
export const ecosystems: EcosystemProfile[] = [node, python, rust, go];
// Every project of the repository: each directory (the root and below it, to
// depth 3, outside dependency and build trees) that holds an ecosystem's marker
// file, once per ecosystem. A JavaScript frontend beside a Python backend is two
// projects, each with its own manifest, install, environment and declared packages.
export interface Project { eco: EcosystemProfile; dir: string }
const skipDirs = /^(node_modules|\.git|\.leana|dist|build|coverage|target|vendor|__pycache__|\..*)$/;
export async function detectProjects(root: string): Promise<Project[]> {
  const out: Project[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    let entries; try { entries = await readdir(join(root, dir), { withFileTypes: true }); } catch { return; }
    if (depth > 0 && entries.some(e => e.name === 'pyvenv.cfg')) return;
    const names = new Set(entries.filter(e => e.isFile()).map(e => e.name));
    for (const eco of ecosystems) if (eco.markers.some(m => names.has(m))) out.push({ eco, dir });
    if (depth >= 3 || out.length >= 16) return;
    for (const e of entries) if (e.isDirectory() && !skipDirs.test(e.name)) await walk(dir === '.' ? e.name : `${dir}/${e.name}`, depth + 1);
  };
  await walk('.', 0);
  return out;
}
// The project a file belongs to: the deepest project directory containing it
// whose ecosystem's sources include it, else the deepest containing it at all.
export async function projectFor(root: string, path: string, projects?: Project[]): Promise<Project | null> {
  const all = projects ?? await detectProjects(root);
  const holds = (p: Project) => p.dir === '.' || path === p.dir || path.startsWith(`${p.dir}/`);
  const depth = (p: Project) => p.dir === '.' ? 0 : p.dir.split('/').length;
  const candidates = all.filter(holds).sort((a, b) => depth(b) - depth(a));
  return candidates.find(p => p.eco.sourceExtensions.test(path)) ?? candidates[0] ?? null;
}
// A path of a project's directory, as a repository path.
export const inProject = (p: Project, file: string): string => p.dir === '.' ? file : `${p.dir}/${file}`;
// Configuration and entry files of any ecosystem: created first, never a
// module a source file imports.
export const configFile = (path: string): boolean => /^index\.html$/.test(path) || ecosystems.some(e => e.configFiles.test(path));
// The class of verification a command is, by the ecosystem that owns it;
// ranked so a static check outranks a build, which outranks a test.
export function verificationClass(command: string, body: string): VerificationClass | null {
  for (const e of ecosystems) { const c = e.verificationClass(command, body); if (c) return c; }
  return null;
}

// ---------------------------------------------------------------------------
// Languages: which files are source, how a declaration is made public, and
// what a call site at a position is called.
// ---------------------------------------------------------------------------
export interface LanguageProfile {
  id: string; extensions: RegExp; kind: 'source' | 'style' | 'markup';
  // The prefix that makes a declaration on this line public, when one exists.
  publicPrefix?(line: string): string | null;
  // The name called or rendered at the start of a source segment.
  callSite?(segment: string): string | null;
  // The file to create for an unplanned module this importer imports, from the
  // paths the specifier may denote; the first candidate when absent.
  derivedModule?(importer: string, candidates: string[], names: string[]): string;
  // How a promised export is spelled in a derived module's contract, from the
  // importer's usage; the bare name when absent.
  exportHead?(name: string, usage: string, typeOnly?: boolean): string;
}
const identifier = (segment: string) => segment.match(/^([A-Za-z_$][\w$]*)/)?.[1] ?? null;
export const languages: LanguageProfile[] = [
  { id: 'typescript', extensions: /\.[cm]?[jt]sx?$/, kind: 'source',
    publicPrefix: line => /^export\b/.test(line) ? null : /^(declare\s+)?(abstract\s+)?(type|interface|const|let|var|function|async\s+function|class|enum|namespace)\b/.test(line) ? 'export ' : null,
    callSite: segment => segment.match(/^<\s*([A-Za-z_$][\w$.]*)/)?.[1] ?? segment.match(/^([A-Za-z_$][\w$]*)\s*\(/)?.[1] ?? identifier(segment),
    // An explicit extension is kept; a bare specifier becomes a module beside the importer in its dialect.
    derivedModule: (importer, candidates, names) => {
      const explicit = /\.[a-z]+$/i.test(candidates[0]!) && candidates.length <= 2;
      const typed = /\.[cm]?tsx?$/.test(importer); const jsx = /x$/.test(importer) && names.some(n => /^[A-Z]/.test(n));
      return explicit ? candidates[0]! : `${candidates[0]}${typed ? (jsx ? '.tsx' : '.ts') : (jsx ? '.jsx' : '.js')}`;
    },
    exportHead: (n, usage, typeOnly) => n === 'default' ? 'export default' : typeOnly || /^type /.test(usage) ? `export type ${n}` : /^component /.test(usage) ? `export function ${n}(props)` : /^function /.test(usage) ? `export function ${n}` : `export const ${n}` },
  { id: 'python', extensions: /\.py$/, kind: 'source', callSite: segment => segment.match(/^([A-Za-z_][\w.]*)\s*\(/)?.[1] ?? identifier(segment) },
  { id: 'rust', extensions: /\.rs$/, kind: 'source', publicPrefix: line => /^\s*pub\b/.test(line) ? null : /^\s*(fn|struct|enum|trait|type|const|static|mod)\b/.test(line) ? 'pub ' : null, callSite: segment => segment.match(/^([A-Za-z_][\w:]*)\s*[(!<]/)?.[1] ?? identifier(segment) },
  { id: 'go', extensions: /\.go$/, kind: 'source', callSite: segment => segment.match(/^([A-Za-z_][\w.]*)\s*\(/)?.[1] ?? identifier(segment) },
  { id: 'jvm', extensions: /\.(?:java|kt|kts|scala)$/, kind: 'source', callSite: segment => segment.match(/^([A-Za-z_][\w.]*)\s*\(/)?.[1] ?? identifier(segment) },
  { id: 'other-source', extensions: /\.(?:rb|php|swift|cs|c|cc|cpp|h|hpp|ex|exs|zig|lua|sh)$/, kind: 'source', callSite: segment => identifier(segment) },
  { id: 'vue-svelte', extensions: /\.(?:vue|svelte|astro)$/, kind: 'markup', callSite: segment => segment.match(/^<\s*([A-Za-z_][\w.-]*)/)?.[1] ?? identifier(segment) },
  { id: 'html', extensions: /\.html?$/, kind: 'markup', callSite: segment => segment.match(/^<\s*([A-Za-z][\w-]*)/)?.[1] ?? null },
  { id: 'style', extensions: /\.(?:css|scss|sass|less)$/, kind: 'style' },
];
export const languageFor = (path: string): LanguageProfile | null => languages.find(l => l.extensions.test(path)) ?? null;
// Command prefixes of every ecosystem's tools: a name that starts with one is a command.
// The lockfiles of every ecosystem: files a package manager rewrites that no
// deliverable names and no scope question is about.
export const lockfiles = (): string[] => ecosystems.flatMap(e => e.manifests.filter(m => m !== e.manifest && /lock/i.test(m)));
// The first manifest among these paths, in profile order.
export const manifestOf = (paths: string[]): string | null => { for (const e of ecosystems) { const hit = paths.find(f => f === e.manifest || f.endsWith(`/${e.manifest}`)); if (hit) return hit; } return null; };
// The prefix every harness-run command gets in this repository, from its ecosystem.
// Every project's prefix, the root's first, so a nested project's environment comes first on the path.
export async function shellPrefixFor(root: string): Promise<string> {
  let out = '';
  for (const p of await detectProjects(root).catch(() => [] as Project[])) if (p.eco.shellPrefix) out += await p.eco.shellPrefix(join(root, p.dir)).catch(() => '');
  return out;
}
// Every word a verification command may start with: each ecosystem's tools,
// and the build drivers that belong to no ecosystem.
export const commandWords = (): string[] => [...new Set([...ecosystems.flatMap(e => e.commandWords), 'make', 'cmake', 'ninja', 'sh', 'bash'])];
// Top-level declarations of a file, for the languages without a parser here:
// name, kind, whether it is public, its head, and the lines it spans.
export interface Declaration { name: string; kind: string; exported: boolean; head: string; start: number; end: number }
const declarationPatterns: Record<string, { re: RegExp; exported: (m: RegExpMatchArray, line: string) => boolean; kind: (m: RegExpMatchArray) => string }> = {
  python: { re: /^(?:async\s+)?(def|class)\s+([A-Za-z_]\w*)|^([A-Z][A-Z0-9_]*)\s*(?::[^=]+)?=/, exported: m => !(m[2] ?? m[3] ?? '').startsWith('_'), kind: m => m[1] ?? 'const' },
  rust: { re: /^(pub(?:\([^)]*\))?\s+)?(?:async\s+|unsafe\s+|const\s+)?(fn|struct|enum|trait|type|const|static|mod)\s+([A-Za-z_]\w*)/, exported: m => Boolean(m[1]), kind: m => m[2]! },
  go: { re: /^(func|type|var|const)\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, exported: m => /^[A-Z]/.test(m[2]!), kind: m => m[1]! },
  jvm: { re: /^(?:public\s+)?(?:static\s+|final\s+|abstract\s+)*(class|interface|enum|record|object|fun|def)\s+([A-Za-z_]\w*)/, exported: (_m, line) => /^public\b/.test(line) || /^(?:fun|object|def)\b/.test(line), kind: m => m[1]! },
};
// The head of a declaration line: up to its body brace or initializer at
// nesting depth zero, without a trailing colon or semicolon.
export function declarationHead(line: string): string {
  let depth = 0; let end = line.length;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if ('([<'.includes(c)) depth++; else if (')]>'.includes(c)) { if (c === '>' && line[i - 1] === '-') continue; depth = Math.max(0, depth - 1); }
    else if (depth === 0 && (c === '{' || (c === '=' && line[i + 1] !== '=' && line[i + 1] !== '>' && line[i - 1] !== '!' && line[i - 1] !== '<' && line[i - 1] !== '>'))) { end = i; break; }
  }
  return line.slice(0, end).replace(/[\s:;]+$/, '');
}
export function regexDeclarations(path: string, text: string): Declaration[] {
  const lang = languageFor(path); const pattern = lang ? declarationPatterns[lang.id] : undefined; if (!pattern) return [];
  const lines = text.split('\n'); const out: Declaration[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!; const m = line.match(pattern.re); if (!m) continue;
    const name = (lang!.id === 'python' ? (m[2] ?? m[3]) : lang!.id === 'rust' ? m[3] : m[2]) ?? ''; if (!name) continue;
    const head = declarationHead(line);
    if (out.length) out[out.length - 1]!.end = i;
    out.push({ name, kind: pattern.kind(m), exported: pattern.exported(m, line), head, start: i + 1, end: lines.length });
  }
  return out;
}
// The public surface of a file as declaration heads, for any language: the
// parser for TypeScript and JavaScript, the declaration patterns otherwise.
export async function signaturesFor(path: string, text: string, limit = 14): Promise<string[]> {
  const lang = languageFor(path);
  if (!lang || lang.id === 'typescript') return exportedSignatures(path, text, limit);
  const lines = text.split('\n');
  return regexDeclarations(path, text).filter(d => d.exported).slice(0, limit).map(d => {
    if (!/^(?:class|struct|enum|trait|interface|record|object|type)$/.test(d.kind)) return d.head;
    // A type's contract is its members: the fields and methods at its first
    // indent level, as heads, so a caller sees what it takes and offers.
    const members: string[] = []; let indent: number | undefined;
    for (let i = d.start; i < Math.min(d.end, d.start + 80) && members.length < 12; i++) {
      const l = lines[i] ?? ''; const m = l.match(/^(\s+)(\S.*)$/);
      if (!m) { if (/^[})]/.test(l)) break; continue; }
      if (indent === undefined) indent = m[1]!.length; if (m[1]!.length !== indent) continue;
      const body = m[2]!.trim(); if (/^(?:#|\/\/|\/\*|\*|"{3}|'{3}|@|\[)/.test(body)) continue;
      const method = /^(?:async\s+)?def\s+([A-Za-z_]\w*)|^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+|unsafe\s+|const\s+)?fn\s+([A-Za-z_]\w*)|^(?:public\s+|private\s+|protected\s+|static\s+|override\s+|fun\s+|def\s+)+([A-Za-z_]\w*)\s*\(/.exec(body);
      const field = /^(?:pub(?:\([^)]*\))?\s+)?([A-Za-z_]\w*)\s*:\s*[^=]/.exec(body) ?? /^([A-Za-z_]\w*)\s+[\w\[\]*.<>,]+\s*(?:`|\/\/|$)/.exec(body) ?? /^([A-Z][A-Za-z0-9_]*)(?:\s*[,(=]|\s*$)/.exec(body);
      const name = method?.[1] ?? method?.[2] ?? method?.[3] ?? field?.[1]; if (!name) continue;
      if (name.startsWith('_') && !/^__\w+__$/.test(name)) continue;
      members.push(declarationHead(body));
    }
    return members.length ? `${d.head}\n${members.map(m => `    ${m}`).join('\n')}` : d.head;
  });
}
export async function declarationsFor(path: string, text: string): Promise<Map<string, { start: number; end: number; kind: string; exported: boolean }>> {
  const lang = languageFor(path);
  if (!lang || lang.id === 'typescript') return topLevelDeclarations(path, text);
  return new Map(regexDeclarations(path, text).map(d => [d.name, { start: d.start, end: d.end, kind: d.kind, exported: d.exported }]));
}
// The public names of a file in a language read by pattern; null where a
// parser in process reads it instead.
export function exportedNamesByPattern(path: string, text: string): string[] | null {
  const lang = languageFor(path); if (!lang || !declarationPatterns[lang.id]) return null;
  return regexDeclarations(path, text).filter(d => d.exported).map(d => d.name);
}
// The name a signature line declares, in the file's language.
export function declaredName(path: string, signature: string): string | null {
  const lang = languageFor(path);
  if (!lang || lang.id === 'typescript') return signature.match(/^export\s+(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\*?|class|const|let|var|type|interface|enum)\s+([A-Za-z_$][\w$]*)/)?.[1] ?? null;
  return regexDeclarations(path, signature)[0]?.name ?? null;
}
// The modules a file imports from its own repository, with the names it takes:
// the parser for TypeScript, the import forms of the other languages by pattern.
// External packages are left out; the ecosystem profile knows those.
export interface ModuleImport { spec: string; names: string[]; typeOnly?: boolean }
const importNames = (list: string) => list.replace(/[()]/g, '').split(',').map(n => n.trim().replace(/\s+as\s+\w+$/, '')).filter(n => /^[\w*]+$/.test(n));
export async function importsFor(path: string, text: string, all = false): Promise<ModuleImport[]> {
  const lang = languageFor(path);
  if (!lang || lang.id === 'typescript') return relativeImports(path, text, all);
  const out: ModuleImport[] = [];
  if (lang.id === 'python') {
    for (const m of text.matchAll(/^[ \t]*from[ \t]+([\w.]+)[ \t]+import[ \t]+(\([^)]*\)|[^\n#]+)/gm)) out.push({ spec: m[1]!, names: importNames(m[2]!) });
    for (const m of text.matchAll(/^[ \t]*import[ \t]+([\w.]+)(?:[ \t]+as[ \t]+\w+)?[ \t]*(?:#|$)/gm)) out.push({ spec: m[1]!, names: ['*'] });
  } else if (lang.id === 'rust') {
    for (const m of text.matchAll(/^[ \t]*(?:pub(?:\([^)]*\))?[ \t]+)?use[ \t]+([^;]+);/gm)) {
      const whole = m[1]!.replace(/\s+/g, ' ').trim(); const brace = whole.indexOf('{');
      if (brace >= 0) out.push({ spec: whole.slice(0, brace).replace(/::$/, ''), names: importNames(whole.slice(brace + 1).replace(/}.*$/, '')) });
      else { const parts = whole.replace(/\s+as\s+\w+$/, '').split('::'); const last = parts.pop()!; out.push({ spec: parts.join('::') || last, names: [last] }); }
    }
    for (const m of text.matchAll(/^[ \t]*(?:pub(?:\([^)]*\))?[ \t]+)?mod[ \t]+(\w+)[ \t]*;/gm)) out.push({ spec: `self::${m[1]}`, names: ['*'] });
  } else if (lang.id === 'go') {
    for (const m of text.matchAll(/^[ \t]*import[ \t]+(?:\(([^)]*)\)|"([^"]+)")/gm)) for (const spec of (m[1] !== undefined ? m[1].split('\n').map(l => l.match(/"([^"]+)"/)?.[1]) : [m[2]]).filter((s): s is string => Boolean(s))) out.push({ spec, names: ['*'] });
  }
  return out;
}
// Names a file imports from a repository module that the module does not
// declare, for the languages read by pattern (a type checker judges the
// others): the contract a created file broke, with what the module offers.
export async function unresolvedImports(path: string, text: string, read: (p: string) => Promise<string | null>): Promise<string[]> {
  if (exportedNamesByPattern(path, text) === null) return [];
  const out: string[] = [];
  for (const imp of await importsFor(path, text)) {
    const names = imp.names.filter(n => n !== '*' && n !== 'default'); if (!names.length) continue;
    let modulePath: string | null = null; let moduleText: string | null = null;
    for (const c of moduleCandidates(path, imp.spec)) { const t = await read(c); if (t !== null) { modulePath = c; moduleText = t; break; } }
    if (modulePath === null || moduleText === null) continue;
    const declared = new Set([...(await declarationsFor(modulePath, moduleText)).keys(), ...(await importsFor(modulePath, moduleText)).flatMap(i => i.names)]);
    if (!declared.size || declared.has('*')) continue;
    const missing = names.filter(n => !declared.has(n)); if (!missing.length) continue;
    out.push(`contract: ${path} imports ${missing.join(', ')} from ${imp.spec} (${modulePath}), which does not declare ${missing.length > 1 ? 'them' : 'it'}; it declares ${[...declared].filter(n => !n.startsWith('_') || /^__\w+__$/.test(n)).slice(0, 12).join(', ')}. Import what it declares, or the design's name for it.`);
  }
  return out;
}
// Packages a file imports that the manifest does not declare: the package
// name each bare specifier denotes, in the file's language, minus the
// language's own standard library and the repository's own modules. A fact
// for the manifest's contract, never an install.
const pythonStdlib = new Map<string, Promise<Set<string>>>();
export async function undeclaredPackages(root: string, path: string, text: string, read: (p: string) => Promise<string | null>): Promise<string[]> {
  const project = await projectFor(root, path); const lang = languageFor(path); if (!project || !lang) return [];
  const eco = project.eco; const projectRoot = join(root, project.dir);
  const declared = new Set((await eco.declared(projectRoot).catch(() => [] as string[])).map(d => d.replace(/@[^@]*$/, '').toLowerCase()));
  const out = new Set<string>();
  for (const imp of await importsFor(path, text, true).catch(() => [] as ModuleImport[])) {
    const spec = imp.spec; let name: string | null = null;
    if (lang.id === 'typescript') {
      if (/^[./]/.test(spec) || spec.startsWith('node:') || builtinModuleNames.has(spec.split('/')[0]!) || /^(?:https?:|virtual:|~)/.test(spec)) continue;
      name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]!;
    } else if (lang.id === 'python') {
      if (spec.startsWith('.')) continue;
      const top = spec.split('.')[0]!;
      if (!pythonStdlib.has(root)) pythonStdlib.set(root, runCommand('bash', ['--noprofile', '--norc', '-c', `${await shellPrefixFor(root)}python3 -c "import sys;print('\\\\n'.join(sorted(sys.stdlib_module_names)))"`], root, 10000).then(r => new Set(r.code === 0 ? r.output.split('\n').map(l => l.trim()).filter(Boolean) : [])).catch(() => new Set<string>()));
      if ((await pythonStdlib.get(root)!).has(top)) continue;
      let local = false; for (const c of moduleCandidates(path, top).flatMap(c => [c, inProject(project, c)])) if ((await read(c)) !== null) { local = true; break; }
      if (local) continue;
      name = top;
    } else if (lang.id === 'rust') {
      const top = spec.split('::')[0]!; if (['crate', 'self', 'super', 'std', 'core', 'alloc'].includes(top)) continue; name = top.replace(/_/g, '-');
    } else continue;
    if (name && !declared.has(name.toLowerCase()) && !declared.has(name.replace(/-/g, '_').toLowerCase())) out.add(name);
  }
  return [...out];
}
// The repository files an import specifier may denote, importer-relative for
// relative forms and root-relative for absolute ones, first match wins.
export function moduleCandidates(importer: string, spec: string): string[] {
  const lang = languageFor(importer); const dir = importer.includes('/') ? importer.slice(0, importer.lastIndexOf('/')) : '.';
  const under = (base: string, rest: string) => base === '.' ? rest : rest ? `${base}/${rest}` : base;
  if (!lang || lang.id === 'typescript') return importCandidates(importer, spec);
  if (lang.id === 'python') {
    const dots = spec.match(/^\.*/)![0].length; const rest = spec.slice(dots).split('.').filter(Boolean).join('/');
    if (dots) { let base = dir; for (let i = 1; i < dots; i++) base = base.includes('/') ? base.slice(0, base.lastIndexOf('/')) : '.'; return rest ? [`${under(base, rest)}.py`, `${under(base, rest)}/__init__.py`] : [`${under(base, '')}/__init__.py`]; }
    return [`${rest}.py`, `${rest}/__init__.py`, `src/${rest}.py`, `src/${rest}/__init__.py`];
  }
  if (lang.id === 'rust') {
    const parts = spec.split('::').filter(Boolean); if (!['crate', 'self', 'super'].includes(parts[0] ?? '')) return [];
    const file = importer.slice(importer.lastIndexOf('/') + 1).replace(/\.rs$/, '');
    let base = parts[0] === 'crate' ? 'src' : parts[0] === 'super' ? (dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '.') : dir;
    const own = parts[0] === 'self' && !['mod', 'lib', 'main'].includes(file) ? [`${dir}/${file}`] : [];
    const rest = parts.slice(1); const out: string[] = [];
    for (const b of [base, ...own]) { if (!rest.length) { out.push(`${b}/mod.rs`, `${b}.rs`); continue; } const p = under(b, rest.join('/')); out.push(`${p}.rs`, `${p}/mod.rs`); if (rest.length > 1) out.push(`${under(b, rest.slice(0, -1).join('/'))}.rs`); }
    return [...new Set(out)];
  }
  return [];
}
// How a file spells an import of another, in its language: a relative path
// without extension for TypeScript, a dotted module for Python, a crate path
// for Rust, a package directory for Go.
export function importSpelling(from: string, to: string): string {
  const lang = languageFor(from);
  const rel = (() => { const a = from.split('/').slice(0, -1); const b = to.split('/'); while (a.length && b.length > 1 && a[0] === b[0]) { a.shift(); b.shift(); } const up = a.length ? '../'.repeat(a.length) : './'; return up + b.join('/'); })();
  if (!lang || lang.id === 'typescript') return rel.replace(/\.(tsx?|jsx?|mts|cts)$/, '');
  if (lang.id === 'python') return to.replace(/^src\//, '').replace(/\.py$/, '').replace(/\/__init__$/, '').replace(/\//g, '.');
  if (lang.id === 'rust') { const p = to.replace(/^src\//, '').replace(/\.rs$/, '').replace(/\/mod$/, ''); return ['lib', 'main'].includes(p) ? 'crate' : `crate::${p.replace(/\//g, '::')}`; }
  if (lang.id === 'go') return to.includes('/') ? to.slice(0, to.lastIndexOf('/')) : '.';
  return rel;
}
// Whether a file parses, by the language's own tool when the machine has it:
// the TypeScript parser in process; Python's ast, gofmt and rustfmt as commands.
// A language without a tool here has no gate, which is the honest answer.
export async function syntaxCheck(root: string, path: string, text: string): Promise<string[]> {
  const lang = languageFor(path);
  if (!lang || lang.id === 'typescript' || /\.json$/i.test(path)) return syntaxErrors(path, text);
  const tool = lang.id === 'python' ? { cmd: 'python3', args: (f: string) => ['-c', 'import ast, sys\nsrc = open(sys.argv[1], encoding="utf-8").read()\ntry:\n    ast.parse(src, sys.argv[2])\nexcept SyntaxError as e:\n    print(f"{sys.argv[2]}({e.lineno},{e.offset or 1}): error: {e.msg}")\n    sys.exit(1)', f, path] }
    : lang.id === 'go' ? { cmd: 'gofmt', args: (f: string) => ['-e', '-l', f] } : lang.id === 'rust' ? { cmd: 'rustfmt', args: (f: string) => ['--check', '--edition', '2021', f] } : null;
  if (!tool) return [];
  const probe = await runCommand('bash', ['--noprofile', '--norc', '-c', `command -v -- ${tool.cmd}`], root, 5000).catch(() => null); if (!probe || probe.code !== 0) return [];
  const dir = await mkdtemp(join(tmpdir(), 'leana-syntax-')); const file = join(dir, path.split('/').pop()!);
  try {
    await writeFile(file, text);
    const r = await runCommand(tool.cmd, tool.args(file), root, 20000).catch(() => null); if (!r) return [];
    const lines = r.output.split('\n').map(l => l.replaceAll(file, path).trim()).filter(l => /error|expected|invalid|unexpected/i.test(l));
    return r.code === 0 ? [] : lines.length ? lines.slice(0, 6) : [`${path}: the ${tool.cmd} parser rejected the file (exit ${r.code})`];
  } finally { await rm(dir, { recursive: true, force: true }).catch(() => {}); }
}
// A file worth reviewing against its specification: any source, style or markup file.
export const sourceFile = (path: string): boolean => languageFor(path) !== null;
// Files that can hold markup elements (a content-model lint applies).
export const markupFile = (path: string): boolean => /\.(?:[jt]sx|html?|vue|svelte|astro)$/.test(path);

// ---------------------------------------------------------------------------
// Stack contracts: an integration the repository shows it intends (detect),
// the text a configuration must hold for it (ensure), and the packages it
// needs. The loop applies them as harness edits; it never knows the stack.
// ---------------------------------------------------------------------------
export const builtinModuleNames = new Set(builtinModules);

// The class names a project's markup uses, by file: the contract a stylesheet
// is written against, as module signatures are for code. Read from class
// attributes in source and markup files (JSX className, HTML/Vue/Svelte class),
// static parts only. A fact for the generation, never a rule it must follow.
const classAttribute = /\bclass(?:Name)?\s*=\s*(?:"([^"]*)"|'([^']*)'|\{\s*`([^`]*)`\s*\}|\{\s*"([^"]*)"\s*\}|\{\s*'([^']*)'\s*\})/g;
export function classNamesIn(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(classAttribute)) for (const n of (m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5] ?? '').replace(/\$\{[^}]*\}/g, ' ').split(/\s+/)) if (/^[A-Za-z_-][\w-]*$/.test(n)) out.add(n);
  return [...out];
}
export async function markupClassNames(root: string, files: string[], limit = 400): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {}; let total = 0;
  for (const p of files.filter(f => { const l = languageFor(f); return l && l.kind !== 'style' && !/(^|\/)(?:node_modules|dist|build|\.venv|vendor)\//.test(f); }).slice(0, 120)) {
    let text: string; try { text = await boundedRead(join(root, p)); } catch { continue; }
    const names = classNamesIn(text).slice(0, limit - total); if (!names.length) continue;
    out[p] = names; total += names.length; if (total >= limit) break;
  }
  return out;
}
// Class names a stylesheet has a selector for (any rule that mentions .name).
export const stylesheetClasses = (css: string): Set<string> => new Set([...css.matchAll(/\.(-?[_A-Za-z][\w-]*)/g)].map(m => m[1]!));
