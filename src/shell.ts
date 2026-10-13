// The shell every command runs in, per platform. Commands are bash everywhere: on
// Windows that is Git for Windows' bash, which is rarely on the PATH (and the
// `bash.exe` in System32 is WSL's launcher, a different machine), so it is found
// from the git on the PATH or where its installer puts it. LEANA_BASH overrides.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';

const windows = process.platform === 'win32';
// Git's bin\bash.exe is a launcher: it sets up the PATH and starts usr\bin\bash.exe,
// and exits with it, so what a command leaves running would have no living ancestor
// to be found by. The shell is started directly, with the PATH the launcher gives it.
let found: { bash: string; git: string | null } | null = null;
function windowsBash(): { bash: string; git: string | null } {
  if (found) return found;
  const env = process.env, dirs = (env.PATH ?? '').split(delimiter).filter(Boolean);
  if (env.LEANA_BASH) return found = { bash: env.LEANA_BASH, git: null };
  // git.exe sits in <Git>\cmd, <Git>\bin or <Git>\mingw64\bin.
  const roots = [...dirs.filter(d => existsSync(join(d, 'git.exe'))).flatMap(d => [dirname(d), dirname(dirname(d))]),
    ...[env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramW6432, env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Programs')].filter((d): d is string => Boolean(d)).map(d => join(d, 'Git'))];
  const git = roots.find(g => existsSync(join(g, 'usr', 'bin', 'bash.exe')));
  if (git) return found = { bash: join(git, 'usr', 'bin', 'bash.exe'), git };
  const onPath = dirs.filter(d => !/\\(System32|WindowsApps)\\?$/i.test(d)).map(d => join(d, 'bash.exe')).find(p => existsSync(p));
  return found = { bash: onPath ?? 'bash', git: null };
}
export const bashPath = (): string => windows ? windowsBash().bash : process.env.LEANA_BASH || 'bash';
export const missingBash = () => windows
  ? 'bash was not found. Leana runs every command with bash; on Windows install Git for Windows (https://git-scm.com/download/win), or set LEANA_BASH to the path of a bash.exe.'
  : 'bash was not found in PATH. Leana runs every command with bash; install it, or set LEANA_BASH to its path.';

// The environment bash needs on top of the one given: on Windows, Git's own tools
// (head, sed, grep) ahead on the PATH, as its launcher puts them. Windows names the
// variable Path; a copy of the environment must hold it once, as PATH.
export function shellEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (!windows) return base;
  const env = { ...base }; let path = '';
  for (const k of Object.keys(env)) if (/^path$/i.test(k)) { path ||= env[k] ?? ''; delete env[k]; }
  const { git } = windowsBash();
  env.PATH = git ? [join(git, 'mingw64', 'bin'), join(git, 'usr', 'bin'), path].filter(Boolean).join(delimiter) : path;
  if (git && !env.MSYSTEM) env.MSYSTEM = 'MINGW64';
  return env;
}

// The environment a command gets: a small allowlist, so API keys are not
// inherited. Windows programs also need where the system, the user's profile
// and the temporary directory are (npm, node-gyp and Python fail without them).
const shared = ['PATH', 'HOME', 'USER', 'LANG', 'LC_ALL', 'TMPDIR', 'TERM'];
const windowsOnly = ['SystemRoot', 'SystemDrive', 'windir', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP', 'USERPROFILE', 'USERNAME', 'HOMEDRIVE', 'HOMEPATH',
  'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'CommonProgramFiles', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS'];
export function commandEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of windows ? [...shared, ...windowsOnly] : shared) if (process.env[key]) env[key] = process.env[key];
  return shellEnv(env);
}

