import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaults } from '../src/config.js';
import { runCommand } from '../src/commands.js';
import { boundedRead, hash, readLines } from '../src/files.js';
import { ToolBox } from '../src/tools.js';
import { resultView } from '../src/tui/view.js';

const scratch = async (t: any) => {
  const d = await mkdtemp(join(tmpdir(), 'leana-limits-'));
  t.after(() => rm(d, { recursive: true, force: true }));
  return d;
};
const counting = 'for (let i = 1; i <= 2000; i++) console.log("line " + i)';
const counted = Array.from({ length: 2000 }, (_, i) => `line ${i + 1}\n`).join('');

test('A command is never stopped for its output: past keep bytes its first and last halves are kept, with the count left out between them, and the whole output goes to the spill file, written only then', async t => {
  const d = await scratch(t);
  const spill = { path: join(d, 'out.log'), name: '@artifact/out.log' };
  const r = await runCommand(process.execPath, ['-e', counting], d, 20000, { keep: 1000, spill });
  assert.equal(r.code, 0, 'ran to its end');
  assert.equal(r.timedOut, false);
  assert.equal(r.omitted, counted.length - 1000);
  assert.equal(r.spilled, spill.path);
  assert.equal(await readFile(spill.path, 'utf8'), counted, 'the whole output, byte for byte');
  assert(r.output.startsWith(counted.slice(0, 500)), 'its first half');
  assert(r.output.endsWith(counted.slice(-500)), 'its last half');
  assert(
    r.output.includes(
      `\n[… ${counted.length - 1000} bytes of output left out here; the whole output is in @artifact/out.log …]\n`,
    ),
  );
  const quiet = await runCommand(process.execPath, ['-e', 'console.log("short")'], d, 20000, {
    keep: 1000,
    spill: { path: join(d, 'quiet.log'), name: '@artifact/quiet.log' },
  });
  assert.equal(quiet.output, 'short\n');
  assert.equal(quiet.omitted, 0);
  assert.equal(quiet.spilled, undefined);
  assert(!existsSync(join(d, 'quiet.log')), 'nothing saved for output that fits');
  const unsaved = await runCommand(process.execPath, ['-e', counting], d, 20000, { keep: 1000 });
  assert.equal(unsaved.code, 0);
  assert.equal(unsaved.omitted, counted.length - 1000);
  assert(unsaved.output.includes(`[… ${counted.length - 1000} bytes of output left out here …]`));
});

test('The bash tool judges a command by how it ended, however much it printed, and names the artifact its whole output was saved to, which read_files reads', async t => {
  const d = await scratch(t);
  const artifacts = join(d, '.art');
  await mkdir(artifacts);
  const tools = new ToolBox(d, artifacts, { ...defaults, allowBash: true, commandTimeoutMs: 60000 }, async () => '');
  tools.step = 7;
  const r = await tools.execute('bash', { command: 'seq 1 300000', purpose: 'print two megabytes', check: true });
  assert.equal(r.ok, true, 'two megabytes of output is not a failure');
  assert.equal(r.check, true);
  const j = JSON.parse(r.text);
  assert.equal(j.code, 0);
  assert.equal(j.wholeOutput, '@artifact/00007-command-1.log');
  assert(j.omitted > 0);
  assert(
    Object.keys(j).indexOf('wholeOutput') < Object.keys(j).indexOf('output'),
    'named before the output, so the model keeps it when its copy is clipped',
  );
  const whole = await readFile(join(artifacts, '00007-command-1.log'), 'utf8');
  assert.equal(whole.split('\n').length, 300001);
  const read = await tools.execute('read_files', { files: [{ path: j.wholeOutput, start: 299999, end: 300000 }] });
  assert.match(read.text, /\n299999: 299999\n300000: 300000$/);
});

test('read_files reads a range of a file of any size, holding only that range, with the hash and line count a whole read gives', async t => {
  const d = await scratch(t);
  // About 7 MB, a byte-order mark first, and two-byte characters split across the reads' chunks.
  const text = '﻿' + Array.from({ length: 200000 }, (_, i) => `export const v${i} = ${i}; // ééé`).join('\n') + '\n';
  const path = join(d, 'big.ts');
  await writeFile(path, text);
  const whole = await boundedRead(path);
  const lines = whole.split('\n');
  const tools = new ToolBox(d, join(d, '.art'), { ...defaults }, async () => '');
  const r = await tools.execute('read_files', { files: [{ path: 'big.ts', start: 150000, end: 150002 }] });
  assert.equal(
    r.text,
    `big.ts sha256=${hash(whole)} totalLines=200001 shown=150000..150002\n150000: ${lines[149999]}\n150001: ${lines[150000]}\n150002: ${lines[150001]}`,
  );
  assert.equal(r.hashes!['big.ts'], hash(whole));
  const first = await readLines(path, 1, 2, 10000);
  assert.deepEqual(first.lines, lines.slice(0, 2), 'the byte-order mark dropped, as a whole read drops it');
  assert.equal(first.totalLines, lines.length);
  assert.equal(first.sha, hash(whole));
  assert.deepEqual((await readLines(path, 200001, 200001, 100)).lines, [''], 'the empty last line');
  const budget = await readLines(path, 1, 200000, 100);
  assert(budget.lines.length >= 1 && budget.lines.join('\n').length <= 100, 'as many as fit the budget');
  // A line longer than a read's chunk, outside the range, is counted, not held.
  await writeFile(join(d, 'min.js'), `${'x'.repeat(3_000_000)}\nafter\n`);
  const after = await readLines(join(d, 'min.js'), 2, 2, 100);
  assert.deepEqual(after.lines, ['after']);
  assert.equal(after.totalLines, 3);
  await assert.rejects(
    boundedRead(path, 1024),
    /^Error: File is \d+\.\d MiB, past the [\d.]+ MiB a file can be held whole \(to edit it\); read_files reads any range of it$/,
  );
});

test('search_codebase finds text in a file past a megabyte', async t => {
  const d = await scratch(t);
  await writeFile(join(d, 'big.txt'), `${'filler line\n'.repeat(200000)}NEEDLE_HERE\n`);
  const tools = new ToolBox(d, join(d, '.art'), { ...defaults }, async () => '');
  const r = await tools.execute('search_codebase', { mode: 'text', query: 'NEEDLE_HERE', path: '.' });
  assert.equal(r.ok, true);
  assert.match(JSON.parse(r.text).output, /big\.txt:200001:NEEDLE_HERE/);
});

test('The conversation says where a result too long to show is saved: a command whose output was saved whole says so first, and a result past the cap names its artifact', () => {
  const saved = join('s', 'artifacts', '00007.txt');
  const v = resultView(
    'bash',
    JSON.stringify({
      command: 'seq 1 300000',
      purpose: 'p',
      wholeOutput: '@artifact/00007-command-1.log',
      output: 'a\n[… 5 bytes of output left out here; the whole output is in @artifact/00007-command-1.log …]\nb\n',
      code: 0,
      omitted: 5,
      timedOut: false,
    }),
    saved,
  );
  assert.equal(v.head, '$ seq 1 300000 | exit 0');
  assert.equal(
    v.lines[0],
    `The whole output is saved at ${join('s', 'artifacts', '00007-command-1.log')}; 5 bytes of it are left out below`,
  );
  assert.equal(v.lines[1], 'a');
  const big = resultView('read_files', `x.txt sha256=1\n${`${'y'.repeat(1000)}\n`.repeat(300)}`, saved);
  assert.match(String(big.lines.at(-1)), /more characters of this result are not shown; all of it is in .*00007\.txt$/);
});
