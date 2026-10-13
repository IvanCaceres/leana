import { randomUUID } from 'node:crypto';
import { open, rename, stat, unlink } from 'node:fs/promises';
import { relative } from 'node:path';
import type { Config, Route, ToolResult } from './types.js';
import { clip } from './context.js';
import { localAddresses } from './serve.js';
import { relativeImports, syntaxErrors } from './code.js';
import {
  type EditRecord,
  type LineChange,
  StaleWriteError,
  assertBalancePreserved,
  assertNoBulkDuplication,
  assertParses,
  describeChange,
  dropDuplicateImports,
  mapRange,
} from './edit-checks.js';
import { boundedRead, hash, parentDirectory, safePath } from './files.js';
import { commandShell, describeProcesses, plainText, runCommand } from './commands.js';
import { LineEditPlan, type LineEdit } from './line-edits.js';
// Replaces a file's content whole or not at all: written to a temporary file with the original's mode, then
// renamed over it, only while the file still has the hash the edit was made against. alongside runs in
// between (a move writes its destination there).
async function replaceAtomically(
  path: string,
  text: string,
  expectedHash: string,
  alongside?: () => Promise<void>,
): Promise<void> {
  const temp = `${path}.leana-${randomUUID()}.tmp`;
  try {
    const h = await open(temp, 'wx', (await stat(path)).mode & 0o777);
    try {
      await h.writeFile(text);
    } finally {
      await h.close();
    }
    await alongside?.();
    if (hash(await boundedRead(path)) !== expectedHash)
      throw new StaleWriteError('File changed while preparing edit; read it again');
    await rename(temp, path);
  } finally {
    await unlink(temp).catch(() => {});
  }
}
export class ToolBox {
  // What the repository's ecosystem prefixes every command with (its
  // environment's tools on the path), set by the loop from the profiles.
  commandPrefix: (() => Promise<string>) | null = null;
  // The in-process parser an edit is judged by before it lands, set by the loop
  // from the language profiles (a component file by its project's compiler);
  // the harness's TypeScript alone otherwise.
  parse: (path: string, text: string) => Promise<string[]> = syntaxErrors;
  // The edits of the running batch, in order (the loop starts a new list per
  // batch; null records nothing): every action of one batch was named from the
  // same evidence, so an edit carrying a hash from before an earlier edit of its
  // batch is numbered as in that text, and the harness knows exactly how it changed.
  journal: EditRecord[] | null = null;
  step = 0;
  constructor(
    readonly root: string,
    readonly artifacts: string,
    readonly config: Config,
    readonly snapshot: (path: string, text: string) => Promise<string> = async () => '',
  ) {}
  private record(path: string, route: string, before: string, after: string, changes: LineChange[] | null): void {
    this.journal?.push({ path, step: this.step, route, before, after, changes });
  }
  // The edits of this batch that lead from the text with hash `from` to the
  // text with hash `to`, or null when the batch's own edits do not account for
  // the difference (a command, another process, or a read from an earlier turn).
  private chain(path: string, from: string, to: string): EditRecord[] | null {
    const out: EditRecord[] = [];
    let at = from;
    while (at !== to) {
      const next = [...(this.journal ?? [])]
        .reverse()
        .find(r => r.path === path && r.before === at && !out.includes(r));
      if (!next) return null;
      out.push(next);
      at = next.after;
    }
    return out;
  }
  // The stale-hash fact: which earlier edit of this batch changed the file, how,
  // and what the file is now.
  private staleFacts(path: string, expected: string, current: string, lineCount: number, why?: string): string {
    const links = this.chain(path, expected, current);
    if (!links?.length) return `Stale file hash for ${path}: read the file again and use the sha256 from that result`;
    const done = links
      .map(
        r =>
          `step ${r.step} (${r.route}) ${r.changes ? `replaced ${r.changes.map(describeChange).join(', ')}` : 'replaced the whole file'}, sha256 ${r.before} -> ${r.after}`,
      )
      .join('; then ');
    return `Stale file hash for ${path}: ${expected} is the text before an earlier edit of this batch: ${done}. ${why ?? ''}${why ? ' ' : ''}${path} is now sha256=${current} totalLines=${lineCount}. One replace_lines call carries several ranges of one file, all numbered as in one read.`;
  }
  async execute(route: Route, a: Record<string, any>): Promise<ToolResult> {
    const run = this.routes[route as keyof ToolBox['routes']];
    if (!run) throw new Error(`Not an executable filesystem tool: ${route}`);
    return run.call(this, a);
  }
  // The executable tools, by route: each takes the action's arguments.
  private readonly routes = {
    read_files: this.readFiles,
    search_codebase: this.searchCodebase,
    create_file: this.createFile,
    write: this.write,
    replace_lines: this.replaceLines,
    move_lines: this.moveLines,
    bash: this.bash,
  };
  private async readFiles(a: Record<string, any>): Promise<ToolResult> {
    const results: string[] = [];
    const hashes: Record<string, string> = {};
    // Cut at line boundaries inside the evidence budget. A mid-text clip would
    // hand Bonsai a truncated excerpt that it then pastes back as oldText.
    const share = Math.floor(this.config.toolChars / a.files.length);
    for (const f of a.files) {
      if (/[?*\[\]]/.test(f.path))
        throw new Error(`read_files requires exact regular file paths; glob rejected: ${f.path}`);
      if (f.end < f.start) throw new Error(`A read range needs end >= start (got ${f.start}..${f.end})`);
      // No line cap of its own: the character budget below decides how much of the range is shown.
      const artifact = f.path.startsWith('@artifact/');
      const path = artifact ? await safePath(this.artifacts, f.path.slice(10)) : await safePath(this.root, f.path);
      const text = await boundedRead(path, artifact ? 8 * 1024 * 1024 : 1024 * 1024);
      const lines = text.split('\n');
      if (!artifact) hashes[f.path] = hash(text);
      const end = Math.min(f.end, lines.length);
      // Reserve room for the header line and the continuation marker.
      const budget = Math.max(400, share - f.path.length - 240);
      const body: string[] = [];
      let size = 0;
      let shown = f.start - 1;
      for (let n = f.start; n <= end; n++) {
        const line = `${n}: ${lines[n - 1]}`;
        if (body.length && size + line.length + 1 > budget) break;
        body.push(clip(line, budget));
        size += line.length + 1;
        shown = n;
        if (line.length > budget) break;
      }
      const cut =
        shown < end
          ? `\n[…truncated at the read budget after line ${shown}; request lines ${shown + 1}..${end} in a later read_files call or narrow the range…]`
          : '';
      results.push(
        `${f.path} sha256=${hash(text)} totalLines=${lines.length} shown=${f.start}..${shown}\n${body.join('\n') || '(no lines in range)'}${cut}`,
      );
    }
    return { ok: true, text: results.join('\n\n'), hashes };
  }
  private async searchCodebase(a: Record<string, any>): Promise<ToolResult> {
    const searchRoot = a.path === '@artifacts' ? this.artifacts : this.root;
    const path = await safePath(searchRoot, a.path === '@artifacts' ? '.' : a.path);
    const exclusions = [
      '!.git/**',
      '!.leana/**',
      '!node_modules/**',
      '!.env',
      '!.env.*',
      '!*.pem',
      '!*.key',
      '!id_rsa',
      '!id_ed25519',
    ];
    const args =
      a.mode === 'files' ? ['--files'] : ['-n', '--no-heading', '--color', 'never', '-F', '--max-count', '50'];
    args.push('--max-filesize', '1M', ...exclusions.flatMap(g => ['--glob', g]));
    // Paths as the rest of the harness names them, with forward slashes, on Windows too.
    if (process.platform === 'win32') args.push('--path-separator', '/');
    if (a.mode === 'text') args.push('-e', a.query);
    args.push('--', relative(searchRoot, path) || '.');
    const r = await runCommand('rg', args, searchRoot, 10000);
    const output =
      a.mode === 'files'
        ? r.output
            .split('\n')
            .filter(p => p.includes(a.query))
            .slice(0, 200)
            .join('\n')
        : r.output;
    const none =
      a.path === '.' || a.path === '@artifacts'
        ? '(no matches in the repository)'
        : `(no matches under ${a.path}; the text may live in another file, search path "." to check the whole repository)`;
    return {
      ok: !r.timedOut && !r.truncated && (r.code === 0 || r.code === 1),
      text: JSON.stringify({ ...r, output: output || none }),
    };
  }
  private async createFile(a: Record<string, any>): Promise<ToolResult> {
    // Creation has one meaning: a file that does not exist gets this content.
    // The content is validated after it lands, never refused for its shape:
    // a parse problem is reported to the worker as a fact, and the
    // relative imports are reported.
    if (!this.config.allowWrite) throw new Error('Writes disabled; restart with --allow-write');
    if (typeof a.path !== 'string' || /[\\/]$/.test(a.path) || a.path === '.' || a.path === '..')
      throw new Error('create_file requires a regular file path; directory path rejected');
    const content = typeof a.content === 'string' ? a.content : '';
    if (!content.trim()) throw new Error(`create_file for ${a.path} produced no content`);
    const path = await safePath(this.root, a.path, true);
    let exists = true;
    try {
      await stat(path);
    } catch (e: any) {
      if (e.code !== 'ENOENT') throw e;
      exists = false;
    }
    if (exists) throw new Error(`${a.path} already exists; edit it with replace_lines or write instead of creating it`);
    await parentDirectory(path);
    await safePath(this.root, a.path, true);
    const handle = await open(path, 'wx', 0o644);
    try {
      await handle.writeFile(content);
    } finally {
      await handle.close();
    }
    const parseErrors = await syntaxErrors(a.path, content);
    const imports = await relativeImports(a.path, content);
    const h = hash(content);
    return {
      ok: true,
      changed: [a.path],
      hashes: { [a.path]: h },
      snapshots: { [a.path]: '@new' },
      parseErrors,
      imports,
      text: `Created ${a.path} (${content.split('\n').length} lines); sha256=${h}.${parseErrors.length ? ` It does not parse yet (${parseErrors.join('; ')}); it stays as written until an edit fixes it.` : ''}${imports.length ? ` Imports ${imports.map(i => i.spec).join(', ')}.` : ''}`,
    };
  }
  private async write(a: Record<string, any>): Promise<ToolResult> {
    // An anchor replacement in a file that exists; nothing else.
    if (!this.config.allowWrite) throw new Error('Writes disabled; restart with --allow-write');
    if (/[\\/]$/.test(a.path) || a.path === '.' || a.path === '..')
      throw new Error('write requires a regular file path; directory path rejected');
    const path = await safePath(this.root, a.path, true);
    let original: string | null = null;
    try {
      original = await boundedRead(path);
    } catch (e: any) {
      if (e.code !== 'ENOENT') throw e;
    }
    if (original === null)
      throw new StaleWriteError(
        `${a.path} does not exist: write replaces an anchor in an existing file; a new file is made with create_file`,
      );
    if (a.expectedHash === 'new')
      throw new StaleWriteError(
        `expectedHash=new is not a hash; ${a.path} exists: read it with read_files and use the returned sha256`,
      );
    if (hash(original) !== a.expectedHash)
      throw new StaleWriteError(this.staleFacts(a.path, a.expectedHash, hash(original), original.split('\n').length));
    const snapshots = { [a.path]: await this.snapshot(a.path, original) };
    const matches = a.oldText ? original.split(a.oldText).length - 1 : 0;
    if (matches === 0)
      throw new Error(
        'oldText must match exactly once: it was not found in the current file. Copy a small anchor exactly from the latest read_files result of this path; never paste a truncated excerpt',
      );
    if (matches > 1)
      throw new Error(
        `oldText must match exactly once: it matches ${matches} times. Include more surrounding lines so the anchor is unique`,
      );
    // An import the file already has is dropped from the replacement, not refused.
    const { kept, dropped } = dropDuplicateImports(original.replace(a.oldText, ''), String(a.newText).split('\n'));
    const newText = kept.join('\n');
    const updated = original.replace(a.oldText, () => newText);
    if (updated === original)
      throw new Error(
        dropped.length
          ? `Write produced no change: the only new lines were imports ${a.path} already has (${dropped.map(l => l.trim()).join('; ')})`
          : 'Write produced no change: newText equals oldText. oldText is the exact existing anchor; newText must be the modified text that replaces it',
      );
    // A whole-file rewrite is a finished generation of the complete file: like a
    // created file it lands as written and its parse state is reported, never
    // refused. The shape guards are for anchor edits, which splice into a file.
    if (!a.wholeFile) {
      // A refused anchor is stated as the lines it spans, as replace_lines states its ranges.
      const at = original.split(a.oldText)[0]!.split('\n').length;
      const end = at + String(a.oldText).split('\n').length - 1;
      assertBalancePreserved(original, updated, a.path, [
        {
          label: `the anchor (lines ${at}..${end})`,
          start: at,
          end,
          fresh: updated.split('\n').slice(at - 1, end + updated.split('\n').length - original.split('\n').length),
        },
      ]);
      await assertParses(a.path, original, updated, this.parse);
      assertNoBulkDuplication(original.replace(a.oldText, ''), kept, a.path);
    }
    await replaceAtomically(path, updated, a.expectedHash);
    const updatedHash = hash(updated);
    // The lines that differ between the text before and after (an anchor that starts or ends
    // with a line break leaves its neighbouring lines as they were); a whole-file write maps nothing forward.
    const ol = original.split('\n');
    const ul = updated.split('\n');
    let pre = 0;
    while (pre < ol.length && pre < ul.length && ol[pre] === ul[pre]) pre++;
    let suf = 0;
    while (suf < ol.length - pre && suf < ul.length - pre && ol[ol.length - 1 - suf] === ul[ul.length - 1 - suf]) suf++;
    // A region rewrite replaced exactly lines region.start..region.end (end = start - 1: an insertion) with region.lines lines.
    this.record(
      a.path,
      a.region ? 'rewrite_file' : a.wholeFile ? 'rewrite' : 'write',
      a.expectedHash,
      updatedHash,
      a.region
        ? [{ start: a.region.start, end: Math.max(a.region.end, a.region.start - 1), count: a.region.lines }]
        : a.wholeFile
          ? null
          : [{ start: pre + 1, end: ol.length - suf, count: ul.length - pre - suf }],
    );
    const anchorLines = String(a.oldText).split('\n').length;
    const notes = [
      dropped.length ? `Dropped ${dropped.length} import line(s) the file already had.` : '',
      anchorLines > 6 && !a.wholeFile
        ? `The anchor was ${anchorLines} lines; replace_lines addresses a block by line number without retyping it.`
        : '',
    ]
      .filter(Boolean)
      .join(' ');
    return {
      ok: true,
      changed: [a.path],
      hashes: { [a.path]: updatedHash },
      snapshots,
      text: a.region
        ? `Replaced lines ${a.region.start}..${a.region.end} of ${a.path} with ${a.region.lines} generated line(s); the file now has ${updated.replace(/\n$/, '').split('\n').length} lines; sha256=${updatedHash}.`
        : a.wholeFile
          ? `Rewrote ${a.path} (${updated.split('\n').length} lines); sha256=${updatedHash}.`
          : `Updated ${a.path}; sha256=${updatedHash}.${notes ? ` ${notes}` : ''} Run focused validation.`,
    };
  }
  private async replaceLines(a: Record<string, any>): Promise<ToolResult> {
    if (!this.config.allowWrite) throw new Error('Writes disabled; restart with --allow-write');
    const path = await safePath(this.root, a.path);
    const original = await boundedRead(path);
    const base = hash(original);
    const { requested, mapped } = this.mapRanges(a.path, a.expectedHash, base, original.split('\n').length, a.edits);
    // A refusal after the ranges were mapped states the mapping: its line numbers are the current text's.
    try {
      const snapshots = { [a.path]: await this.snapshot(a.path, original) };
      const plan = new LineEditPlan(a.path, original, requested, a.harness === true, this.parse);
      plan.checkRanges();
      plan.selectEdits();
      await plan.judge(mapped);
      const retypes = plan.retypes();
      plan.assertNoPastedFile();
      await replaceAtomically(path, plan.updated, base);
      const { summary, tail } = plan.report(mapped, retypes);
      const updatedHash = hash(plan.updated);
      this.record(a.path, 'replace_lines', base, updatedHash, plan.changes());
      return {
        ok: true,
        changed: [a.path],
        hashes: { [a.path]: updatedHash },
        snapshots,
        ...(mapped || plan.applied ? { applied: { ...a, edits: plan.applied ?? requested } } : {}),
        text: `Replaced ${plan.edits.length} range(s) ${summary} of ${a.path}; sha256=${updatedHash} totalLines=${plan.updated.split('\n').length}.${tail} Run focused validation.`,
      };
    } catch (e) {
      if (mapped && e instanceof Error && !(e instanceof StaleWriteError))
        e.message = `${e.message}${mapped} Line numbers in this message are those of the current text, sha256=${base}.`;
      throw e;
    }
  }
  // A hash from before an earlier edit of this batch: the ranges are numbered
  // as in that text, and the batch's edits say exactly where its lines are now.
  // Ranges no earlier edit touched are mapped; any other is refused with the facts.
  private mapRanges(
    path: string,
    expected: string,
    base: string,
    lineCount: number,
    edits: LineEdit[],
  ): { requested: LineEdit[]; mapped: string } {
    if (base === expected) return { requested: edits, mapped: '' };
    const links = this.chain(path, expected, base);
    if (!links?.length || links.some(r => !r.changes))
      throw new StaleWriteError(
        this.staleFacts(
          path,
          expected,
          base,
          lineCount,
          links?.length ? 'No range of the earlier text maps into a whole-file replacement.' : undefined,
        ),
      );
    const moved = edits.map(e => {
      let r: { start: number; end: number } | null = { start: e.start, end: e.end };
      for (const l of links) r = r && mapRange(r.start, r.end, l.changes!);
      return { e, r };
    });
    const hit = moved.filter(m => !m.r);
    if (hit.length)
      throw new StaleWriteError(
        this.staleFacts(
          path,
          expected,
          base,
          lineCount,
          `Range(s) ${hit.map(m => `${m.e.start}..${m.e.end}`).join(', ')} of this edit cover lines that edit changed, so they have no place in the current text.`,
        ),
      );
    return {
      requested: moved.map(m => ({ ...m.e, ...m.r! })),
      mapped: ` The ranges were numbered as in sha256=${expected}, the text before step ${links.map(l => l.step).join(', ')} of this batch, and were mapped to the current text: ${moved.map(m => `${m.e.start}..${m.e.end} -> ${m.r!.start}..${m.r!.end}`).join(', ')}.`,
    };
  }
  private async moveLines(a: Record<string, any>): Promise<ToolResult> {
    // A plain cut and paste: the lines leave source and are appended to
    // destination as they were. Nothing else in either file is changed.
    if (!this.config.allowWrite) throw new Error('Writes disabled; restart with --allow-write');
    if (a.source === a.destination) throw new Error('source and destination must differ');
    if (a.end < a.start || a.end - a.start >= 2000) throw new Error('move_lines ranges must contain 1..2000 lines');
    if (/[\\/]$/.test(a.destination)) throw new Error('destination must be a regular file path');
    const sourcePath = await safePath(this.root, a.source);
    const destinationPath = await safePath(this.root, a.destination, true);
    const original = await boundedRead(sourcePath);
    if (hash(original) !== a.expectedHash)
      throw new StaleWriteError(this.staleFacts(a.source, a.expectedHash, hash(original), original.split('\n').length));
    const lines = original.split('\n');
    if (a.end > lines.length) throw new Error(`Range ${a.start}..${a.end} exceeds ${a.source} (${lines.length} lines)`);
    const snapshots: Record<string, string> = { [a.source]: await this.snapshot(a.source, original) };
    let existing: string | null = null;
    try {
      existing = await boundedRead(destinationPath);
    } catch (e: any) {
      if (e.code !== 'ENOENT') throw e;
    }
    if (existing === null && a.destinationHash !== 'new')
      throw new StaleWriteError(`${a.destination} does not exist; use destinationHash=new to create it`);
    if (existing !== null && a.destinationHash === 'new')
      throw new StaleWriteError(`${a.destination} exists: read it and use its sha256 as destinationHash`);
    // Appending does not depend on the destination's content: a stale destination
    // hash is noted, not refused, as long as the source (whose lines are cut) is current.
    const destinationStale = existing !== null && hash(existing) !== a.destinationHash;
    snapshots[a.destination] = existing !== null ? await this.snapshot(a.destination, existing) : '@new';
    const moved = lines.slice(a.start - 1, a.end).join('\n');
    const remaining = [...lines.slice(0, a.start - 1), ...lines.slice(a.end)].join('\n');
    const output = existing === null || existing === '' ? `${moved}\n` : `${existing.replace(/\n?$/, '\n')}${moved}\n`;
    await parentDirectory(destinationPath);
    await replaceAtomically(sourcePath, remaining, a.expectedHash, async () => {
      const d = await open(destinationPath, existing === null ? 'wx' : 'w', 0o644);
      try {
        await d.writeFile(output);
      } finally {
        await d.close();
      }
    });
    this.record(a.source, 'move_lines', a.expectedHash, hash(remaining), [{ start: a.start, end: a.end, count: 0 }]);
    if (existing !== null)
      this.record(
        a.destination,
        'move_lines',
        hash(existing),
        hash(output),
        existing === ''
          ? null
          : [
              existing.endsWith('\n')
                ? {
                    start: existing.split('\n').length,
                    end: existing.split('\n').length - 1,
                    count: a.end - a.start + 1,
                  }
                : {
                    start: existing.split('\n').length + 1,
                    end: existing.split('\n').length,
                    count: a.end - a.start + 2,
                  },
            ],
      );
    return {
      ok: true,
      changed: [a.source, a.destination],
      hashes: { [a.source]: hash(remaining), [a.destination]: hash(output) },
      snapshots,
      text:
        `Moved lines ${a.start}..${a.end} (${a.end - a.start + 1} lines) from ${a.source} to the end of ${a.destination}, unchanged; nothing else in either file was changed. ` +
        `${a.source} sha256=${hash(remaining)} totalLines=${remaining.split('\n').length}; ${a.destination} sha256=${hash(output)} totalLines=${output.split('\n').length}.` +
        (destinationStale ? ` (destinationHash was stale; the current ${a.destination} was appended to.)` : ''),
    };
  }
  private async bash(a: Record<string, any>): Promise<ToolResult> {
    if (!this.config.allowBash) throw new Error('Shell disabled; restart with --allow-bash');
    // Preserve failures hidden by commands such as `pnpm test 2>&1 | tail`.
    // Without pipefail, the tail process masks the test runner's exit code.
    const prefix = this.commandPrefix ? await this.commandPrefix().catch(() => '') : '';
    // A command that announces a local address and then goes quiet while still running is a
    // server: a shell step cannot keep it alive, so it is stopped and said to be one. Never a check.
    const settle =
      a.check === true
        ? undefined
        : (output: string, quietMs: number) => {
            const at = localAddresses(output);
            return at.length && quietMs >= 5000
              ? `This command is a server: it announced ${at.slice(0, 3).join(', ')} and kept running, so it was stopped (a shell step cannot keep a process alive). To look at what it serves, use observe with start set to this command and target set to that address.`
              : null;
          };
    const ran = await runCommand(
      commandShell[0]!,
      [...commandShell.slice(1), `${prefix}${a.command}`],
      this.root,
      this.config.commandTimeoutMs,
      undefined,
      settle,
    );
    const { leftRunning, ...r } = { ...ran, output: plainText(ran.output) };
    // What the command started and left running when it ended was stopped with it: said, with what it was.
    const stoppedAtEnd = leftRunning?.length
      ? `When this command ended, ${leftRunning.length === 1 ? 'a process it started was' : `${leftRunning.length} processes it started were`} still running, and ${leftRunning.length === 1 ? 'it was' : 'they were'} stopped: ${describeProcesses(leftRunning)}. A shell step cannot keep a process alive: whatever it starts is stopped when it ends. The start command of an observe runs for the length of that observation.`
      : undefined;
    // With a configured check command, only that command is verification; the
    // command words of the profiles are a fallback for sessions that did not declare one.
    // A command is verification when the worker says so, or when it is the configured check; never by its words.
    const looksLikeCheck =
      a.check === true || Boolean(this.config.checkCommand && a.command.trim() === this.config.checkCommand.trim());
    return {
      ok: r.code === 0 && !r.truncated && !r.timedOut,
      check: looksLikeCheck && r.code === 0 && !r.truncated && !r.timedOut,
      verification: looksLikeCheck,
      text: JSON.stringify({
        command: a.command,
        purpose: a.purpose,
        ...(r.stoppedEarly ? { stoppedEarly: r.stoppedEarly } : {}),
        ...(stoppedAtEnd ? { stoppedAtEnd } : {}),
        ...r,
      }),
    };
  }
}
