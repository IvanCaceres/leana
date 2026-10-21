// The README's benchmark figures, made from a harness suite's own results so they can be made again:
//
//   node bench/readme-assets.mjs <suite directory> <name>
//
// writes into docs/benchmark/:
//   <name>-light.svg, <name>-dark.svg   cost and wall time per run, a panel each, one bar per harness, Leana
//                                       highlighted and the rest in gray, every bar labelled with its value
//   <name>-<harness>.png                each harness's page from one round (the round whose Leana cost is nearest
//                                       Leana's median, so it is a typical run, not the best)
//   <name>.json                         the figures: per harness the mean, median, range and every trial
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [suite, name] = process.argv.slice(2);
if (!suite || !name) throw new Error('usage: node bench/readme-assets.mjs <suite directory> <name>');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'docs', 'benchmark');
mkdirSync(out, { recursive: true });

const meta = JSON.parse(readFileSync(join(suite, 'suite.json'), 'utf8'));
const harnesses = Object.keys(meta.versions);
const trials = Object.fromEntries(
  harnesses.map(h => [
    h,
    readdirSync(suite)
      .filter(d => new RegExp(`^${h}-\\d+$`).test(d) && existsSync(join(suite, d, 'trial.json')))
      .map(d => JSON.parse(readFileSync(join(suite, d, 'trial.json'), 'utf8')))
      .sort((a, b) => a.trial - b.trial),
  ]),
);
// A run's cost: what OpenRouter billed, and for Leana its Jev calls, which TypeSafe bills.
const costOf = t => t.billedUsd + (t.harness === 'leana' ? (t.usage?.jev?.costUsd ?? 0) : 0);
const passed = t =>
  t.exitCode === 0 && !t.timedOut && !t.stalled && t.verification?.build !== false && t.verification?.page?.ok === true;