// Windows has no process groups, and a parent chain does not hold: Git Bash runs a
// program by starting a new process and ending the old, so what a command left
// running can have no living ancestor. Each command's shell carries a mark in its
// environment instead (LEANA_RUN), which everything it starts inherits; Git Bash's
// /proc shows each process's environment, parent and Windows id, so what is left
// is found by the mark, whatever started it and whatever has exited since. A
// Windows program started by a Windows program is not in Git Bash's /proc: those
// are found under what the mark found, by parent id in the Windows process table,
// created since the command started (ids are reused).
export interface WindowsProcess { pid: number; ppid: number; args: string }
let runs = 0;
export const runMark = (): string | undefined => windows ? `${process.pid}-${Date.now()}-${++runs}` : undefined;
const marked = ['--noprofile', '--norc', '-c', 'for p in /proc/[0-9]*; do if tr \'\\0\' \'\\n\' 2>/dev/null < "$p/environ" | grep -qxF "LEANA_RUN=$1"; then printf \'%s %s %s \' "${p#/proc/}" "$(cat "$p/ppid")" "$(cat "$p/winpid")"; tr \'\\0\' \'\\1\' < "$p/cmdline"; echo; fi; done', 'marked'];
const table = ['-NoProfile', '-NonInteractive', '-Command', "Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate,CommandLine | ForEach-Object { '{0} {1} {2} {3}' -f $_.ProcessId, $_.ParentProcessId, ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds(), $_.CommandLine }"];
const probeEnv = () => { const env = shellEnv({ ...process.env }); delete env.LEANA_RUN; return env; };
// A command line as /proc shows one elsewhere: the arguments joined by spaces, the
// program by its name (C:\...\node.exe is node). Windows keeps the quoted string.
export function windowsArgs(commandLine: string): string {
  const args: string[] = []; let cur = '', quoted = false, any = false;
  for (let i = 0; i < commandLine.length; i++) {
    const c = commandLine[i]!;
    if (c === '\\') { let n = 0; while (commandLine[i + n] === '\\') n++; if (commandLine[i + n] === '"') { cur += '\\'.repeat(n >> 1); if (n & 1) { cur += '"'; i += n; } else i += n - 1; } else { cur += '\\'.repeat(n); i += n - 1; } any = true; continue; }
    if (c === '"') { quoted = !quoted; any = true; continue; }
    if (!quoted && /\s/.test(c)) { if (any) args.push(cur); cur = ''; any = false; continue; }
    cur += c; any = true;
  }
  if (any) args.push(cur);
  return programName(args).join(' ');
}
const programName = (args: string[]) => args.length ? [args[0]!.replace(/^.*[\\/]/, '').replace(/\.exe$/i, ''), ...args.slice(1)] : args;
// The processes carrying the mark: Git Bash's id and parent id, the Windows id, the
// arguments. A Git Bash program's are its arguments; a Windows program's are its
// command line cut at spaces, quotes and all, so they are read as a command line.
function markedIn(text: string): { cyg: number; parent: number; pid: number; args: string }[] {
  return text.split('\n').map(l => l.match(/^(\d+) (\d+) (\d+) (.*)$/)).filter((m): m is RegExpMatchArray => Boolean(m))
    .map(m => { const args = m[4]!.split('\u0001').filter(Boolean); return { cyg: Number(m[1]), parent: Number(m[2]), pid: Number(m[3]), args: /^"?[A-Za-z]:[\\/]/.test(args[0] ?? '') ? windowsArgs(args.join(' ')) : programName(args).join(' ') }; });
}
// The Windows programs under a process, by parent id, created since `since`.
function under(text: string, roots: number[], since: number): WindowsProcess[] {
  const rows = text.split(/\r?\n/).map(l => l.match(/^(\d+) (\d+) (\d+) ?(.*)$/)).filter((m): m is RegExpMatchArray => Boolean(m) && Number(m![3]) >= since - 1000)
    .map(m => ({ pid: Number(m[1]), ppid: Number(m[2]), args: windowsArgs(m[4]!.trim()) }));
  const out: WindowsProcess[] = []; const parents = new Set(roots);
  for (let grew = true; grew;) { grew = false; for (const r of rows) if (parents.has(r.ppid) && !parents.has(r.pid)) { parents.add(r.pid); out.push(r); grew = true; } }
  return out;
}
// What is left, as a process table elsewhere shows it. Where Linux replaces a forked
// shell with the program it runs, Git Bash's fork stays, with its shell's command line,
// as the program's parent: such a fork is the program. Git Bash's /proc shows the
// program in its place; the process table shows the fork too, under the bash it was
// forked from and with that bash's command line. The console host Windows attaches
// to a console program is not something the command started.
function tidy(list: WindowsProcess[]): WindowsProcess[] {
  const byPid = new Map(list.map(p => [p.pid, p]));
  const fork = (p: WindowsProcess) => /^bash /.test(p.args) && byPid.get(p.ppid)?.args === p.args;
  const forks = new Map(list.filter(fork).map(p => [p.pid, p.ppid]));
  return list.filter(p => !forks.has(p.pid) && !/^conhost\b/i.test(p.args))
    .map(p => { let ppid = p.ppid; while (forks.has(ppid)) ppid = forks.get(ppid)!; return { ...p, ppid }; })
    .sort((a, b) => a.pid - b.pid);
}
function combine(markedText: string, tableText: () => string | Promise<string>, since: number): WindowsProcess[] | Promise<WindowsProcess[]> {
  const found = markedIn(markedText); if (!found.length) return [];
  const byCyg = new Map(found.map(m => [m.cyg, m.pid]));
  const list: WindowsProcess[] = found.map(m => ({ pid: m.pid, ppid: byCyg.get(m.parent) ?? 0, args: m.args }));
  const add = (text: string) => { for (const d of under(text, found.map(m => m.pid), since)) if (!list.some(p => p.pid === d.pid)) list.push(d); return tidy(list); };
  const t = tableText(); return typeof t === 'string' ? add(t) : t.then(add);
}
const output = (command: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> => new Promise(done => {
  const ps = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, ...(env ? { env } : {}) }); const out: Buffer[] = [];
  ps.stdout.on('data', d => out.push(d)); ps.on('error', () => done('')); ps.on('close', () => done(Buffer.concat(out).toString('utf8')));
});
// What the command marked `mark`, started at `since`, has left running.
export async function windowsLeft(mark: string, since: number): Promise<WindowsProcess[]> {
  return combine(await output(bashPath(), [...marked, mark], probeEnv()), () => output('powershell.exe', table), since);
}

// Stops a process and everything it started. On Windows a process has no group
// to signal: its tree goes by taskkill, and what carries its mark is found and
// stopped, whatever has exited between.
export function killTree(pid: number | undefined, signal: NodeJS.Signals = 'SIGKILL', mark?: string): void {
  if (!pid) return;
  if (!windows) { try { process.kill(-pid, signal); } catch { /* already exited */ } return; }
  spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  if (mark) stopMarked(mark);
}
export function stopMarked(mark: string): void {
  const text = spawnSync(bashPath(), [...marked, mark], { encoding: 'utf8', windowsHide: true, env: probeEnv() }).stdout ?? '';
  for (const p of markedIn(text)) spawnSync('taskkill', ['/pid', String(p.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
}

// Where a Python virtual environment keeps its executables: bin, or Scripts on Windows.
export const venvBin = windows ? 'Scripts' : 'bin';
// A path as bash reads it in PATH and arguments: Git Bash takes C:\a\b as /c/a/b
// (a drive letter's colon would split PATH).
export const bashPathOf = (p: string): string => windows ? p.replace(/^([A-Za-z]):/, (_, d: string) => `/${d.toLowerCase()}`).replace(/\\/g, '/') : p;
// An executable's file name: name.exe on Windows.
export const windowsExe = (name: string): string => windows ? `${name}.exe` : name;
