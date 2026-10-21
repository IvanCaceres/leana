import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { diffLines } from '../src/diff.js';
import { KeyReader } from '../src/tui/keys.js';
import { Terminal } from '../src/tui/terminal.js';
import { renderBlock, styles, Transcript } from '../src/tui/transcript.js';
import { TerminalUI } from '../src/tui/view.js';
import type { ProgressEvent } from '../src/display.js';

const plain = styles(false);

// A terminal in memory: keys are emitted as input data, frames are collected as written.
function fakeTerminal(columns = 100, rows = 30) {
  const input = Object.assign(new EventEmitter(), {
    isTTY: true,
    raw: false,
    setRawMode(m: boolean) {
      this.raw = m;
    },
    resume() {},
    pause() {},
  });
  const writes: string[] = [];
  const output = Object.assign(new EventEmitter(), { columns, rows, write: (s: string) => writes.push(s) });
  const term = new Terminal(input as any, output as any);
  return { term, input, output, writes, type: (s: string) => input.emit('data', Buffer.from(s, 'utf8')) };
}

test('Keys are read from raw terminal input: text, control keys, escape sequences split across reads, the mouse wheel and a paste', () => {
  const r = new KeyReader();
  assert.deepEqual(r.feed('ab\r'), [{ name: 'text', text: 'ab' }, { name: 'enter' }]);
  assert.deepEqual(r.feed('\x1b[A\x1b[B\x1b[5~\x1b[6~\x1b[3~\x1b[H\x1b[4~\x1bOF'), [
    { name: 'up' },
    { name: 'down' },
    { name: 'pageup' },
    { name: 'pagedown' },
    { name: 'delete' },
    { name: 'home' },
    { name: 'end' },
    { name: 'end' },
  ]);
  assert.deepEqual(r.feed('\x1b['), [], 'an unfinished sequence waits');
  assert.deepEqual(r.feed('D'), [{ name: 'left' }]);
  assert.deepEqual(
    r.feed('\x1b[<64;10;5M\x1b[<65;10;5M\x1b[<0;3;3M'),
    [{ name: 'wheelup' }, { name: 'wheeldown' }],
    'a click is not a key',
  );
  assert.deepEqual(r.feed('\x03\x7f\t\x1b[Z'), [
    { name: 'ctrl', key: 'c' },
    { name: 'backspace' },
    { name: 'tab' },
    { name: 'shift-tab' },
  ]);
  assert.deepEqual(r.feed('\x1b[200~line 1\r\nline 2'), [], 'a paste waits for its end');
  assert.deepEqual(
    r.feed('\x1b[201~x'),
    [
      { name: 'paste', text: 'line 1\nline 2' },
      { name: 'text', text: 'x' },
    ],
    'its line breaks are not Enter',
  );
  assert.deepEqual(r.feed('\x1b'), [{ name: 'escape' }]);
});

