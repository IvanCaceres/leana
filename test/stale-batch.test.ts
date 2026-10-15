import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaults } from '../src/config.js';
import { ToolBox } from '../src/tools.js';
import { hash } from '../src/files.js';
import { mapRange } from '../src/edit-checks.js';

// A repository with one file and a ToolBox recording a batch (journal = []), as the loop sets it.
async function batch(t: any, text: string, path = 'src/Footer.tsx') {
  const root = await mkdtemp(join(tmpdir(), 'leana-stale-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, path), text);
  const tools = new ToolBox(root, join(root, '.art'), { ...defaults, allowWrite: true });
  tools.journal = [];
  return {
    tools,
    path,
    read: () => readFile(join(root, path), 'utf8'),
    write: (s: string) => writeFile(join(root, path), s),
  };
}
// Run 56 Footer.tsx, before step 45: the import names change at line 2, the uses at lines 5..7.
const footer = [
  "import { Link } from 'react-router-dom'",
  "import { Mail, Phone, GitHub, Twitter, LinkedIn } from 'lucide-react'",
  '',
  'const socialLinks = [',
  "  { icon: GitHub, href: 'https://github.com', label: 'GitHub' },",
  "  { icon: Twitter, href: 'https://twitter.com', label: 'Twitter' },",
  "  { icon: LinkedIn, href: 'https://linkedin.com', label: 'LinkedIn' },",
  ']',
  '',
  'export default function Footer() {',
  '  return <footer>{socialLinks.map(s => <a key={s.label} href={s.href}><s.icon /></a>)}<Link to="/"><Mail /><Phone /></Link></footer>',
  '}',
  '',
].join('\n');
const uses =
  "  { icon: Code, href: 'https://github.com', label: 'GitHub' },\n  { icon: Users, href: 'https://twitter.com', label: 'Twitter' },\n  { icon: Globe, href: 'https://linkedin.com', label: 'LinkedIn' },";

test('Two edits of one file in one batch, both numbered as in the same read: the second is mapped through the first and lands as one call would have made it (run 56 Footer)', async t => {
  const { tools, path, read } = await batch(t, footer);
  const h = hash(footer);
  tools.step = 45;
  await tools.execute('replace_lines', {
    path,
    expectedHash: h,
    edits: [{ start: 2, end: 2, newText: "import { Mail, Phone, Globe, Code, Users } from 'lucide-react'" }],
  });
  tools.step = 46;
  const r = await tools.execute('replace_lines', {
    path,
    expectedHash: h,
    edits: [{ start: 5, end: 7, newText: uses }],
  });
  assert.equal(r.ok, true);
  assert.match(
    r.text,
    /numbered as in sha256=\w+, the text before step 45 of this batch, and were mapped to the current text: 5\.\.7 -> 5\.\.7/,
  );
  const one = await batch(t, footer);
  await one.tools.execute('replace_lines', {
    path,
    expectedHash: h,
    edits: [
      { start: 2, end: 2, newText: "import { Mail, Phone, Globe, Code, Users } from 'lucide-react'" },
      { start: 5, end: 7, newText: uses },
    ],
  });
  assert.equal(await read(), await one.read(), 'the same text as both ranges in one call');
});

test('A range below an earlier edit that changed the line count moves with it (run 14 Testimonials: a deleted import shifts line 11 to 10)', async t => {
  const text = ['a', 'b', 'c', 'd', 'e', 'f', ''].join('\n');
  const { tools, path, read } = await batch(t, text);
  const h = hash(text);
  tools.step = 33;
  await tools.execute('replace_lines', { path, expectedHash: h, edits: [{ start: 2, end: 2, newText: '' }] });
  tools.step = 34;
  const r = await tools.execute('replace_lines', {
    path,
    expectedHash: h,
    edits: [
      { start: 5, end: 5, newText: 'E' },
      { start: 1, end: 0, newText: 'top' },
    ],
  });
  assert.match(r.text, /5\.\.5 -> 4\.\.4, 1\.\.0 -> 1\.\.0/);
  assert.equal(await read(), ['top', 'a', 'c', 'd', 'E', 'f', ''].join('\n'));
});

test('A range an earlier edit of the batch changed is refused with the facts: which step, what it replaced, the hashes, the file now, and that one call carries several ranges', async t => {
  const { tools, path, read } = await batch(t, footer);
  const h = hash(footer);
  tools.step = 7;
  const first = await tools.execute('replace_lines', {
    path,
    expectedHash: h,
    edits: [{ start: 5, end: 6, newText: "  { icon: Code, href: 'https://github.com', label: 'GitHub' }," }],
  });
  const now = await read();
  tools.step = 8;
  await assert.rejects(
    tools.execute('replace_lines', { path, expectedHash: h, edits: [{ start: 6, end: 7, newText: 'x' }] }),
    (e: Error) => {
      assert.match(
        e.message,
        new RegExp(
          `Stale file hash for ${path}: ${h} is the text before an earlier edit of this batch: step 7 \\(replace_lines\\) replaced 5\\.\\.6 -> 1 line\\(s\\), sha256 ${h} -> ${first.hashes![path]}\\.`,
        ),
      );
      assert.match(e.message, /Range\(s\) 6\.\.7 of this edit cover lines that edit changed/);
      assert.match(e.message, new RegExp(`is now sha256=${hash(now)} totalLines=${now.split('\n').length}`));
      assert.match(e.message, /One replace_lines call carries several ranges of one file, all numbered as in one read/);
      return true;
    },
  );
  assert.equal(await read(), now, 'nothing written');
});

test('An insertion lands where one call would put it: inside a replaced block is refused, at its edge it is not', async () => {
  const c = [{ start: 5, end: 7, count: 2 }];
  assert.deepEqual(mapRange(8, 8, c), { start: 7, end: 7 });
  assert.deepEqual(mapRange(4, 4, c), { start: 4, end: 4 });
  assert.equal(mapRange(7, 8, c), null);
  assert.equal(mapRange(6, 5, c), null, 'an insertion before line 6 falls inside 5..7');
  assert.deepEqual(mapRange(5, 4, c), { start: 5, end: 4 }, 'before the replaced block');
  assert.deepEqual(mapRange(8, 7, c), { start: 7, end: 6 }, 'after it');
  const ins = [{ start: 3, end: 2, count: 2 }];
  assert.deepEqual(mapRange(3, 3, ins), { start: 5, end: 5 }, 'lines inserted before line 3 move it down');
  assert.equal(mapRange(2, 3, ins), null, 'lines inserted between 2 and 3 split the range');
  assert.deepEqual(
    mapRange(3, 2, ins),
    { start: 5, end: 4 },
    'a second insertion before the same line follows the first',
  );
});

test('An earlier anchor write of the batch maps forward too; an earlier whole-file rewrite maps nothing, and says so', async t => {
  const text = ['one', 'two', 'three', 'four', ''].join('\n');
  const w = await batch(t, text);
  const h = hash(text);
  w.tools.step = 3;
  await w.tools.execute('write', { path: w.path, expectedHash: h, oldText: 'two', newText: 'two\ntwo-b\ntwo-c' });
  w.tools.step = 4;
  await w.tools.execute('replace_lines', {
    path: w.path,
    expectedHash: h,
    edits: [{ start: 4, end: 4, newText: 'FOUR' }],
  });
  assert.equal(await w.read(), ['one', 'two', 'two-b', 'two-c', 'three', 'FOUR', ''].join('\n'));
  const r = await batch(t, text);
  r.tools.step = 3;
  await r.tools.execute('write', {
    path: r.path,
    expectedHash: h,
    oldText: text,
    newText: 'all new\n',
    wholeFile: true,
  });
  r.tools.step = 4;
  await assert.rejects(
    r.tools.execute('replace_lines', { path: r.path, expectedHash: h, edits: [{ start: 4, end: 4, newText: 'FOUR' }] }),
    /step 3 \(rewrite\) replaced the whole file.*No range of the earlier text maps into a whole-file replacement/,
  );
});

test('Through several earlier edits of the batch; a later anchor write with an old hash is refused with the same facts', async t => {
  const text = ['a', 'b', 'c', 'd', 'e', 'f', 'g', ''].join('\n');
  const { tools, path, read } = await batch(t, text);
  const h = hash(text);
  tools.step = 1;
  const r1 = await tools.execute('replace_lines', {
    path,
    expectedHash: h,
    edits: [{ start: 1, end: 0, newText: 'x\ny' }],
  });
  tools.step = 2;
  await tools.execute('replace_lines', { path, expectedHash: h, edits: [{ start: 3, end: 3, newText: '' }] });
  tools.step = 3;
  const r3 = await tools.execute('replace_lines', {
    path,
    expectedHash: h,
    edits: [{ start: 6, end: 6, newText: 'F' }],
  });
  assert.match(r3.text, /before step 1, 2 of this batch/);
  assert.equal(await read(), ['x', 'y', 'a', 'b', 'd', 'e', 'F', 'g', ''].join('\n'));
  tools.step = 4;
  await assert.rejects(
    tools.execute('write', { path, expectedHash: r1.hashes![path], oldText: 'g', newText: 'G' }),
    /before an earlier edit of this batch: step 2 \(replace_lines\) replaced 5\.\.5 -> 0 line\(s\), sha256 \w+ -> \w+; then step 3 \(replace_lines\) replaced 7\.\.7 -> 1 line\(s\).*is now sha256=\w+ totalLines=9\. One replace_lines call carries several ranges/,
  );
});

test("A hash the batch's own edits do not account for keeps the plain stale refusal: outside a batch, an older read, or a file a command changed", async t => {
  const text = ['a', 'b', 'c', ''].join('\n');
  const plain = (e: Error) =>
    /^Stale file hash for src\/Footer\.tsx: read the file again and use the sha256 from that result$/.test(e.message);
  const outside = await batch(t, text);
  outside.tools.journal = null;
  const h = hash(text);
  await outside.tools.execute('replace_lines', {
    path: outside.path,
    expectedHash: h,
    edits: [{ start: 1, end: 1, newText: 'A' }],
  });
  await assert.rejects(
    outside.tools.execute('replace_lines', {
      path: outside.path,
      expectedHash: h,
      edits: [{ start: 3, end: 3, newText: 'C' }],
    }),
    plain,
  );
  const old = await batch(t, text);
  await assert.rejects(
    old.tools.execute('replace_lines', {
      path: old.path,
      expectedHash: '0123456789abcdef',
      edits: [{ start: 3, end: 3, newText: 'C' }],
    }),
    plain,
  );
  const cmd = await batch(t, text);
  await cmd.tools.execute('replace_lines', {
    path: cmd.path,
    expectedHash: h,
    edits: [{ start: 1, end: 1, newText: 'A' }],
  });
  await cmd.write('A\nb\nc\nd\n');
  await assert.rejects(
    cmd.tools.execute('replace_lines', {
      path: cmd.path,
      expectedHash: h,
      edits: [{ start: 3, end: 3, newText: 'C' }],
    }),
    plain,
  );
});

test("A mapped edit meets every guard an edit of the current file meets: one that would break the parse is refused with the parser's message", async t => {
  const text = ['export function f() {', '  return 1', '}', '', 'export const g = 2', ''].join('\n');
  const { tools, path, read } = await batch(t, text, 'src/f.ts');
  const h = hash(text);
  tools.step = 1;
  await tools.execute('replace_lines', {
    path,
    expectedHash: h,
    edits: [{ start: 1, end: 0, newText: "import { x } from './x'" }],
  });
  const now = await read();
  tools.step = 2;
  await assert.rejects(
    tools.execute('replace_lines', { path, expectedHash: h, edits: [{ start: 3, end: 3, newText: '' }] }),
    /unmatched|parse/,
  );
  assert.equal(await read(), now);
});

test('An earlier region rewrite of the batch is recorded as the lines it replaced: a later edit below it maps, one inside it is refused naming that region', async t => {
  const text = ['a', 'b', 'c', 'd', 'e', 'f', ''].join('\n');
  const h = hash(text);
  const regionText = ['a', 'BC', 'd', 'e', 'f', ''].join('\n');
  const { tools, path, read } = await batch(t, text);
  tools.step = 3;
  await tools.execute('write', {
    path,
    expectedHash: h,
    oldText: text,
    newText: regionText,
    wholeFile: true,
    region: { start: 2, end: 3, lines: 1 },
  });
  tools.step = 4;
  const r = await tools.execute('replace_lines', {
    path,
    expectedHash: h,
    edits: [{ start: 5, end: 5, newText: 'E' }],
  });
  assert.match(r.text, /5\.\.5 -> 4\.\.4/);
  assert.equal(await read(), ['a', 'BC', 'd', 'E', 'f', ''].join('\n'));
  tools.step = 5;
  await assert.rejects(
    tools.execute('replace_lines', { path, expectedHash: h, edits: [{ start: 3, end: 3, newText: 'C' }] }),
    /step 3 \(rewrite_file\) replaced 2\.\.3 -> 1 line\(s\)/,
  );
});

test('An insertion before line k and a replacement of k..m, mapped into one call, apply in either order (review of the run-56 patch)', async t => {
  const text = 'a\nb\nc\nd\n';
  for (const order of [0, 1]) {
    const { tools, path, read } = await batch(t, text, 'src/f.ts');
    const edits = [
      { start: 3, end: 2, newText: 'ins' },
      { start: 3, end: 3, newText: 'C' },
    ];
    const r = await tools.execute('replace_lines', {
      path,
      expectedHash: hash(text),
      edits: order ? edits.reverse() : edits,
    });
    assert.equal(r.ok, true, `order ${order}`);
    assert.equal(await read(), 'a\nb\nins\nC\nd\n', `order ${order}`);
  }
});

test('A refusal of a mapped replace_lines states the mapping, so its line numbers are not mistaken for those of the read', async t => {
  const text = 'const a = 1;\nconst b = 2;\nconst c = 3;\n';
  const { tools, path } = await batch(t, text, 'src/f.ts');
  const h = hash(text);
  tools.step = 1;
  await tools.execute('replace_lines', {
    path,
    expectedHash: h,
    edits: [{ start: 1, end: 0, newText: 'import { x } from "./x";' }],
  });
  tools.step = 2;
  await assert.rejects(
    tools.execute('replace_lines', { path, expectedHash: h, edits: [{ start: 3, end: 3, newText: 'const c = (;' }] }),
    /Edit refused[\s\S]*were mapped to the current text: 3\.\.3 -> 4\.\.4\. Line numbers in this message are those of the current text, sha256=\w+\./,
  );
});

test('A write whose anchor ends with a line break is recorded as the lines that changed, so a later edit of the next line maps', async t => {
  const text = 'one\ntwo\nthree\nfour\n';
  const { tools, path, read } = await batch(t, text, 'src/f.ts');
  const h = hash(text);
  tools.step = 1;
  await tools.execute('write', { path, expectedHash: h, oldText: 'two\n', newText: 'TWO\n' });
  tools.step = 2;
  const r = await tools.execute('replace_lines', {
    path,
    expectedHash: h,
    edits: [{ start: 3, end: 3, newText: 'THREE' }],
  });
  assert.equal(r.ok, true);
  assert.equal(await read(), 'one\nTWO\nTHREE\nfour\n');
});