const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;
const median = xs => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
// A run's tokens as OpenRouter reported them through the proxy, or the harness's own report where it is not behind
// the proxy (Hermes). Leana's exclude its Jev calls, which are priced in its cost.
const tokensOf = t => t.metered ?? t.usage ?? {};
const stats = Object.fromEntries(
  harnesses.map(h => {
    const ts = trials[h];
    const cost = ts.map(costOf);
    const wall = ts.map(t => t.wallSeconds);
    const promptTokens = ts.map(t => tokensOf(t).promptTokens ?? 0);
    const outputTokens = ts.map(t => tokensOf(t).outputTokens ?? 0);
    return [
      h,
      {
        version: meta.versions[h],
        runs: ts.length,
        passed: ts.filter(passed).length,
        cost: { mean: mean(cost), median: median(cost), min: Math.min(...cost), max: Math.max(...cost) },
        wallSeconds: { mean: mean(wall), median: median(wall), min: Math.min(...wall), max: Math.max(...wall) },
        promptTokens: { mean: mean(promptTokens), median: median(promptTokens) },
        outputTokens: { mean: mean(outputTokens), median: median(outputTokens) },
        tokensFrom: ts.some(t => t.metered) ? 'OpenRouter, through the proxy' : "the harness's own report",
        trials: ts.map(t => ({
          round: t.trial,
          cost: +costOf(t).toFixed(5),
          wallSeconds: Math.round(t.wallSeconds),
          promptTokens: tokensOf(t).promptTokens ?? null,
          outputTokens: tokensOf(t).outputTokens ?? null,
          passed: passed(t),
        })),
      },
    ];
  }),
);
// How fully each trial's result shows what "advanced ... best practices" asks for, read by Jev with the completion
// gate's own quality score (0 template-level, 1 complete, 2 showcase), on the same evidence for every harness: the
// benchmark's own check of the page and the project's source. With TYPESAFE_API_KEY set; without it, left out.
const key = process.env.TYPESAFE_API_KEY;
if (key) {
  const { gateQuestions } = await import(pathToFileURL(join(root, 'dist', 'src', 'control.js')).href);
  const skip =
    /(^|\/)(node_modules|dist|\.git|public|assets)\/|(^|\/)(tsconfig[^/]*\.json|[^/]*\.config\.[cm]?[jt]s|package(-lock)?\.json|[^/]*\.d\.ts|[^/]*\.test\.[jt]sx?)$/;
  const sourcesOf = repo => {
    const walk = (d, pre = '') =>
      readdirSync(d, { withFileTypes: true }).flatMap(e =>
        ['node_modules', '.git', 'dist'].includes(e.name)
          ? []
          : e.isDirectory()
            ? walk(join(d, e.name), `${pre}${e.name}/`)
            : [`${pre}${e.name}`],
      );
    const out = {};
    let total = 0;
    for (const p of walk(repo).filter(p => !skip.test(p) && /\.(tsx?|jsx?|css|scss|html|vue|svelte)$/.test(p))) {
      const t = readFileSync(join(repo, p), 'utf8').slice(0, 2500);
      if (total + t.length > 16000) break;
      out[p] = t;
      total += t.length;
    }
    return out;
  };
  const questions = {
    delivered: {
      type: 'noul',
      instructions:
        '`result` (its files and its check) delivers what `objective` names: the kind of thing to build, what it is for, and every feature or technology the objective names. Judge only what is named; leave words of quality such as advanced, modern or best practices aside.',
    },
    quality: gateQuestions.quality,
  };
  const ask = async state => {
    for (let k = 0; k < 4; k++) {
      const r = await fetch('https://api.typesafe.ai/v1/systemone', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: 'jev-latest',
          state: JSON.parse(JSON.stringify(state).toWellFormed()),
          questions,
        }),
      });
      if (r.ok) return (await r.json()).answers;
      await new Promise(res => setTimeout(res, 1500 * (k + 1)));
    }
    throw new Error('Jev did not answer');
  };
  // A trial already read for this suite keeps its reading: Jev's readings move by about 0.01 between requests, and
  // figures made again from the same suite should not change under a README that quotes them.
  const before = existsSync(join(out, `${name}.json`))
    ? JSON.parse(readFileSync(join(out, `${name}.json`), 'utf8'))
    : null;
  const kept = before?.started === meta.started ? before.harnesses : {};
  for (const h of harnesses)
    await Promise.all(
      stats[h].trials.map(async t => {
        const was = kept[h]?.trials?.find(x => x.round === t.round);
        if (was?.quality !== undefined) {
          t.quality = was.quality;
          t.delivered = was.delivered;
          return;
        }
        const dir = join(suite, `${h}-${t.round}`);
        const check = existsSync(join(dir, 'verify-page.txt'))
          ? readFileSync(join(dir, 'verify-page.txt'), 'utf8')
          : '';
        const a = await ask({
          objective: meta.scenario.prompt,
          result: {
            about: "What the benchmark found: the project's source and its own check of the running page.",
            files: { sources: existsSync(join(dir, 'repo')) ? sourcesOf(join(dir, 'repo')) : {} },
            check: check.slice(0, 3000),
          },
        });
        t.quality = +a.quality.score.toFixed(2);
        t.delivered = +a.delivered.noul.toFixed(2);
      }),
    );
  for (const h of harnesses)
    stats[h].quality = {
      mean: mean(stats[h].trials.map(t => t.quality)),
      min: Math.min(...stats[h].trials.map(t => t.quality)),
      max: Math.max(...stats[h].trials.map(t => t.quality)),
    };
}
// Harnesses in order of mean cost, the same order in both panels.
const order = [...harnesses].sort((a, b) => stats[a].cost.mean - stats[b].cost.mean);
const modelName = m => ({ 'anthropic/claude-haiku-5.5': 'Claude Haiku 5.5', 'z-ai/glm-5.3': 'GLM-5.3' })[m] ?? m;
const label = h => ({ leana: 'Leana', hermes: 'Hermes', cline: 'Cline', opencode: 'OpenCode' })[h] ?? h;

