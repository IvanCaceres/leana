# Order-processing refactor benchmark

Run from the Leana project directory with llama-server running:

```bash
npm run bench:refactor -- --key-file ~/jumanji.txt
```

For repeated trials:

```bash
npm run bench:refactor -- --key-file ~/jumanji.txt --runs 3
```

Each run starts from fresh code and gets up to 80 agent steps and 20 minutes. Override with `--max-steps N` and `--timeout-minutes N`. The command also accepts `--config PATH`, `--env-file PATH`, or `TYPESAFE_API_KEY` instead of a key file. TypeScript is a development dependency used by the benchmark's adapter checks; use `npm ci`, not `npm ci --omit=dev`.

The benchmark enables the harness's write and shell capabilities. It uses a disposable directory, with the same unsandboxed shell permissions as other Leana runs. Fixtures, diffs, and logs are retained under `work/benchmarks/`.

## Task and scope

`order-refactor-v1` starts with twelve project files, including eight source files and 159 source lines. Three channels—checkout, subscription renewal, and quotation—duplicate validation, pricing, and invoice creation. Four consumers depend on their exact outputs. This is a bounded, synthetic multi-file extraction task; it is materially broader than the single-function live test, but it is not a large production-codebase benchmark.

The requested result adds three shared modules and rewrites the three adapters:

- `validateOrder`: preserves validation order, errors, and normalized lines.
- `priceOrder`: calculates discounts, shipping, taxes and totals without side effects or clocks.
- `createInvoice`: composes pricing and the injected clock.

The original entry-point APIs and downstream consumers must keep working. Integer-cent rounding, optional values, quote expiry, input mutation, clock call counts, error names and messages are part of the contract. Tests and non-source files must remain unchanged. The initial behavioral tests pass; fixing an existing test failure is not the task.

The live controller starts in `inspect`, inventories exact repository files, and opens `implement` after three successful inspection actions. Once in implementation, it removes read/search routes until the first edit, which prevents the prior failure mode where Jev repeatedly requested the same channel files. After an edit, a successful check removes another bash/read/search loop; Jev must either propose another write or answer the separate `ready_for_verify` Noul. Only the `verify` phase can expose `finish`. These deterministic phase gates constrain Jev to one atomic judgment at a time while leaving semantic route choice to Jev.

## Independent verification

After the agent exits, the verifier creates its tests outside the candidate repository from benchmark-owned definitions and a pristine reference implementation.

1. Compare all three APIs on 182 deterministic valid orders: **546 exact output comparisons**.
2. Compare invalid input behavior, including error precedence and clock calls.
3. Check all four consumers on multiple inputs.
4. Check input immutability, fresh default clocks, and result isolation.
5. Check each shared module's public contract.
6. Instrument copies of the extracted modules to verify that each channel calls all three shared layers exactly once.
7. Inspect adapter syntax for leftover accesses to validation/pricing inputs.
8. Verify that tests and non-source files were not altered.

The verifier rejects unchanged code, unused extracted modules, rounding regressions, and removed tests. These negative controls and a known-correct refactor are exercised by the offline tests. Verification is for cooperative coding agents, not a security boundary against an adversary controlling the shell or the benchmark installation. The architecture checks enforce this fixture's explicit extraction contract; they are not a general code-quality score.

A Leana run passes only when the independent verifier passes **and** the agent reports completion. Paused, timed-out, and failed runs remain in the denominator. The runner does not silently retry an unsuccessful trial as though it never happened. `--runs` deliberately starts independent fresh trials.

## Reports

The terminal prints each action, the full before/after diff, and report paths. Each trial directory contains:

| File | Contents |
| --- | --- |
| `PROMPT.md` | Exact task to give either agent |
| `manifest.json` | Fixture version, source hash, task hash, label |
| `baseline.txt` | Passing original behavioral tests |
| `before.json`, `after.json`, `changes.diff` | File snapshots and unified diff |
| `agent-console.txt` | Leana's live terminal output |
| `result.json`, `REPORT.md` | Machine-readable and readable measurements |
| `behavior-verification.txt` | Independent behavioral test output |
| `architecture-verification.txt` | Shared-layer tests and adapter violations |
| `verification.json` | Verification outcomes and changed files |
| `repo/.leana/runs/…/jev-decisions.md` | Exact Jev questions, state and answers |

Each suite also writes `summary.json` with all trial results and the verified completion rate. Exit code 0 means all requested trials passed; code 1 means a trial or benchmark setup failed.

Measurements include agent wall time, Jev request/question counts and latency distributions, Bonsai prompt/output/cache tokens, peak prompt tokens, tool errors, compaction reasons, evicted entries, repeated reads/searches, and pauses.

Wall time excludes baseline setup and independent verification. Provider latency includes network, queueing and bounded HTTP retries; it is not pure model inference time. A logical request may contain multiple transport attempts. Failed requests may consume provider tokens without returning usage, so token totals are **reported usage**, not a billing audit. Repeated reads include legitimate rereads after edits. This benchmark does not measure GPU memory or hardware utilization.

## Inspect Jev questions live

The normal CLI now prints the path to `jev-decisions.md` when it starts. Open it in an editor or follow it from a second terminal:

```bash
tail -f /path/printed/by/leana/jev-decisions.md
```

For each request it records:

- Request ID, timestamp, runner step, phase, and model.
- Every exact question and every Choice option's description.
- The complete bounded state sent with that request.
- Selected choices, probability distributions, confidence, and Noul P(yes).
- Response latency and token usage, or the error if the request failed.

Questions are written before transmission so failed requests remain inspectable. The log is human-readable Markdown; the same data is recorded structurally in `events.jsonl`. It does not contain authorization headers or keys, but it can contain source code from the decision state.

## Compare with Cline

Prepare the identical starting fixture without API calls:

```bash
npm run bench:refactor -- prepare --label cline
```

The command prints a repository path and `PROMPT.md`. Open that repository in Cline and give it the exact prompt. Use the same Bonsai model, model endpoint, 48,000-token context ceiling, 4,096 output-token limit, and disabled reasoning. Keep other inference clients idle during both runs. Record Cline's actual settings and version separately; the benchmark cannot verify them automatically.

After Cline finishes, evaluate its edited repository using the printed **trial directory** (the parent of `repo`):

```bash
npm run bench:refactor -- evaluate /path/to/cline-trial --label cline --wall-seconds 123.4
```

`--wall-seconds` is optional and explicitly labeled user-supplied. No Cline tokens, compactions, model settings, or completion status are invented. Without an importer for Cline's native telemetry, those measurements remain unknown. External evaluation reports independently verified task success separately from unknown agent-completion status.

Compare two or more evaluated trials:

```bash
npm run bench:refactor -- compare /path/to/leana-trial /path/to/cline-trial
```

The comparison rejects different fixture versions, starting-source hashes, or task hashes. It writes and prints a Markdown comparison with unknown measurements marked as unknown. Matching hashes establish the prepared task, not proof that a human gave another agent the exact prompt. Report any interventions, changed settings, or concurrent server load alongside results.

Do not infer an advantage from one trial. Start with three or more fresh runs per agent, and expand to real repository refactors after the synthetic benchmark exposes the current routing and context failure modes.
