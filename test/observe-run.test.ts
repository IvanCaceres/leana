import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canvasFacts, findBrowser, renderFacts } from '../src/render.js';
import { unscriptedStart } from '../src/repository.js';

const scratch = async (t: any) => {
  const d = await mkdtemp(join(tmpdir(), 'leana-observe-'));
  t.after(() => rm(d, { recursive: true, force: true }));
  return d;
};

test('A canvas is described as blank (one grey level everywhere) or drawn, with how much of it differs from its background and where', () => {
  const blank = '0'.repeat(96 * 72);
  // A 24x18-cell block of level 9 at cells (48..71, 36..53) on a canvas of 960x720.
  const drawn = [...blank]
    .map((g, k) => (k % 96 >= 48 && k % 96 < 72 && k >= 36 * 96 && k < 54 * 96 ? '9' : g))
    .join('');
  const snap = (cells: string | null) => ({
    text: '',
    frames: 0,
    t: 0,
    canvases: [{ name: 'canvas', w: 960, h: 720, cells }],
  });
  assert.deepEqual(canvasFacts(snap(blank)), ['canvas (960x720): blank, one grey level (0 of 15) everywhere']);
  assert.deepEqual(canvasFacts(snap(drawn)), [
    'canvas (960x720): drawn, 2 grey levels; 6.3% of it differs from its most common level (0 of 15), within x 480..720, y 360..540',
  ]);
  assert.deepEqual(canvasFacts(snap(null)), ['canvas (960x720): not readable (drawn from another origin)']);
});

test('A WebGL scene is observed as it draws: its canvas reads as drawn, and as changing while it animates (run brunner: every observation of a drawn 3D city said "canvas: unchanged")', async t => {
  if (!(await findBrowser())) return;
  const root = await scratch(t);
  // Drawn as a 3D page draws: a WebGL context with the default (cleared) drawing buffer, a frame each animation frame,
  // a magenta block moving across a black canvas.
  await writeFile(
    join(root, 'index.html'),
    `<!doctype html><body style="margin:0"><canvas width="480" height="240"></canvas><script>
const gl = document.querySelector('canvas').getContext('webgl');
const frame = t => { gl.disable(gl.SCISSOR_TEST); gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
  gl.enable(gl.SCISSOR_TEST); gl.scissor(Math.floor(t / 10) % 400, 80, 80, 80); gl.clearColor(1, 0, 1, 1); gl.clear(gl.COLOR_BUFFER_BIT);
  requestAnimationFrame(frame); };
requestAnimationFrame(frame);
</script></body>`,
  );
  const port = 39000 + Math.floor(Math.random() * 900);
  await writeFile(
    join(root, 'serve.mjs'),
    `import { createServer } from "node:http"; import { readFileSync } from "node:fs"; createServer((q, r) => { r.setHeader("content-type", "text/html"); r.end(readFileSync("index.html")); }).listen(${port}, "127.0.0.1", () => console.log("Local: http://127.0.0.1:${port}/"));\n`,
  );
  const r = await renderFacts(root, `http://127.0.0.1:${port}/`, 'node serve.mjs', null, 60000, [
    { do: 'wait', what: '', ms: 1000 },
  ]);
  assert.equal(r.ok, true, r.text);
  assert.match(
    r.text,
    /\nCanvas: canvas \(480x240\): drawn, \d+ grey levels; [\d.]+% of it differs from its most common level/,
  );
  assert.match(r.text, /\n1\. waited 1000 ms: \d+ frames drawn in [\d.]+ s; canvas \(480x240\): [\d.]+% of it changed/);
});

test('A start command its package has no script for is found: the package of its `cd`, by a script name or by the program a script runs', async t => {
  const root = await scratch(t);
  await mkdir(join(root, 'app'));
  await writeFile(
    join(root, 'app', 'package.json'),
    JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' }, dependencies: { vite: '^8' } }),
  );
  const at = (start: string) => unscriptedStart(root, start);
  assert.deepEqual(await at('cd app && npx vite preview --port 4173 --strictPort'), {
    dir: 'app',
    command: 'npx vite preview --port 4173 --strictPort',
    scripts: ['test'],
  });
  assert.deepEqual(await at(`cd "${join(root, 'app')}" && npm run dev`), {
    dir: 'app',
    command: 'npm run dev',
    scripts: ['test'],
  });
  assert.equal(await at('cd app && npm test'), null, 'npm test runs its test script');
  assert.equal(await at('python -m http.server 8000'), null, 'no package.json at the root: nothing to say');
  assert.equal(await at('cd .. && npx vite'), null, 'outside the repository: not looked at');
  await writeFile(
    join(root, 'app', 'package.json'),
    JSON.stringify({ scripts: { dev: 'vite', preview: 'vite preview' } }),
  );
  assert.equal(await at('cd app && npx vite preview --port 4173'), null, 'a script runs the same program');
  assert.equal(await at('cd app && npm run dev'), null);
  assert.deepEqual(await at('cd app && npm run serve'), {
    dir: 'app',
    command: 'npm run serve',
    scripts: ['dev', 'preview'],
  });
  if (process.platform === 'win32') {
    const shell = root.replace(/^([A-Za-z]):/, (_, d: string) => `/${d.toLowerCase()}`).replace(/\\/g, '/');
    assert.equal(await at(`cd ${shell}/app && npx vite`), null, "Git Bash's /c/... spelling is the same directory");
  }
});

test("A server is not started where another already listens: what answers there is that server, so the observation is refused and names a free port (run brunner2: another project's Vite server answered, and the run was accepted on it)", async t => {
  const { createServer } = await import('node:http');
  const { startServer, notAnswering } = await import('../src/serve.js');
  const root = await scratch(t);
  const other = createServer((q, r) => r.end('<title>another project</title>'));
  await new Promise<void>(done => other.listen(0, '127.0.0.1', () => done()));
  t.after(() => other.close());
  const url = `http://127.0.0.1:${(other.address() as { port: number }).port}/`;
  await writeFile(join(root, 'started.txt'), '');
  const started = await startServer(root, 'echo started > started.txt', url, 5000);
  assert.equal(started.ready, 'occupied');
  assert.equal(started.exited?.(), 'not started');
  const said = await notAnswering('npx vite --port 5173 --strictPort', url, started, 5000);
  assert.match(
    said,
    /^Something was already listening at 127\.0\.0\.1:\d+ before "npx vite --port 5173 --strictPort" was started, so it was not started: .* \(\d+ is free now\): change the port in both start and target\.$/,
  );
  const { readFile } = await import('node:fs/promises');
  assert.equal(await readFile(join(root, 'started.txt'), 'utf8'), '', 'the command never ran');
});
