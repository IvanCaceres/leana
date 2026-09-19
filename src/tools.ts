import { createHash, randomUUID } from 'node:crypto';
import { open, readFile, realpath, rename, stat, unlink, mkdir, readdir } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import type { Config, Route, ToolResult } from './types.js';
import { clip } from './context.js';
export const hash = (text: string | Buffer): string => createHash('sha256').update(text).digest('hex');
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
export class ToolBox {
  constructor(readonly root: string, readonly artifacts: string, readonly config: Config) {}
  async execute(route: Route, a: Record<string, any>): Promise<ToolResult> {
    if (route === 'read_files') {
      const results: string[] = [];
      for (const f of a.files) {
        if (/[?*\[\]]/.test(f.path)) throw new Error(`read_files requires exact regular file paths; glob rejected: ${f.path}`);
        if (f.end < f.start || f.end - f.start >= 250) throw new Error('Read ranges must contain 1..250 lines');
        const artifact = f.path.startsWith('@artifact/');
        const path = artifact ? await safePath(this.artifacts, f.path.slice(10)) : await safePath(this.root, f.path);
        const text = await boundedRead(path, artifact ? 8 * 1024 * 1024 : 1024 * 1024);
        const lines = text.split('\n');
        results.push(`${f.path} sha256=${hash(text)} totalLines=${lines.length}\n` +
          clip(lines.slice(f.start - 1, f.end).map((line, i) => `${f.start + i}: ${line}`).join('\n'), 20000));
      }
      return { ok: true, text: results.join('\n\n') };
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
      return { ok: !r.timedOut && !r.truncated && (r.code === 0 || r.code === 1),
        text: JSON.stringify({ ...r, output: output || '(no matches)' }) };
    }
    if (route === 'write') {
      if (!this.config.allowWrite) throw new Error('Writes disabled; restart with --allow-write');
      if (/[\\/]$/.test(a.path) || a.path === '.' || a.path === '..') throw new Error('write requires a regular file path; directory path rejected');
      const path = await safePath(this.root, a.path, true);
      let original: string | null = null;
      try { original = await boundedRead(path); } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
      if (original === null) {
        if (a.expectedHash !== 'new' || a.oldText !== '') throw new Error('New files require expectedHash=new and empty oldText');
        await mkdir(dirname(path), { recursive: true });
        await safePath(this.root, a.path, true);
        const handle = await open(path, 'wx', 0o644);
        try { await handle.writeFile(a.newText); } finally { await handle.close(); }
      } else {
        if (a.expectedHash === 'new') throw new Error('expectedHash=new is only valid for a new file; read the existing file and use its sha256');
        if (hash(original) !== a.expectedHash) throw new Error('Stale file hash: read the file again before editing');
        if (!a.oldText || original.split(a.oldText).length !== 2) throw new Error('oldText must match exactly once');
        const updated = original.replace(a.oldText, () => a.newText);
        if (updated === original) throw new Error('Write produced no change; choose a different exact replacement');
        const temp = `${path}.leana-${randomUUID()}.tmp`;
        try {
          const h = await open(temp, 'wx', (await stat(path)).mode & 0o777);
          try { await h.writeFile(updated); } finally { await h.close(); }
          if (hash(await boundedRead(path)) !== a.expectedHash) throw new Error('File changed while preparing edit');
          await rename(temp, path);
        } finally { await unlink(temp).catch(() => {}); }
      }
      return { ok: true, changed: a.path, text: `Updated ${a.path}; sha256=${hash(await boundedRead(path))}. Run focused validation.` };
    }
    if (route === 'bash') {
      if (!this.config.allowBash) throw new Error('Shell disabled; restart with --allow-bash');
      // Preserve failures hidden by commands such as `pnpm test 2>&1 | tail`.
      // Without pipefail, the tail process masks the test runner's exit code.
      const r = await runCommand('bash', ['--noprofile', '--norc', '-o', 'pipefail', '-c', a.command], this.root, this.config.commandTimeoutMs);
      const looksLikeCheck = /(?:^|[\s:&|;])(?:npm|pnpm|yarn|bun|node|python|pytest|cargo|go|mvn|gradle|tsc|eslint|prettier|ruff)(?:\s|$)|\b(?:test|build|check|lint|typecheck|tsc)\b/i.test(a.command);
      return { ok: r.code === 0 && !r.truncated && !r.timedOut, check: looksLikeCheck && r.code === 0 && !r.truncated && !r.timedOut,
        text: JSON.stringify({ command: a.command, purpose: a.purpose, ...r }) };
    }
    throw new Error(`Not an executable filesystem tool: ${route}`);
  }
}
