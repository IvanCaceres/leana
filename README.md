# Leana

**Fewer tokens. Lower cost. Faster work.**

Leana is an open-source coding agent. It pairs a worker model, any model on OpenRouter, with **Jev**, a judgment model from [TypeSafe](https://typesafe.ai). The worker writes the code; Jev watches every step and decides when the work is really done, so the worker doesn't keep going after it's finished. On the same task, with the same model and settings, Leana used the fewest tokens, cost the least and finished the fastest against Cline, OpenCode and Hermes, on both models we tested.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/benchmark/haiku-5.5-dark.svg">
  <img alt="Claude Haiku 5.5: mean cost and wall time per run for Leana, Cline, OpenCode and Hermes" src="docs/benchmark/haiku-5.5-light.svg" width="760">
</picture>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/benchmark/glm-5.3-dark.svg">
  <img alt="GLM-5.3: mean cost and wall time per run for Leana, Cline, OpenCode and Hermes" src="docs/benchmark/glm-5.3-light.svg" width="760">
</picture>

## The benchmark at a glance

Every harness built the same thing: _"build an advanced react demo landing page app for a saas startup using the latest and greatest best practices"_, from an empty folder. Each round ran every harness once, back to back, on the same model. Every request each harness sent carried the same reasoning effort, sampling, output cap and provider endpoint, and was checked for it. Cost is the OpenRouter key's usage over each trial. A trial passed if the project built, served and loaded in a headless browser with no errors.

**Claude Haiku 5.5**: 6 rounds, all 24 trials passed

| Harness   | Tokens in / out | Cost per run | Wall time | Dearest / slowest run | Quality (0–2) |
| --------- | --------------- | ------------ | --------- | --------------------- | ------------- |
| **Leana** | **54k / 12k**   | **$0.012**   | **66 s**  | $0.017 / 85 s         | 1.86          |
| Cline     | 364k / 20k      | $0.019       | 107 s     | $0.027 / 158 s        | 1.84          |
| OpenCode  | 431k / 26k      | $0.022       | 143 s     | $0.030 / 207 s        | 1.95          |
| Hermes    | 512k / 20k      | $0.023       | 287 s     | $0.031 / 453 s        | 1.93          |

**GLM-5.3**: 6 rounds, all 24 trials passed

| Harness   | Tokens in / out | Cost per run | Wall time | Dearest / slowest run | Quality (0–2) |
| --------- | --------------- | ------------ | --------- | --------------------- | ------------- |
| **Leana** | **88k / 10k**   | **$0.022**   | **88 s**  | $0.027 / 121 s        | 1.78          |
| Cline     | 373k / 17k      | $0.053       | 124 s     | $0.083 / 178 s        | 1.78          |
| OpenCode  | 321k / 25k      | $0.060       | 199 s     | $0.072 / 257 s        | 1.94          |
| Hermes    | 770k / 18k      | $0.084       | 168 s     | $0.113 / 203 s        | 1.93          |

Cost is what OpenRouter billed, plus for Leana its Jev calls, which TypeSafe bills: 3 to 5% of Leana's cost. Tokens, cost and times are means; tokens are as OpenRouter reported them, except Hermes's, which are its own report. Quality is Jev's reading of how fully each result shows what "advanced … best practices" asks for, from 0 (template-level) through 1 (complete) to 2 (showcase), given every harness's source and page check alike.

### What the results show

- **The fewest tokens.** Leana read a sixth to a quarter of the input tokens of the next-leanest harness on each model, and wrote the fewest output tokens.
- **The cheapest on both models, round by round.** Leana was cheaper than every other harness in every round on GLM-5.3, and on Claude Haiku 5.5 than OpenCode and Hermes in every round and Cline in 5 of 6. It saved $0.007 to $0.012 a run on Haiku and $0.030 to $0.062 on GLM. Each of those gaps holds at 95% confidence.
- **The fastest on both models.** Leana was faster than each of the others in at least 5 of 6 rounds on both models, by 41 to 221 seconds a run on Haiku and 36 to 111 seconds on GLM, again at 95% confidence.
- **Its costs are the most predictable.** On both models, Leana's dearest run cost less than the average run of every other harness.
- **Its lead is efficiency, not polish.** On quality, Leana is level with Cline on both models, and slightly behind OpenCode and Hermes, which spend more. All four land between complete and showcase; none built a template-level page.

### What they don't show

- **One task, two models, six rounds each.** A landing page is one kind of work. Long refactors, backend services and existing codebases aren't measured here.
- **Quality is read by Jev, which is also Leana's own judge.** An independent judge would be stronger evidence. So you can judge for yourself, every trial's page is in the galleries below.
- **One endpoint per model.** Every harness was pinned to the same OpenRouter endpoint for a model, with fallbacks off: Wafer for GLM-5.3 and Google for Claude Haiku 5.5. Other endpoints run at other speeds and prices, so absolute times and costs elsewhere will differ.
- **Each harness ran with its own defaults otherwise.** Versions: Cline 3.0.73, OpenCode 2.0.32, Hermes Agent 0.21.3.

### What each harness built

One round on Claude Haiku 5.5, the round where Leana's cost was its median, not its best:

| Leana                                                                           | Cline                                                                           | OpenCode                                                                              | Hermes                                                                            |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| <img src="docs/benchmark/haiku-5.5/leana-1.png" width="200" alt="Leana's page"> | <img src="docs/benchmark/haiku-5.5/cline-1.png" width="200" alt="Cline's page"> | <img src="docs/benchmark/haiku-5.5/opencode-1.png" width="200" alt="OpenCode's page"> | <img src="docs/benchmark/haiku-5.5/hermes-1.png" width="200" alt="Hermes's page"> |
| $0.010 · 62 s                                                                   | $0.015 · 93 s                                                                   | $0.025 · 141 s                                                                        | $0.016 · 96 s                                                                     |

Every trial, with its cost, time and quality: the [Claude Haiku 5.5 gallery](docs/benchmark/haiku-5.5-gallery.md) and the [GLM-5.3 gallery](docs/benchmark/glm-5.3-gallery.md).

### Run it yourself

```bash
npm ci && npm run build
OPENROUTER_API_KEY=... TYPESAFE_API_KEY=... npm run bench:harnesses -- --runs 6 --scenario bench/scenario-haiku.json
```

It needs Cline, OpenCode and Hermes installed, and a dedicated OpenRouter key, since cost is measured from the key's usage. The [benchmark guide](BENCHMARK.md) covers the method, how settings are matched and checked, and what each figure means. The figures here are in [`docs/benchmark`](docs/benchmark), made from the runs' own results by `bench/readme-assets.mjs`.

## How Leana works

- **The worker reasons, then acts in batches.** Each turn it writes a few sentences of reasoning and a batch of actions: read, search, write, run a command, observe the result. Leana runs the batch and stops at the first failure.
- **Jev is the control plane.** After each batch, Jev reads whether the run is progressing, repeating a failure or stuck. It triages failed commands, and judges a finish against facts the harness gathered: the diff, the check that ran after the last edit, and what the result looked like to its user. It never decides how to implement anything.
- **The result is seen as its user meets it.** A page is loaded in a headless browser, a service is called, a program is run, and the facts go to the worker and to Jev.
- **The prompt is laid out for caching.** It's ordered by how often each part changes, so most of every request is read from the provider's cache.

The [architecture guide](docs/ARCHITECTURE.md) covers the loop, the tools, the prompt and Jev's questions in detail.

## Quick start

Leana needs Node 22+ and [ripgrep](https://github.com/BurntSushi/ripgrep). On Windows it also needs [Git for Windows](https://git-scm.com/download/win), whose bash it runs commands with.

It needs two API keys:

- **TypeSafe, for Jev**, from [typesafe.ai](https://typesafe.ai). Jev's calls are 3 to 5% of a run's cost.
- **OpenRouter, for the worker model**, from [openrouter.ai](https://openrouter.ai).

Install it. The package is `leana-cli`; the command it installs is `leana`.

```bash
npm install -g leana-cli
leana --version
```

Set the keys. In PowerShell, use `$env:TYPESAFE_API_KEY = "..."` instead.

```bash
export TYPESAFE_API_KEY=...
export OPENROUTER_API_KEY=...
```

Start the app in the repository you want to work on:

```bash
cd /path/to/repository
leana
```

Type what you want done and press Enter. Leana uses Claude Haiku 5.5 through OpenRouter unless you choose another model: `/models <words>` searches them, and `/model <id>` switches. The choice is kept for next time, in `~/.config/leana/settings.json`. `leana doctor` checks both keys and the model.

The worker writes files and runs shell commands with your user's privileges, unsandboxed. `/allow bash off` (or `--no-bash`) turns the shell off, and `--read-only` turns off writes too. Run it on a repository you can afford to have changed, or in a container.

## Using the app

- **During a run,** the conversation shows each step, its results and each edit as a diff, and the status bar shows the model, steps, context, tokens and cost. Type to guide the run: your words join the objective at its next step. Ctrl-C stops it after the current step.
- **After a run,** what you type continues the same session: ask about the work, or ask for more. `/new` starts a fresh session on top of the changes so far. `/sessions` lists the repository's sessions, and `/resume` picks one up.
- **To copy,** drag to select text and copy it as your terminal does. PgUp and PgDn scroll, Esc returns to the end, and Tab browses the steps and folds them. `/mouse on` makes the wheel scroll instead; most terminals then select with Shift held.
- **To change the model,** use `/models <words>` to search OpenRouter's models and `/model <id>` to switch, for example `/model z-ai/glm-5.3`. `/options` shows what the model takes, such as reasoning and effort, and `/set` changes it.
- **Other settings:** `/check <command>` sets the command that verifies the work, `/allow write|bash on|off` sets what runs may do, and `/repo <path>` switches the repository, which is kept for next time.
- **`/help`** lists every command. Ctrl-C twice leaves.

## From the command line

`leana run` and the other commands use the model chosen in the app unless `--provider` and `--model` say otherwise.

```bash
leana run "Fix the failing parser test and verify it" --repo . --check "npm test"
leana resume <session-directory> --message "Also cover the empty input"
leana report <session-directory>     # an HTML page of every step
leana models haiku                   # search the provider's models
leana doctor                         # check the keys and the model
```

Every run is a session, saved under `~/.local/state/leana` with its event log and checkpoint, so it can be resumed or reported on. `leana --help` lists every flag.

From source instead: `npm ci && npm run build`, then `node dist/src/cli.js` in place of `leana`, or `npm link` to put `leana` on your path.

## Documentation

- [Architecture](docs/ARCHITECTURE.md): the loop, tools, prompt, Jev's role, sessions and measurements
- [Benchmark guide](BENCHMARK.md): the harness comparison and the refactor benchmark, and how to reproduce them
- [Validation](VALIDATION.md): live validation runs

## Status

Leana is early. It's been measured on the landing-page task above and on the refactor and live tests in the benchmark guide, not yet across a broad range of real repositories.

## License

[Apache License 2.0](LICENSE).
