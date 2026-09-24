// Orientation: what code can find out about the repository and the machine
// before the worker thinks, so the first steps are not spent discovering it.
// Facts only, gathered once per run: the tree, the manifests, the toolchains
// present, what each detected ecosystem offers as verification, what is
// declared. Nothing here decides anything.
import { join } from 'node:path';
import { boundedRead, listRepoFiles, repositoryStatus, runCommand } from './tools.js';
import { detectProjects, inProject, shellPrefixFor } from './profiles.js';
import { clip } from './context.js';
import { findBrowser } from './render.js';

export interface Orientation {
  repository: { git: boolean; changedCount: number; fileCount: number; topLevel: string[]; directories: Record<string, number>; scripts: Record<string, string> };
  ecosystems: string[];
  // Each ecosystem's projects by directory ('.' is the root).
  projects: Record<string, string[]>;
  manifests: Record<string, string>;
  toolchain: Record<string, string>;
  shell: string;
  root: string;
  verificationCandidates: string[];
  declaredPackages: string[];
}
const tools = ['git', 'node', 'npm', 'pnpm', 'yarn', 'bun', 'python3', 'cargo', 'rustc', 'go', 'make'];
export async function orient(root: string): Promise<Orientation> {
  const status = await repositoryStatus(root).catch(() => ({ git: false, changed: [] as string[], changedCount: 0, scripts: {} as Record<string, string>, topLevel: [] as string[], packages: [] }));
  const files = await listRepoFiles(root).catch(() => [] as string[]);
  const directories: Record<string, number> = {};
  for (const f of files) { const d = f.includes('/') ? f.slice(0, f.lastIndexOf('/')).split('/').slice(0, 2).join('/') : '.'; directories[d] = (directories[d] ?? 0) + 1; }
  const present: string[] = []; const projects: Record<string, string[]> = {}; const manifests: Record<string, string> = {}; const candidates: string[] = []; const declared: string[] = [];
  for (const p of await detectProjects(root).catch(() => [])) {
    (projects[p.eco.id] ??= []).push(p.dir);
    for (const m of p.eco.markers) { const text = await boundedRead(join(root, p.dir, m)).catch(() => null); if (text !== null && Object.keys(manifests).length < 6) manifests[inProject(p, m)] = clip(text, 2500); }
    for (const d of await p.eco.declared(join(root, p.dir)).catch(() => [] as string[])) if (declared.length < 60) declared.push(p.dir === '.' ? d : `${d} (${p.dir})`);
    if (present.includes(p.eco.id)) continue;
    present.push(p.eco.id);
    for (const c of await p.eco.verificationCandidates(root, status as any).catch(() => [])) if (!candidates.includes(c.command)) candidates.push(c.command);
  }
  const browser = await findBrowser().catch(() => null);
  const prefix = await shellPrefixFor(root).catch(() => '');
  const toolchain: Record<string, string> = {};
  const probe = await runCommand('bash', ['--noprofile', '--norc', '-c', `${prefix}for t in ${tools.join(' ')}; do if command -v -- "$t" >/dev/null 2>&1; then v=$("$t" --version 2>&1 | head -1); echo "$t=$v"; fi; done`], root, 20000).catch(() => null);
  for (const line of (probe?.output ?? '').split('\n')) { const i = line.indexOf('='); if (i > 0) toolchain[line.slice(0, i)] = clip(line.slice(i + 1).trim(), 60); }
  if (browser) toolchain.browser = `${browser} (headless; the render action uses it to show you what a page looks like)`;
  return { repository: { git: status.git, changedCount: status.changedCount, fileCount: files.length, topLevel: status.topLevel.slice(0, 40), directories: Object.fromEntries(Object.entries(directories).sort((a, b) => b[1] - a[1]).slice(0, 30)), scripts: status.scripts },
    ecosystems: present, projects, manifests, toolchain, root: files.length === 0 ? 'This directory is the project root the user named, and it is empty. Scaffold and build here, not in a subdirectory.' : 'This directory is the project root the user named; work lands here, not in a new subdirectory, unless the objective says otherwise.', shell: 'Commands run with bash in the repository root, without a terminal and with CI=1: anything that prompts is cancelled, so pass every choice as flags or arguments (a template, --yes, a directory) and never rely on an interactive step.', verificationCandidates: candidates.slice(0, 8), declaredPackages: declared };
}
