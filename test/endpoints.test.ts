import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { loadConfig } from '../src/config.js';
import { App } from '../src/app.js';

test('/endpoints lists the model providers, chooses one for the runs, and clears the choice', async t => {
  process.env.OPENROUTER_API_KEY = 'test-key';
  const endpoints = [
    {
      tag: 'wafer/fp4',
      pricing: { prompt: '0.000002', completion: '0.00001', input_cache_read: '0.0000002' },
      context_length: 200000,
      max_completion_tokens: 64000,
      supported_parameters: ['tools', 'temperature'],
      status: 0,
      uptime_last_30m: 99,
    },
    {
      tag: 'wafer/us',
      pricing: { prompt: '0.000001', completion: '0.000005' },
      context_length: 200000,
      supported_parameters: ['tools', 'temperature'],
      status: 0,
      uptime_last_30m: 99,
    },
  ];
  const server = createServer((req, res) => {
    if (req.url?.endsWith('/endpoints')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: { endpoints } }));
    } else {
      res.writeHead(404);
      res.end('{}');
    }
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  t.after(() => new Promise(r => server.close(r)));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1`;

  const dir = await mkdtemp(join(tmpdir(), 'leana-endpoints-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'repo'));
  const settingsPath = join(dir, 'settings.json');
  const said: string[] = [];
  const app = new App({
    base: await loadConfig(undefined, { openrouterUrl: url }),
    settings: { config: { openrouterUrl: url, provider: 'openrouter', model: 'vendor/model-x' } },
    jevKey: 'j',
    repo: join(dir, 'repo'),
    settingsPath,
    write: l => said.push(l),
  });
  const run = async (line: string) => {
    said.length = 0;
    await app.handle(line);
    return said.join('\n');
  };

  const listed = await run('/endpoints');
  assert.match(listed, /providers of vendor\/model-x \(automatic\)/);
  assert.match(listed, /wafer\/fp4\s+up\s+\$2\.00 in/);
  assert.match(listed, /wafer\/us\s+up\s+\$1\.00 in/);

  assert.match(await run('/endpoints wafer/us'), /provider: wafer\/us/);
  assert.equal(JSON.parse(await readFile(settingsPath, 'utf8')).config.openrouterProvider, 'wafer/us');
  assert.match(await run('/endpoints'), /chosen: wafer\/us/);

  assert.match(await run('/endpoints no/such'), /is not a provider of vendor\/model-x/);

  assert.match(await run('/endpoints auto'), /provider: automatic/);
  assert.equal(JSON.parse(await readFile(settingsPath, 'utf8')).config.openrouterProvider, '');
});
