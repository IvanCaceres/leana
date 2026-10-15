// Files of the repository: paths kept inside it, bounded reads, content hashes, the files it holds,
// and what a command did to the tree.
import { createHash } from 'node:crypto';
import { open, realpath, stat, mkdir, readdir } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { runCommand } from './commands.js';
// The first 16 hex digits (64 bits) of SHA-256: enough to tell one version of a
// file from another in a session, and a quarter of the tokens every prompt pays for.
export const hash = (text: string | Buffer): string => createHash('sha256').update(text).digest('hex').slice(0, 16);
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
// The files a developer sees as the project: in a git repository, what git tracks and what it would track, on
// disk now, not what it ignores (build output, caches, other worktrees checked out inside it); elsewhere the
// whole tree. The same exclusions as listRepoFiles (dependency folders, .env files, keys).
export async function visibleRepoFiles(root: string): Promise<string[]> {
  const r = await runCommand(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    root,
    10000,
  ).catch(() => null);
  if (!r || r.code !== 0 || r.truncated) return listRepoFiles(root);
  const excluded = /(^|\/)(\.git|\.leana|node_modules)\/|(^|\/)\.env(\.[^/]*)?$|\.(pem|key)$/i;
  const listed = [...new Set(r.output.split('\0').filter(Boolean))].filter(f => !excluded.test(f));
  const present = await Promise.all(
    listed.map(f =>
      stat(resolve(root, f)).then(
        s => s.isFile(),
        () => false,
      ),
    ),
  );
  return listed.filter((_, i) => present[i]).sort();
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
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return true;
    }
    if (prefix && entries.some(e => e.name === 'pyvenv.cfg')) return true;
    for (const entry of entries) {
      if (['.git', '.leana', 'node_modules'].includes(entry.name)) continue;
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        if (!(await visit(path, `${prefix}${entry.name}/`))) return false;
      } else if (entry.isFile()) {
        try {
          const s = await stat(path);
          out.set(`${prefix}${entry.name}`, `${s.size}:${s.mtimeMs}`);
        } catch {
          /* gone */
        }
        if (out.size > limit) return false;
      }
    }
    return true;
  }
  return (await visit(root, '')) ? out : null;
}
export async function treeChanges(
  root: string,
  before: TreeSnapshot,
  after: TreeSnapshot,
): Promise<{ changed: string[]; created: string[]; deleted: string[] }> {
  const created = [...after.keys()].filter(p => !before.has(p));
  const deleted = [...before.keys()].filter(p => !after.has(p));
  const modified = [...after.keys()].filter(p => before.has(p) && before.get(p) !== after.get(p));
  let all = [...modified, ...created, ...deleted];
  if (all.length) {
    const r = await new Promise<string | null>(done => {
      const child = spawn('git', ['check-ignore', '--no-index', '--stdin'], {
        cwd: root,
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      let text = '';
      child.stdout.on('data', d => {
        text += String(d);
      });
      child.on('error', () => done(null));
      child.on('close', code => done(code === 0 || code === 1 ? text : null));
      child.stdin.end(all.join('\n') + '\n');
    });
    const ignored = new Set((r ?? '').split('\n').filter(Boolean));
    all = all.filter(p => !ignored.has(p));
  }
  const keep = new Set(all);
  return { changed: all, created: created.filter(p => keep.has(p)), deleted: deleted.filter(p => keep.has(p)) };
}
// Files' content hashes (as read_files shows them) by the signature a tree snapshot
// records (size and modification time): a file is read only when its signature has
// not been hashed yet, so what a command did to content costs the files it touched.
// A file whose signature moved while it was read is not recorded, nor one past the
// read limit or the budget: for those the content before or after is not known.
export class TreeHashes {
  private known = new Map<string, { sig: string; hash: string }>();
  at(path: string, sig: string | undefined): string | null {
    const k = this.known.get(path);
    return k && sig !== undefined && k.sig === sig ? k.hash : null;
  }
  async fill(root: string, files: TreeSnapshot, budget = 32 * 1024 * 1024): Promise<void> {
    let spent = 0;
    for (const [p, sig] of files) {
      if (this.known.get(p)?.sig === sig) continue;
      this.known.delete(p);
      const size = Number(sig.slice(0, sig.indexOf(':')));
      if (!(size <= 1024 * 1024) || spent + size > budget) continue;
      spent += size;
      const path = resolve(root, p);
      try {
        const text = await boundedRead(path);
        const s = await stat(path);
        if (`${s.size}:${s.mtimeMs}` === sig) this.known.set(p, { sig, hash: hash(text) });
      } catch {
        /* gone, or not readable */
      }
    }
  }
}
export const within = (root: string, path: string): boolean => {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};
function blocked(path: string): boolean {
  return path
    .split(/[\\/]/)
    .some(
      part =>
        ['.git', '.leana', 'node_modules'].includes(part) ||
        /^\.env(?:\.|$)/.test(part) ||
        /^(?:id_rsa|id_ed25519)$/.test(part) ||
        /\.(?:pem|key)$/i.test(part),
    );
}
export async function safePath(root: string, name: string, create = false): Promise<string> {
  if (!name || name.includes('\0') || isAbsolute(name) || blocked(name))
    throw new Error('Path is excluded or must be repository-relative');
  const target = resolve(root, name);
  if (!within(root, target)) throw new Error('Path escapes repository');
  let current = target;
  while (true) {
    try {
      const canonical = await realpath(current);
      if (!within(root, canonical) || blocked(relative(root, canonical)))
        throw new Error('Symlink escapes repository or targets excluded path');
      if (current === target) return canonical;
      return target;
    } catch (e: any) {
      if (e.code !== 'ENOENT' || !create || current === root) throw e;
      current = dirname(current);
    }
  }
}
// Makes the directories a file is written into. Where one of them is a file, Linux
// says ENOTDIR and Windows EEXIST ("file already exists"), which reads as if the file
// being written existed; Windows' is said as Linux says it.
export async function parentDirectory(path: string): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true });
  } catch (e: any) {
    if (process.platform === 'win32' && e?.code === 'EEXIST')
      throw Object.assign(new Error(`ENOTDIR: not a directory, mkdir '${e.path ?? dirname(path)}'`), {
        code: 'ENOTDIR',
      });
    throw e;
  }
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
  } finally {
    await handle.close();
  }
}
