// Running a command: bounded memory and time, no terminal, and what it left running stopped with it.
import { readFile, stat, readdir } from 'node:fs/promises';
import { createWriteStream, type WriteStream } from 'node:fs';
import { spawn } from 'node:child_process';
import { bashPath, commandEnv, killTree, missingBash, runMark, windowsLeft } from './shell.js';
import { clip } from './context.js';
// Colour and hyperlink sequences (CSI, 7- and 8-bit; OSC ended by BEL or ST) a tool
// printed although no terminal is attached: they carry no fact, and they split a path
// from its line number. Only these: an ESC that is content (a file shown by cat, a
// search hit) is left alone.
export const plainText = (text: string): string =>
  text.replace(/\u001b\[[0-?]*[ -\/]*[@-~]|\u009b[0-?]*[ -\/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '');
// A process still alive in a command's process group: its id, its parent's, and its command line.
export interface GroupProcess {
  pid: number;
  ppid: number;
  args: string;
}
// The live processes of a process group (zombies left out), read from the process
// table: Linux's /proc, ps elsewhere (macOS, the BSDs, whose /proc differs or is absent)
// and wherever /proc cannot be read. An empty group is known without reading the
// table: signal 0 to it fails. Windows has no groups (runCommand finds what a command left there by its mark).
export async function groupProcesses(
  pgid: number,
  via: 'proc' | 'ps' = process.platform === 'linux' ? 'proc' : 'ps',
): Promise<GroupProcess[]> {
  if (process.platform === 'win32' || !(pgid > 0)) return [];
  try {
    process.kill(-pgid, 0);
  } catch {
    return [];
  }
  const found: GroupProcess[] = [];
  const pids =
    via === 'proc'
      ? await readdir('/proc').then(
          names => names.filter(n => /^\d+$/.test(n)),
          () => null,
        )
      : null;
  if (pids) {
    await Promise.all(
      pids.map(async pid => {
        const stat = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => '');
        const close = stat.lastIndexOf(')');
        if (close < 0) return;
        // After the command name: state, ppid, pgrp.
        const [state, ppid, pgrp] = stat.slice(close + 2).split(' ');
        if (Number(pgrp) !== pgid || state === 'Z' || state === 'X') return;
        const cmdline = (await readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => ''))
          .split('\0')
          .filter(Boolean)
          .join(' ');
        found.push({ pid: Number(pid), ppid: Number(ppid), args: cmdline || stat.slice(stat.indexOf('(') + 1, close) });
      }),
    );
  } else {
    const table = await new Promise<string>(done => {
      const ps = spawn('ps', ['-A', '-o', 'pid=,ppid=,pgid=,stat=,args='], { stdio: ['ignore', 'pipe', 'ignore'] });
      const out: Buffer[] = [];
      ps.stdout.on('data', d => out.push(d));
      ps.on('error', () => done(''));
      ps.on('close', () => done(Buffer.concat(out).toString('utf8')));
    });
    for (const line of table.split('\n')) {
      const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
      if (m && Number(m[3]) === pgid && !m[4]!.startsWith('Z'))
        found.push({ pid: Number(m[1]), ppid: Number(m[2]), args: m[5]!.trim() });
    }
  }
  return found.sort((a, b) => a.pid - b.pid);
}
// The shell a command runs in, as the process table shows it: a subshell the
// command forked keeps this command line, which is the harness's, not the worker's.
export const commandShell = ['bash', '--noprofile', '--norc', '-o', 'pipefail', '-c'];
// What a command left running, in words: the processes whose parent is not among
// them (what the command itself started), and how many those started in turn.
export function describeProcesses(procs: GroupProcess[]): string {
  const pids = new Set(procs.map(p => p.pid));
  const roots = procs.filter(p => !pids.has(p.ppid));
  const shell = commandShell.join(' ') + ' ';
  const named = roots
    .slice(0, 4)
    .map(p =>
      p.args.replace(/^\S*\/(?=bash )/, '').startsWith(shell)
        ? `a subshell of this command (pid ${p.pid})`
        : `"${clip(p.args, 160)}" (pid ${p.pid})`,
    )
    .join(', ');
  const rest = procs.length - Math.min(roots.length, 4);
  return `${named}${rest ? ` and ${rest} process${rest === 1 ? '' : 'es'} ${roots.length > 4 ? 'more' : `started by ${roots.length === 1 ? 'it' : 'them'}`}` : ''}`;
}
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
// A command has ended when the process it ran exits. Its output is read until
// its streams close, or for a short drain when something it started in the
// background still holds them (a server would otherwise hold the command to its
// timeout; output a background job writes after the drain is lost, and the job
// is named as stopped). Whatever of its process group is still alive then (after
// a moment for processes already on their way out) is stopped with it, and
// returned as leftRunning, so the caller can say what was stopped.
// Output is never a reason to stop a command (only its time is): past keep bytes,
// output holds its first and last halves with the count left out between them, and
// the whole of it goes to the spill file when one is given (written only then).
export interface RunOptions {
  keep?: number;
  spill?: { path: string; name: string };
  settle?: (output: string, quietMs: number) => string | null;
}
export async function runCommand(
  command: string,
  args: string[],
  cwd: string,
  timeout: number,
  { keep = 1024 * 1024, spill, settle }: RunOptions = {},
): Promise<{
  stoppedEarly?: string;
  leftRunning?: GroupProcess[];
  output: string;
  code: number | null;
  omitted: number;
  spilled?: string;
  timedOut: boolean;
}> {
  return new Promise((resolveResult, reject) => {
    const env = commandEnv();
    // No terminal is attached: tools that would prompt are told so, the way
    // continuous integration tells them, and npm's own prompts are pre-answered.
    // NO_COLOR as well as FORCE_COLOR=0: some tools read FORCE_COLOR's presence,
    // whatever its value, as "force" (TypeScript 6's tsc, picocolors), and NO_COLOR
    // takes precedence in them.
    Object.assign(env, {
      CI: '1',
      FORCE_COLOR: '0',
      NO_COLOR: '1',
      npm_config_yes: 'true',
      DEBIAN_FRONTEND: 'noninteractive',
    });
    // On Windows the shell carries a mark everything it starts inherits: what is left is found by it (see windowsLeft).
    // Only a shell can leave something running; the harness's own git and rg calls are not searched after.
    const started = Date.now();
    const mark = command === 'bash' ? runMark() : undefined;
    if (mark) env.LEANA_RUN = mark;
    const child = spawn(command === 'bash' ? bashPath() : command, args, {
      cwd,
      env,
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // All of the output while it fits in keep; past that, its start (head) and its latest bytes (tail).
    let chunks: Buffer[] = [];
    let head: Buffer | null = null;
    let tail: Buffer[] = [];
    let tailSize = 0;
    let total = 0;
    let out: WriteStream | null = null;
    let spillFailed = false;
    let timedOut = false;
    let lastOutput = Date.now();
    let stoppedEarly: string | undefined;
    let exitCode: number | null = null;
    let finished = false;
    let drain: NodeJS.Timeout | null = null;
    const kill = () => killTree(child.pid, 'SIGKILL', mark);
    const left = () =>
      (mark ? windowsLeft(mark, started) : groupProcesses(child.pid!)).catch(() => [] as GroupProcess[]);
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeout);
    // A command can say it has become something that will not exit (a server): settle decides from its output and how long it has been quiet.
    const watch = settle
      ? setInterval(() => {
          const why = settle(kept(), Date.now() - lastOutput);
          if (why) {
            stoppedEarly = why;
            kill();
          }
        }, 1000)
      : null;
    const headRoom = Math.floor(keep / 2);
    const tailRoom = keep - headRoom;
    const collect = (data: Buffer) => {
      lastOutput = Date.now();
      total += data.length;
      out?.write(data);
      if (!head) {
        chunks.push(data);
        if (total <= keep) return;
        const all = Buffer.concat(chunks);
        chunks = [];
        if (spill) {
          out = createWriteStream(spill.path, { mode: 0o600 });
          out.on('error', () => {
            spillFailed = true;
          });
          out.write(all);
        }
        head = Buffer.from(all.subarray(0, headRoom));
        tail = [all.subarray(headRoom)];
        tailSize = all.length - headRoom;
      } else {
        tail.push(data);
        tailSize += data.length;
      }
      while (tail.length > 1 && tailSize - tail[0]!.length >= tailRoom) tailSize -= tail.shift()!.length;
      if (tailSize > tailRoom) {
        tail[0] = tail[0]!.subarray(tailSize - tailRoom);
        tailSize = tailRoom;
      }
    };
    const omitted = () => (head ? total - head.length - tailSize : 0);
    const kept = () =>
      head
        ? `${head.toString('utf8')}\n[… ${omitted()} bytes of output left out here${out && !spillFailed ? `; the whole output is in ${spill!.name}` : ''} …]\n${Buffer.concat(tail).toString('utf8')}`
        : Buffer.concat(chunks).toString('utf8');
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (watch) clearInterval(watch);
      if (drain) clearTimeout(drain);
      reject(
        e.code === 'ENOENT' && command === 'rg'
          ? new Error(
              'ripgrep (rg) was not found in PATH. Install ripgrep, confirm rg --version works in this terminal, then retry.',
            )
          : e.code === 'ENOENT' && command === 'bash'
            ? new Error(missingBash())
            : e,
      );
    });
    const finish = async () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (watch) clearInterval(watch);
      if (drain) clearTimeout(drain);
      // Stopped by the harness (timeout, a server): the group was killed on purpose, and that is the fact already.
      let leftRunning: GroupProcess[] = [];
      if (child.pid && !timedOut && !stoppedEarly) {
        const first = await left();
        if (first.length) {
          await pause(250);
          leftRunning = await left();
        }
      }
      // On Windows stopping is a search for the mark: made when the command was stopped or left something.
      if (!mark || timedOut || stoppedEarly || leftRunning.length) kill();
      // Stopped means gone: a killed process holds its ports until it has exited, so what was named is waited for (briefly).
      for (let i = 0; leftRunning.length && i < 40 && (await left()).length; i++) await pause(50);
      // Windows programs end lines with CRLF; the output is read as lines, the same as elsewhere.
      const text = kept();
      const spilled = out as WriteStream | null;
      if (spilled) await new Promise<void>(done => spilled.end(() => done()));
      resolveResult({
        output: process.platform === 'win32' ? text.replace(/\r\n/g, '\n') : text,
        code: exitCode,
        omitted: omitted(),
        ...(spilled && !spillFailed ? { spilled: spill!.path } : {}),
        timedOut,
        ...(stoppedEarly ? { stoppedEarly } : {}),
        ...(leftRunning.length ? { leftRunning } : {}),
      });
    };
    child.on('exit', code => {
      exitCode = code;
      drain = setTimeout(() => {
        void finish();
      }, 1500);
    });
    child.on('close', code => {
      exitCode = code;
      void finish();
    });
  });
}