// Colours from the data-viz reference palette: Leana in its first categorical hue, the rest in muted ink; text in
// text tokens, never the bar's colour. Validated: blue against gray clears colour-blind separation and 3:1 contrast
// on each surface; every bar carries its value, and the README has the table.
const themes = {
  light: {
    surface: '#fcfcfb',
    ink: '#0b0b0b',
    ink2: '#52514e',
    muted: '#898781',
    grid: '#e1e0d9',
    lead: '#2a78d6',
    rest: '#898781',
  },
  dark: {
    surface: '#1a1a19',
    ink: '#f0efec',
    ink2: '#c3c2b7',
    muted: '#898781',
    grid: '#2c2c2a',
    lead: '#3987e5',
    rest: '#6b6a65',
  },
};
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
function svg(theme) {
  const c = themes[theme];
  const W = 760;
  const panelW = 330;
  const gap = 40;
  const nameW = 78;
  const rowH = 34;
  const barH = 20;
  const top = 74;
  const H = top + order.length * rowH + 30;
  const font = 'system-ui, -apple-system, "Segoe UI", sans-serif';
  const panels = [
    {
      title: 'Cost per run',
      sub: 'mean, OpenRouter + Jev',
      value: h => stats[h].cost.mean,
      fmt: v => `$${v.toFixed(3)}`,
    },
    {
      title: 'Wall time per run',
      sub: 'mean, seconds',
      value: h => stats[h].wallSeconds.mean,
      fmt: v => `${Math.round(v)} s`,
    },
  ];
  const parts = [];
  parts.push(
    `<rect width="${W}" height="${H}" rx="8" fill="${c.surface}"/>`,
    `<text x="20" y="30" font-family='${font}' font-size="16" font-weight="600" fill="${c.ink}">${esc(modelName(meta.scenario?.model ?? ''))}: ${meta.runs} rounds, same task and settings</text>`,
  );
  panels.forEach((p, k) => {
    const x0 = 20 + k * (panelW + gap);
    const plotX = x0 + nameW;
    const plotW = panelW - nameW - 60;
    const max = Math.max(...order.map(p.value));
    parts.push(
      `<text x="${x0}" y="56" font-family='${font}' font-size="13" font-weight="600" fill="${c.ink}">${p.title}<tspan font-weight="400" fill="${c.ink2}"> (${p.sub})</tspan></text>`,
      `<line x1="${plotX}" y1="${top - 8}" x2="${plotX}" y2="${top + order.length * rowH - 6}" stroke="${c.grid}" stroke-width="1"/>`,
    );
    order.forEach((h, i) => {
      const y = top + i * rowH;
      const v = p.value(h);
      const w = Math.max(6, (v / max) * plotW);
      const fill = h === 'leana' ? c.lead : c.rest;
      // A bar with its data-end rounded (4px) and its baseline end square.
      parts.push(
        `<text x="${plotX - 10}" y="${y + barH / 2 + 4.5}" text-anchor="end" font-family='${font}' font-size="13" font-weight="${h === 'leana' ? 600 : 400}" fill="${h === 'leana' ? c.ink : c.ink2}">${label(h)}</text>`,
        `<path d="M${plotX} ${y} H${plotX + w - 4} Q${plotX + w} ${y} ${plotX + w} ${y + 4} V${y + barH - 4} Q${plotX + w} ${y + barH} ${plotX + w - 4} ${y + barH} H${plotX} Z" fill="${fill}"/>`,
        `<text x="${plotX + w + 8}" y="${y + barH / 2 + 4.5}" font-family='${font}' font-size="13" font-weight="${h === 'leana' ? 600 : 400}" fill="${h === 'leana' ? c.ink : c.ink2}" style="font-variant-numeric: tabular-nums">${p.fmt(v)}</text>`,
      );
    });
  });
  parts.push(
    `<text x="20" y="${H - 12}" font-family='${font}' font-size="11.5" fill="${c.muted}">Lower is better. All ${harnesses.reduce((n, h) => n + stats[h].runs, 0)} trials passed: built, served and loaded without errors.`.replace(
      'All ' + harnesses.reduce((n, h) => n + stats[h].runs, 0) + ' trials passed',
      harnesses.every(h => stats[h].passed === stats[h].runs)
        ? `All ${harnesses.reduce((n, h) => n + stats[h].runs, 0)} trials passed`
        : `${harnesses.reduce((n, h) => n + stats[h].passed, 0)} of ${harnesses.reduce((n, h) => n + stats[h].runs, 0)} trials passed`,
    ) + '</text>',
  );
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(
    `${modelName(meta.scenario?.model ?? '')}: mean cost and wall time per run. ` +
      order
        .map(h => `${label(h)} $${stats[h].cost.mean.toFixed(3)}, ${Math.round(stats[h].wallSeconds.mean)} s`)
        .join('; '),
  )}">${parts.join('')}</svg>\n`;
}
writeFileSync(join(out, `${name}-light.svg`), svg('light'));
writeFileSync(join(out, `${name}-dark.svg`), svg('dark'));

