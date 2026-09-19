# Validation — 2026-09-19

The TypeScript build and 21 automated tests pass. The actual local `bonsai-27b` endpoint and hosted `jev-1.13.0` API also completed a four-action coding task. The key was loaded from the user-provided file; this project does not contain it.

## Live result

A disposable repository contained an `add(a, b)` function that incorrectly returned `a - b`, and a Node test checking `add(2, 3) === 5` and `add(-2, 3) === 1`.

| Step | Jev-selected action | Jev latency | Bonsai prompt tokens | Bonsai output tokens |
| --- | --- | ---: | ---: | ---: |
| 1 | Read implementation and test | 438.9 ms | 342 | 38 |
| 2 | Replace subtraction with addition | 159.4 ms | 617 | 100 |
| 3 | Execute `node --test math.test.mjs` | 302.7 ms | 649 | 30 |
| 4 | Report completion | 152.5 ms | 781 | 99 |

The shell tool recorded exit code 0, one passing test, no failures, no truncation, and no timeout. An independent rerun of the test also passed. The harness reached `complete` without user intervention during this successful run.

Median Jev HTTP latency was **231.0 ms** across these four requests. Bonsai request durations were 2.61, 5.03, 3.16, and 4.48 seconds. Prompt cache hits were reported on the last three requests. These are end-to-end measurements on a shared, single-slot server, not isolated inference benchmarks.

The earlier live attempt uncovered a llama.cpp grammar rejection at `maxLength: 2000`. That attempt paused after the edit, before shell execution. A direct reproduction succeeded without that grammar bound and failed with it. The adapter now removes large string length bounds from the sampling schema while preserving local validation. The subsequent complete run above used that adjustment.

[Machine-readable results and selected event trace](validation/live-smoke.json)

## What remains unproven

- No large repository refactor or comparison against Cline has been run.
- The live smoke test was too small to trigger context compaction. Hard limits, UTF-8 decision bounds, relevance retention, compaction cooldown, and loop termination are covered by automated tests.
- Jev probabilities have not been calibrated on a coding-task evaluation set. The current thresholds are defaults.
- Peak VRAM, long-context throughput, and sustained performance on an RTX 3070 have not been measured by this harness validation.

## Reproduce

A repeatable cart-subtotal live coding test is now available:

```bash
npm run test:live -- --key-file ~/jumanji.txt
```

It creates its own disposable repository and independent verifier, then uses the real providers. This is a new fixture, distinct from the earlier arithmetic smoke test recorded above. See the README for details. The manual instructions below reproduce the original arithmetic task.

Run `npm ci && npm test` in the project directory. For provider checks, run `node dist/src/cli.js doctor --key-file PATH`.

To repeat the coding smoke test, create a disposable repository with these files:

```js
// math.mjs
export function add(a, b) {
  return a - b;
}
```

```js
// math.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { add } from './math.mjs';
test('adds signed numbers', () => {
  assert.equal(add(2, 3), 5);
  assert.equal(add(-2, 3), 1);
});
```

```bash
node dist/src/cli.js run \
  'Fix add in math.mjs so it adds its two inputs. Read math.mjs and math.test.mjs, make the minimal fix, run node --test math.test.mjs, and report the actual result. A task ledger is unnecessary for this small change.' \
  --repo /path/to/disposable/repository --key-file /path/to/key \
  --allow-write --allow-bash --max-steps 12
```
