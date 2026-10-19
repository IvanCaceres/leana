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

# Compare harnesses: one task, four agents, one model

`bench/harnesses.mjs` runs the same task through Leana, [Hermes](https://github.com/NousResearch/hermes-agent), [Cline](https://cline.bot) and [OpenCode](https://opencode.ai), all on the same model through OpenRouter. It measures every harness the same way. The task and model are in [`bench/scenario.json`](bench/scenario.json):

| Field | Value |
| --- | --- |
| Prompt | `build an advanced react demo landing page app for a saas startup using the latest and greatest best practices` |
| Model | `z-ai/glm-5.3` through OpenRouter |
| Reasoning effort requested | `medium` (see *Reasoning effort*) |
| Time limit | 20 minutes per trial |

## Prerequisites

- **Node 22 or later.** Leana built from this checkout (`npm ci && npm run build`); the runner reuses its process control and page observer.
- **The CLIs on `PATH`**, as tested: Hermes Agent v0.21.3, Cline CLI 3.0.73, OpenCode v2.0.32. The runner records each version it finds.
- **`OPENROUTER_API_KEY`** in the environment: one key for every harness. Use a key nothing else spends from while the suite runs, because cost is read from that key (see *What is measured*).
- **`TYPESAFE_API_KEY`** for Leana's Jev.
- **Chrome or Chromium,** used by the verification's page check.

Cline needs no prior setup: each trial authenticates it with OpenRouter in a private state directory under the system temp folder, which is deleted after the trial. Hermes and OpenCode read `OPENROUTER_API_KEY` from the environment.

## Running

```bash
npm run bench:harnesses -- --runs 3
npm run bench:harnesses -- --harness leana,opencode --runs 1
npm run bench:harnesses -- --rescore work/bench/harnesses/<suite>
```

- **Trials run one at a time,** each in a new empty directory, made its own git repository (`git init`). Cost is read from the key around each trial, and two dev servers at once would compete for ports. With `--runs 3` the order is leana, hermes, cline, opencode, then repeat.
- **`--rescore`** recomputes the usage figures and the verification of a finished suite from what its trials saved, without running any agent. Use it after changing a parser or the verification.
- **`--skip-verify`** skips building and loading the result.

Everything goes under `work/bench/harnesses/<timestamp>/` (git-ignored):

| File | Contents |
| --- | --- |
| `suite.json` | Scenario, harness versions, platform, Node version, start time |
| `<harness>-<n>/repo/` | The directory the harness worked in, and what it built there |
| `<harness>-<n>/command.json` | The exact command and arguments run (the key masked), and the reasoning effort sent |
| `<harness>-<n>/agent-stdout.txt`, `agent-stderr.txt` | The harness's output |
| `<harness>-<n>/trial.json` | Every measurement of the trial |
| `<harness>-<n>/verify-*.txt`, `page.png` | Install, build and page-check output, and a screenshot of the page |
| `summary.json`, `SUMMARY.md` | All trials, and the comparison table |

## How each harness is run

| Harness | Command (in the trial's empty directory) | Its own usage report |
| --- | --- | --- |
| Leana | `node dist/src/cli.js run <prompt> --repo <dir> --provider openrouter --model z-ai/glm-5.3 --effort medium --plain` | `events.jsonl` of the session it prints: one `bonsai` event per model request |
| Hermes | `hermes -z <prompt> --usage-file <trial>/hermes-usage.json --provider openrouter -m z-ai/glm-5.3 --reasoning medium --yolo --in <dir>`, with `TERMINAL_CWD=<dir>` | The usage file: `api_calls`, input, cache-read, output and reasoning tokens, estimated cost |
| Cline | `cline auth -p openrouter -k <key> -m z-ai/glm-5.3 --data-dir <tmp>`, then `cline -y --json -c <dir> -P openrouter -m z-ai/glm-5.3 --thinking medium --data-dir <tmp> <prompt>` | The `run_result` line of its JSON output: iterations, input tokens (cache reads included), cache reads, output tokens, cost |
| OpenCode | `opencode run --standalone --auto --format json -m openrouter/z-ai/glm-5.3#low <prompt>` | Its JSON events: tokens and cost per step |

Notes:
- **Unattended mode:** every harness runs with its own approvals off (`--yolo`, `-y`, `--auto`; Leana's shell and writes are on by default). They run unsandboxed with your user's permissions, as in normal use.
- **Hermes and `TERMINAL_CWD`:** without it, Hermes' one-shot mode ran its terminal tool in the user's home directory and created the project there (`~/saas-landing`). The runner sets it to the trial directory. A trial whose directory stays empty is reported as such and doesn't pass.
- **`PWD` is set to the trial directory.** OpenCode takes its project from `PWD`, which a shell sets and Node doesn't. Without it, OpenCode worked in the directory the runner was started from. After each trial the runner also lists anything new at the top of the Leana checkout, and a trial that wrote there doesn't pass (`wroteOutside` in `trial.json`).
- **Each trial is its own git repository.** A harness takes the enclosing repository as its project: OpenCode, run in a plain folder under `work/`, wrote its project into the Leana checkout, and Cline's linter read that checkout's `.gitignore`.
- **Leftover processes:** a harness can leave a dev server running (OpenCode left a `vite preview`). A trial ends when the harness exits, after a 3-second drain, not when its output pipes close, and everything it started is stopped. On Windows that uses an inherited `LEANA_RUN` mark, so it reaches detached processes too; elsewhere the harness's process group is stopped.
- **On Windows,** Cline and OpenCode installed through npm or Volta are `.cmd` shims, which the runner starts through `cmd.exe`.

## Reasoning effort

GLM-5.3 offers efforts `low`, `high` and `max`, not `medium`. The scenario requests `medium`, and each harness handles it its own way:

| Harness | Sends | Why |
| --- | --- | --- |
| Leana | `low` | It rounds an effort the model doesn't offer down to the nearest one it does |
| Hermes | `medium` | It checks only OpenRouter's general list of efforts |
| Cline | `medium` | `--thinking medium`, sent as given |
| OpenCode | `low` | It refuses a variant the model doesn't list ("Variant unavailable for openrouter/z-ai/glm-5.3: medium"), so the scenario gives it `low` (`effortByHarness`), the same rounding Leana applies |

On this model, `medium`, `low` and no reasoning setting all produce close to no reasoning, while `high` and `max` reason at length. So the four configurations are comparable in practice. `trial.json` records the effort each trial sent.

## What is measured

| Measure | How | Same for every harness? |
| --- | --- | --- |
| **Billed (USD)** | `GET https://openrouter.ai/api/v1/key` before and after the trial. The key's total usage, waited on until it has held still for 20 s, because OpenRouter books costs shortly after a request ends. This is what was charged, whichever endpoint served it. | Yes: it doesn't depend on the harness reporting anything. Any other spend on the key during a trial is counted too. |
| **Wall time** | From starting the harness to its exit (or the time limit) | Yes |
| **Requests, prompt tokens (cached tokens included), output tokens** | Each harness's own report (see the table above) | No: each counts in its own way. Treat them as indicative and the billed figure as authoritative. Leana's figures exclude its Jev calls, which TypeSafe bills separately. |
| **Passed** | The harness exited 0 within the time limit and left its project in its directory. The project's own `npm run build` passed (when it has a build script). Its page loaded in a headless browser with no exception and no failed request. | Yes |

Verification runs after the harness exits:
1. Find the project: the trial directory, or the one subdirectory up to two levels down that has a `package.json` (Cline scaffolds into `app/`, Hermes into `saas-landing/`).
2. `npm install` if `node_modules` is missing, then `npm run build` if there's a build script.
3. Serve it on a free port with its own scripts: `preview` after a passing build, else `dev`, else `start`.
4. Load the page with Leana's page observer: exceptions, failed requests, text length, and a screenshot.

**"Passed" isn't a quality score.** A page can load and still look wrong. For example, a hero held invisible by a scroll animation still counts as loaded text, because the check reads text, not visibility. Look at each trial's `page.png`.

## Reading the results

- **Several trials per harness.** Runs of the same harness on the same task vary a lot: Leana's own runs of this task ranged from 7 to 28 requests. The summary gives medians, and ranges for cost.
- **Note what else used the key.** Background jobs or another session spending from the same key inflate the billed figure. Use a dedicated key.
- **Endpoints differ by harness.** OpenRouter routes each request to one of a model's endpoints, and their prices differ (GLM-5.3: `wafer/us` $0.079 per million prompt tokens, `wafer/fp4` $0.179). Leana asks for the cheapest endpoints for its requests first (`openrouterRouting: "cost"`); the other harnesses use OpenRouter's default routing. That's part of each harness's real cost, and the billed figure includes it. Each harness's own cost estimate shows the difference.
- **Results describe this machine, these versions, and this model on these days.** Publish `suite.json` with any results.