test('A diff shows the changed lines with three lines around them, numbered as in each text; a new file is all added', () => {
  const before = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
  const after = before.replace('line 5\n', 'line five\n').replace('line 16\n', '');
  const d = diffLines(before, after);
  assert.deepEqual([d.added, d.removed, d.hunks.length], [1, 2, 2]);
  assert.deepEqual(
    d.hunks[0]!.lines.map(l => `${l.kind}${l.old ?? ''}/${l.new ?? ''} ${l.text}`),
    [
      ' 2/2 line 2',
      ' 3/3 line 3',
      ' 4/4 line 4',
      '-5/ line 5',
      '+/5 line five',
      ' 6/6 line 6',
      ' 7/7 line 7',
      ' 8/8 line 8',
    ],
  );
  assert.deepEqual(
    d.hunks[1]!.lines.filter(l => l.kind !== ' ').map(l => `${l.kind}${l.old} ${l.text}`),
    ['-16 line 16'],
  );
  const created = diffLines('', 'a\nb\n');
  assert.deepEqual(
    [created.added, created.removed, created.hunks[0]!.lines.map(l => `${l.kind}${l.new}`)],
    [2, 0, ['+1', '+2']],
  );
  assert.deepEqual(diffLines('same\n', 'same\n').hunks, []);
  const big = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag} ${i}`).join('\n');
  const huge = diffLines(big(2500, 'a'), big(2500, 'b'));
  assert.deepEqual([huge.removed, huge.added], [2500, 2500], 'too large to align: removed, then added');
});

test('The conversation renders blocks that fold: a folded block shows its title and first rows, and how many more there are', () => {
  const t = new Transcript();
  const b = t.add('ok', 'read_files ok', ['one', 'two', 'three', 'four', 'five'], { collapsed: true, preview: 2 });
  let rows = t.rows(60, null, plain).map(r => r.text);
  assert.deepEqual(rows, [
    '+ v read_files ok',
    '    one',
    '    two',
    '    ... 3 more lines (Tab, then Enter to unfold)',
  ]);
  t.toggle(b.id);
  rows = t.rows(60, null, plain).map(r => r.text);
  assert.equal(rows.length, 6, 'unfolded: every line');
  assert.equal(rows[0], '- v read_files ok');
  const diff = renderBlock(
    {
      id: 9,
      tone: 'diff',
      title: 'Edited a.ts (+1 -1)',
      body: [
        { mark: '@', text: '@@ -4 +4 @@' },
        { mark: '-', text: 'old', number: 4 },
        { mark: '+', text: 'new', number: 4 },
      ],
      collapsed: false,
      preview: 3,
      version: 0,
    },
    40,
    false,
    plain,
  );
  assert.deepEqual(diff, ['- ~ Edited a.ts (+1 -1)', '    @@ -4 +4 @@', '    4 - old', '    4 + new']);
  const long = renderBlock(
    {
      id: 10,
      tone: 'info',
      title: 'x'.repeat(80),
      body: ['word '.repeat(30)],
      collapsed: false,
      preview: 3,
      version: 0,
    },
    40,
    false,
    plain,
  );
  assert(
    long.every(r => r.length <= 40),
    'every row fits the width',
  );
});

test('A frame rewrites only the rows that changed, in one write, and the terminal is restored on leaving', () => {
  const { term, writes, input } = fakeTerminal();
  term.enter(
    () => {},
    () => {},
  );
  assert.equal(input.raw, true);
  term.draw(['a', 'b', 'c'], null);
  writes.length = 0;
  term.draw(['a', 'B', 'c'], { row: 0, col: 5 });
  assert.equal(writes.length, 1);
  assert(writes[0]!.includes('\x1b[2;1HB') && !writes[0]!.includes('\x1b[1;1H') && !writes[0]!.includes('\x1b[3;1H'));
  term.leave();
  assert.equal(input.raw, false);
  assert(writes.at(-1)!.includes('\x1b[?1049l'), 'the shell screen is back');
});

test('A long first line kept whole in the body is not repeated there when the title shows all of it', () => {
  const block = (title: string) => ({
    id: 1,
    tone: 'info' as const,
    title,
    body: [title],
    collapsed: false,
    preview: 8,
    version: 0,
  });
  const fits = 'Session: C:\\Users\\someone\\.local\\state\\leana\\repo-1234\\runs\\2026-10-21T16-13-29-733Z-ce815d4b';
  assert.equal(
    renderBlock(block(fits), 140, false, plain).filter(r => r.includes('ce815d4b')).length,
    1,
    'shown once, as the title',
  );
  const long = `COMPLETE: ${'word '.repeat(40).trim()}`;
  const rows = renderBlock(block(long), 80, false, plain);
  assert(
    rows.length > 2 && rows.slice(1).join(' ').includes('word word'),
    'a title cut at the width keeps the whole line below',
  );
});

test('The mouse is left to the terminal, so text on the screen can be selected and copied; with the mouse on, the wheel scrolls', () => {
  const { term, writes } = fakeTerminal();
  term.enter(
    () => {},
    () => {},
  );
  assert(!writes.join('').includes('\x1b[?1000h'), 'no mouse reports: a drag selects text');
  assert(writes.join('').includes('\x1b[?1007l'), 'the wheel is not turned into Up and Down, which recall history');
  term.setMouse(true);
  assert.equal(writes.at(-1), '\x1b[?1000h\x1b[?1006h');
  term.leave();
  assert(writes.at(-1)!.includes('\x1b[?1000l') && writes.at(-1)!.includes('\x1b[?1007h'), 'both as they were');
  writes.length = 0;
  term.enter(
    () => {},
    () => {},
  );
  assert(writes.join('').includes('\x1b[?1000h'), 'kept when the screen is entered again');
  term.setMouse(false);
  assert.equal(writes.at(-1), '\x1b[?1006l\x1b[?1000l');
  term.leave();
});

test('The app as a terminal UI: a status bar, the conversation as blocks, an input box; Enter submits, Up recalls; during a run the input is guidance and the run shows its steps, results, diffs and usage', async () => {
  const f = fakeTerminal(110, 30);
  const submitted: string[] = [];
  let interrupts = 0;
  const ui = new TerminalUI({
    terminal: f.term,
    color: false,
    title: '/repo',
    model: 'openrouter:claude-haiku-5.5',
    submit: l => submitted.push(l),
    interrupt: () => interrupts++,
  });
  ui.start();
  ui.message('Leana: ready.');
  f.type('fix the parser');
  f.type('\r');
  f.type('\x1b[A');
  ui.draw();
  assert.deepEqual(submitted, ['fix the parser']);
  let screen = f.term.screen;
  assert.match(screen[0]!, /^ Leana \| claude-haiku-5\.5 \| ready +$/, 'the model by its own name');
  assert.match(screen.at(-1)!, /^> fix the parser/, 'Up recalls the last line');
  f.type('\x03');
  assert.equal(interrupts, 1);

  const run = ui.run({ objective: 'o', session: 's', verbose: false, model: 'openrouter:claude-haiku-5.5' });
  const events: ProgressEvent[] = [
    { kind: 'step', step: 1, phase: 'implement', maxStep: 0, turn: 1, maxTurn: 120 },
    {
      kind: 'context',
      step: 1,
      tokens: 42000,
      workingTokens: 90000,
      contextWindow: 1000000,
      breakdown: {},
      entries: 3,
    },
    {
      kind: 'thinking',
      step: 1,
      text: 'Read the parser first.',
      tokens: 20,
      actions: [{ action: 'read_files', args: { files: [{ path: 'src/p.ts', start: 1, end: 9 }] } }],
    },
    {
      kind: 'thought',
      step: 1,
      thought: 'Read the parser first.',
      actions: [{ action: 'read_files', args: { files: [{ path: 'src/p.ts', start: 1, end: 9 }] } }],
    },
    {
      kind: 'generated',
      step: 1,
      route: 'step',
      args: {},
      meta: {
        ms: 900,
        promptTokens: 42000,
        usage: {
          prompt_tokens: 42000,
          completion_tokens: 300,
          prompt_tokens_details: { cached_tokens: 40000 },
          cost: 0.0012,
        },
      },
    },
    {
      kind: 'result',
      step: 1,
      route: 'read_files',
      ok: true,
      ms: 3,
      chars: 40,
      text: 'src/p.ts sha256=abc totalLines=9\n1: export const p = 1;',
    },
    {
      kind: 'edit',
      step: 2,
      path: 'src/p.ts',
      created: false,
      added: 1,
      removed: 1,
      hunks: diffLines('export const p = 1;\n', 'export const p = 2;\n').hunks,
    },
  ];
  for (const e of events) run.update(e);
  ui.draw();
  screen = f.term.screen;
  const text = screen.join('\n');
  assert.match(
    screen[0]!,
    /^ Leana \| claude-haiku-5\.5 \| turn 1\/120 \| context 47% \| 42\.0k in, 95% cached \| 300 out \| \$0\.001 \| running +$/,
    'at 110 columns the step and the clock make room, and the context shows its share alone',
  );
  assert.match(text, /\* Step 1\n {4}Read the parser first\.\n {4}-> read_files src\/p\.ts 1\.\.9/);
  assert.match(text, /v read_files ok \| 3ms \| src\/p\.ts sha256=abc totalLines=9/);
  assert.match(
    text,
    /~ Edited src\/p\.ts \(\+1 -1\)\n {4}@@ -1 \+1 @@\n {4}1 - export const p = 1;\n {4}1 \+ export const p = 2;/,
  );
  assert.match(screen.at(-2)!, /Enter: guide the run/);
  f.type('\x15also add a test\r');
  assert.deepEqual(submitted, ['fix the parser', 'also add a test'], 'during a run Enter is guidance');

  // Tab browses the blocks: Enter unfolds the selected one, Esc goes back to the input.
  f.type('\t');
  f.type('\x1b[A'); // from the newest block (the diff) to the result before it
  ui.draw();
  assert.match(f.term.screen.at(-2)!, /Up\/Down: select \| Enter: fold\/unfold/);
  f.type('\r');
  ui.draw();
  assert.match(
    f.term.screen.join('\n'),
    /- v read_files ok \| 3ms \| src\/p\.ts sha256=abc totalLines=9\n {4}1: export const p = 1;/,
    'the result unfolded',
  );
  f.type('\x1b');
  // PgUp scrolls back; the hint says how far.
  for (let i = 0; i < 40; i++) ui.message(`note ${i}`);
  f.type('\x1b[5~');
  ui.draw();
  assert.match(f.term.screen.at(-2)!, /\d+ rows below/);
  run.close();
  ui.draw();
  assert.match(f.term.screen[0]!, /\| done +$/);
  ui.stop();
});

test('A result is shown whole, as the tool returned it: a command as its command, its exit and its output as lines, then the notes the harness added; only a result past 200,000 characters is cut, with how much was left; a diff block holds at most 400 lines', () => {
  const f = fakeTerminal(100, 40);
  const ui = new TerminalUI({
    terminal: f.term,
    color: false,
    title: '/repo',
    model: 'm',
    submit: () => {},
    interrupt: () => {},
  });
  ui.start();
  const run = ui.run({ objective: 'o', session: 's', verbose: false });
  const output = Array.from({ length: 300 }, (_, i) => `test ${i} passed`).join('\n') + '\nnot ok 301 parser\n';
  run.update({
    kind: 'result',
    step: 1,
    route: 'bash',
    ok: false,
    ms: 5200,
    chars: 9000,
    text: `${JSON.stringify({ command: 'npm test', purpose: 'check', output, code: 1, omitted: 0, timedOut: false })}\nJev reads this failure as: code_bug (the code or configuration written is wrong).`,
  });
  const result = ui.transcript.list.at(-1)!;
  assert.equal(result.title, 'bash failed | 5.2s | $ npm test | exit 1');
  assert.equal(result.body.length, 302, 'every line of the output, and the note');
  assert.equal(result.body[300], 'not ok 301 parser');
  assert.match(String(result.body.at(-1)), /^Jev reads this failure as: code_bug/);
  run.update({
    kind: 'result',
    step: 2,
    route: 'bash',
    ok: true,
    ms: 1,
    chars: 300000,
    text: JSON.stringify({ command: 'cat big.log', output: 'x'.repeat(1000).concat('\n').repeat(300), code: 0 }),
  });
  const big = ui.transcript.list.at(-1)!;
  assert.equal(big.body.length, 200, 'as much as 200,000 characters hold');
  assert.match(String(big.body.at(-1)), /^\.\.\. \d+ more characters of this result are not shown$/);
  const content = Array.from({ length: 1000 }, (_, i) => `line ${i}`).join('\n') + '\n';
  run.update({
    kind: 'edit',
    step: 2,
    path: 'big.ts',
    created: true,
    added: 1000,
    removed: 0,
    hunks: diffLines('', content).hunks,
  });
  const diff = ui.transcript.list.at(-1)!;
  assert.equal(diff.body.length, 401);
  assert.deepEqual(diff.body.at(-1), { mark: '@', text: '... 601 more lines of the diff are not shown' });
  run.close();
  ui.stop();
});