// The round whose Leana cost is nearest Leana's median: a typical round, each harness's page from it.
const leana = stats.leana;
const round = leana
  ? leana.trials.reduce((best, t) =>
      Math.abs(t.cost - leana.cost.median) < Math.abs(best.cost - leana.cost.median) ? t : best,
    ).round
  : 1;
// Every trial's page, and a gallery of them: a round per row, a harness per column, each with what it cost, how long
// it took, its quality reading and whether it passed. The README's strip is one row of it.
mkdirSync(join(out, name), { recursive: true });
const shotOf = (h, r) => {
  const shot = join(suite, `${h}-${r}`, 'page.png');
  if (!existsSync(shot)) return null;
  copyFileSync(shot, join(out, name, `${h}-${r}.png`));
  return `${name}/${h}-${r}.png`;
};
const rows = [];
for (let r = 1; r <= meta.runs; r++)
  rows.push(
    `| ${r} | ${order
      .map(h => {
        const t = stats[h].trials.find(x => x.round === r);
        if (!t) return '—';
        const img = shotOf(h, r);
        return `${img ? `<img src="${img}" width="230" alt="${label(h)}, round ${r}"><br>` : ''}$${t.cost.toFixed(3)} · ${t.wallSeconds} s${t.quality !== undefined ? ` · quality ${t.quality.toFixed(2)}` : ''} · ${t.passed ? 'passed' : 'failed'}`;
      })
      .join(' | ')} |`,
  );
writeFileSync(
  join(out, `${name}-gallery.md`),
  [
    `# ${modelName(meta.scenario?.model ?? '')}: every trial`,
    '',
    `The task: "${meta.scenario?.prompt}". ${meta.runs} rounds; in each, every harness ran once with the same model and settings. Each cell is the top of the page that harness built, then its cost (OpenRouter, and Jev for Leana), wall time, Jev's quality reading (0 template-level, 1 complete, 2 showcase) and whether it passed (built, served and loaded with no errors).`,
    '',
    `| Round | ${order.map(label).join(' | ')} |`,
    `| --- | ${order.map(() => '---').join(' | ')} |`,
    ...rows,
    '',
  ].join('\n'),
);
writeFileSync(
  join(out, `${name}.json`),
  JSON.stringify(
    {
      scenario: meta.scenario,
      runs: meta.runs,
      started: meta.started,
      screenshotsFromRound: round,
      harnesses: Object.fromEntries(order.map(h => [h, stats[h]])),
    },
    null,
    2,
  ) + '\n',
);
console.log(
  `${name}: round ${round} screenshots; ` +
    order
      .map(
        h =>
          `${label(h)} $${stats[h].cost.mean.toFixed(4)} ${Math.round(stats[h].wallSeconds.mean)}s ${stats[h].passed}/${stats[h].runs}`,
      )
      .join(' | '),
);
