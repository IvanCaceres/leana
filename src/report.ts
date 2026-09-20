import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { summarizeEvents, type Event } from './benchmark-metrics.js';

// A self-contained HTML view of one session: per step, what Jev was asked and
// answered and how fast, the exact worker prompt and how the context was spent,
// what Bonsai generated and at what speed, and what the tool returned.
export interface StepView {
  step: number; route?: string;
  jev: { requestId: string; phase: string; questions: unknown; state: unknown; stateBytes: number; ms?: number; answers?: unknown; usage?: unknown; error?: string }[];
  prompts: { attempt: number; route: string; tokens: number; workingTokens: number; contextWindow: number; breakdown: Record<string, number>; artifact: string; text?: string }[];
  bonsai: { requestId: string; temperature?: number; promptTokens?: number; ms?: number; usage?: any; timings?: any; finishReason?: string; error?: string }[];
  action?: { route: string; args: unknown; rejected?: boolean };
  result?: { ok: boolean; ms: number; artifact?: string; text?: string };
  compact?: unknown; undo?: unknown; paused?: string;
}
const clipText = (t: string, n: number) => t.length <= n ? t : `${t.slice(0, n)}\n…[${t.length - n} more characters in the artifact]`;
export function collectSteps(events: Event[]): StepView[] {
  const steps = new Map<number, StepView>();
  const at = (n: number): StepView => { let v = steps.get(n); if (!v) { v = { step: n, jev: [], prompts: [], bonsai: [] }; steps.set(n, v); } return v; };
  const requestStep = new Map<string, number>();
  for (const e of events) {
    const d = e.data ?? {};
    switch (e.type) {
      case 'jev-request': if (d.step) at(d.step).jev.push({ requestId: d.requestId, phase: d.phase, questions: d.questions, state: d.state, stateBytes: Buffer.byteLength(JSON.stringify(d.state ?? null)) }); break;
      case 'jev': case 'jev-error': { const j = d.step && at(d.step).jev.find(x => x.requestId === d.requestId); if (j) Object.assign(j, e.type === 'jev' ? { ms: d.ms, answers: d.answers, usage: d.usage } : { ms: d.ms, error: d.error }); break; }
      case 'prompt': at(d.step).prompts.push({ attempt: d.attempt, route: d.route, tokens: d.tokens, workingTokens: d.workingTokens, contextWindow: d.contextWindow, breakdown: d.breakdown, artifact: d.artifact }); at(d.step).route ??= d.route; break;
      case 'bonsai-request': if (d.step) { requestStep.set(d.requestId, d.step); at(d.step).bonsai.push({ requestId: d.requestId, temperature: d.temperature, promptTokens: d.prompt?.tokens }); } break;
      case 'bonsai': case 'bonsai-error': { const step = d.step ?? requestStep.get(d.requestId); const b = step && at(step).bonsai.find(x => x.requestId === d.requestId);
        if (b) Object.assign(b, e.type === 'bonsai' ? { ms: d.ms, usage: d.usage, timings: d.timings, finishReason: d.finishReason } : { ms: d.ms, error: d.error }); break; }
      case 'action': at(d.step).action = { route: d.route, args: d.args, rejected: d.rejected }; at(d.step).route = d.route; break;
      case 'result': at(d.step).result = { ok: d.ok, ms: d.ms, artifact: d.artifact }; break;
      case 'compact': at(d.step).compact = d; break;
      case 'undo': at(d.step).undo = d; break;
      case 'paused': at(d.step).paused = d.reason; break;
    }
  }
  return [...steps.values()].sort((a, b) => a.step - b.step);
}
export function speed(b: { ms?: number; usage?: any; timings?: any }): { generation: number | null; prompt: number | null; generated: number | null } {
  const generated = b.usage?.completion_tokens ?? b.timings?.predicted_n ?? null;
  const generation = b.timings?.predicted_per_second ?? (generated && b.ms ? generated / (b.ms / 1000) : null);
  return { generation, prompt: b.timings?.prompt_per_second ?? null, generated };
}
export async function renderReport(dir: string): Promise<string> {
  const events: Event[] = (await readFile(join(dir, 'events.jsonl'), 'utf8')).split('\n').filter(Boolean).map(l => JSON.parse(l));
  let checkpoint: any = null;
  try { checkpoint = JSON.parse(await readFile(join(dir, 'checkpoint.json'), 'utf8')); } catch { /* not saved yet */ }
  const artifact = async (ref?: string) => { if (!ref) return undefined; try { return await readFile(join(dir, 'artifacts', ref.replace(/^@artifact\//, '')), 'utf8'); } catch { return undefined; } };
  const steps = collectSteps(events);
  for (const s of steps) {
    for (const p of s.prompts) { const text = await artifact(p.artifact); if (text) p.text = clipText(text, 60000); }
    if (s.result) { const text = await artifact(s.result.artifact); if (text) s.result.text = clipText(text, 8000); }
  }
  const start = events.find(e => e.type === 'start')?.data;
  const stop = events.filter(e => e.type === 'stop').at(-1)?.data;
  const data = { dir, generatedAt: new Date().toISOString(), config: start?.config ?? null,
    session: checkpoint ? { objective: checkpoint.objective, status: checkpoint.status, stopReason: checkpoint.stopReason, step: checkpoint.step, phase: checkpoint.phase, writes: checkpoint.writes, entries: checkpoint.entries?.length } : stop ?? null,
    metrics: summarizeEvents(events), steps };
  const html = template(JSON.stringify(data).replace(/<\/script/gi, '<\\/script'), stop === undefined);
  await writeFile(join(dir, 'report.html'), html);
  return html;
}
function template(json: string, live: boolean): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Leana session report</title>${live ? '<meta http-equiv="refresh" content="5">' : ''}
<style>
:root{--bg:#fff;--fg:#1a1a1a;--muted:#666;--line:#e3e3e3;--ok:#1f8a4c;--bad:#c62828;--accent:#2f5bea;--soft:#f4f6fb}
@media(prefers-color-scheme:dark){:root{--bg:#121417;--fg:#e8e8e8;--muted:#9a9a9a;--line:#2b2f36;--ok:#4cc27a;--bad:#ef6b6b;--accent:#7f9cff;--soft:#1b1f27}}
body{margin:0;padding:16px;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,sans-serif}h1{font-size:18px;margin:0 0 4px}h2{font-size:15px;margin:20px 0 8px}
.muted{color:var(--muted)}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;margin:12px 0}.tile{background:var(--soft);border-radius:8px;padding:10px}.tile b{display:block;font-size:18px}
table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}th{position:sticky;top:0;background:var(--bg)}tr.step{cursor:pointer}tr.step:hover{background:var(--soft)}
.ok{color:var(--ok)}.bad{color:var(--bad)}.bar{height:8px;background:var(--soft);border-radius:4px;overflow:hidden}.bar i{display:block;height:100%;background:var(--accent)}
details{margin:6px 0}pre{white-space:pre-wrap;word-break:break-word;background:var(--soft);padding:10px;border-radius:6px;max-height:480px;overflow:auto;font-size:12px}
.tabs button{margin:0 6px 8px 0;padding:4px 10px;border:1px solid var(--line);background:var(--soft);color:var(--fg);border-radius:6px;cursor:pointer}.tabs button.on{border-color:var(--accent)}
.bd{display:flex;gap:2px;height:14px;border-radius:4px;overflow:hidden;margin:6px 0}.bd i{display:block;height:100%}.legend span{display:inline-block;margin:2px 10px 2px 0;font-size:12px}
svg{width:100%;height:130px;background:var(--soft);border-radius:8px}
</style></head><body>
<h1>Leana session report</h1><div class="muted" id="head"></div>
<div class="grid" id="tiles"></div>
<h2>Context use per step <span class="muted">(prompt tokens, working budget line)</span></h2><svg id="ctx" viewBox="0 0 1000 130" preserveAspectRatio="none"></svg>
<h2>Generation speed per step <span class="muted">(tokens per second)</span></h2><svg id="tps" viewBox="0 0 1000 130" preserveAspectRatio="none"></svg>
<h2>Steps <span class="muted">(click a row for the prompt, the Jev exchange, the generation and the result)</span></h2>
<table><thead><tr><th>#</th><th>route</th><th>Jev (top choices · ms)</th><th>context</th><th>Bonsai</th><th>result</th><th>notes</th></tr></thead><tbody id="rows"></tbody></table>
<script id="data" type="application/json">${json}</script>
<script>
const D=JSON.parse(document.getElementById('data').textContent);const $=s=>document.querySelector(s);const esc=s=>String(s??'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
const fmt=n=>n==null?'–':(n>=1000?(n/1000).toFixed(1)+'k':Math.round(n));const ms=n=>n==null?'–':n>=1000?(n/1000).toFixed(1)+'s':Math.round(n)+'ms';
const speed=b=>{const g=b.usage?.completion_tokens??b.timings?.predicted_n??null;const gs=b.timings?.predicted_per_second??(g&&b.ms?g/(b.ms/1000):null);return{g,gs,ps:b.timings?.prompt_per_second??null}};
const palette=['#2f5bea','#e8a33d','#3cb371','#c65cc6','#e05d5d','#4fb3c7','#8a8a8a','#b7a13c','#5c7cfa','#d97a3c'];
const S=D.session||{},M=D.metrics||{};
$('#head').innerHTML=esc(D.dir)+' · generated '+esc(D.generatedAt)+(S.status?' · <b>'+esc(S.status.toUpperCase())+'</b> at step '+esc(S.step)+(S.stopReason?': '+esc(S.stopReason):''):'')+'<br>'+esc(S.objective||'');
const tps=D.steps.flatMap(s=>s.bonsai.map(speed).filter(x=>x.gs)).map(x=>x.gs);const avgTps=tps.length?tps.reduce((a,b)=>a+b,0)/tps.length:null;
const pps=D.steps.flatMap(s=>s.bonsai.map(speed).filter(x=>x.ps)).map(x=>x.ps);const avgPps=pps.length?pps.reduce((a,b)=>a+b,0)/pps.length:null;
const peak=Math.max(0,...D.steps.flatMap(s=>s.prompts.map(p=>p.tokens)));const W=D.config?.workingTokens,C=D.config?.contextWindow;
const tiles=[['steps',D.steps.length],['Jev calls',M.jevResponses],['Jev median',ms(M.jevLatency?.medianMs)],['Jev p95',ms(M.jevLatency?.p95Ms)],['Bonsai calls',M.bonsaiResponses],['Bonsai median',ms(M.bonsaiLatency?.medianMs)],['generation tok/s',avgTps?avgTps.toFixed(1):'–'],['prompt tok/s',avgPps?avgPps.toFixed(0):'–'],['prompt tokens total',fmt(M.bonsaiPromptTokens)],['generated tokens',fmt(M.bonsaiCompletionTokens)],['peak context',fmt(peak)+(W?' / '+fmt(W):'')],['tool time',ms(M.toolMs)],['tool errors',M.toolErrors],['compactions',M.compactions]];
$('#tiles').innerHTML=tiles.map(([k,v])=>'<div class="tile"><b>'+esc(v)+'</b><span class="muted">'+esc(k)+'</span></div>').join('');
function chart(id,values,max,line){const svg=$(id);const n=values.length||1;const w=1000/n;let out='';values.forEach((v,i)=>{if(v==null)return;const h=Math.min(120,120*v/max);out+='<rect x="'+(i*w+1)+'" y="'+(125-h)+'" width="'+Math.max(1,w-2)+'" height="'+h+'" fill="var(--accent)"><title>step '+(D.steps[i]?.step)+': '+Math.round(v)+'</title></rect>';});if(line){const y=125-120*line/max;out+='<line x1="0" x2="1000" y1="'+y+'" y2="'+y+'" stroke="var(--bad)" stroke-dasharray="6 4"/>';}svg.innerHTML=out;}
chart('#ctx',D.steps.map(s=>s.prompts[0]?.tokens??null),Math.max(W||0,peak,1)*1.05,W);
chart('#tps',D.steps.map(s=>{const b=s.bonsai.map(speed).find(x=>x.gs);return b?b.gs:null}),Math.max(1,...tps)*1.1,null);
const rows=$('#rows');
D.steps.forEach((s,i)=>{const j=s.jev[0];const r=j?.answers?.route;const top=r?Object.entries(r.probabilities).sort((a,b)=>b[1]-a[1]).slice(0,3).map(([k,p])=>k+' '+p.toFixed(2)).join(', '):(j?.error||'');const p=s.prompts[0];const b=s.bonsai.find(x=>x.ms);const sp=b?speed(b):null;
const ctx=p?fmt(p.tokens)+(W?' <span class="muted">'+Math.round(100*p.tokens/W)+'%</span><div class="bar"><i style="width:'+Math.min(100,100*p.tokens/W)+'%"></i></div>':''):'';
const gen=b?ms(b.ms)+(sp.g!=null?' · '+sp.g+' tok'+(sp.gs?' @ '+sp.gs.toFixed(1)+'/s':''):'')+(b.error?' <span class="bad">'+esc(b.error)+'</span>':''):(s.bonsai[0]?.error?'<span class="bad">'+esc(s.bonsai[0].error)+'</span>':'');
const res=s.result?'<span class="'+(s.result.ok?'ok':'bad')+'">'+(s.result.ok?'ok':'failed')+'</span> '+ms(s.result.ms):(s.action?'':'<span class="muted">no action</span>');
const notes=[s.compact?'compacted '+s.compact.removed+' ('+s.compact.reason+')':'',s.undo?'undo':'',s.jev.length>1?s.jev.slice(1).map(x=>x.phase).join(', '):'',s.paused?'<span class="bad">paused: '+esc(s.paused)+'</span>':'',s.action?.rejected?'finish rejected':''].filter(Boolean).join(' · ');
const tr=document.createElement('tr');tr.className='step';tr.innerHTML='<td>'+s.step+'</td><td>'+esc(s.route||'')+'</td><td>'+esc(top)+(j?.ms!=null?' <span class="muted">'+ms(j.ms)+'</span>':'')+'</td><td>'+ctx+'</td><td>'+gen+'</td><td>'+res+'</td><td>'+notes+'</td>';
const det=document.createElement('tr');det.style.display='none';det.innerHTML='<td colspan="7"></td>';tr.onclick=()=>{det.style.display=det.style.display==='none'?'':'none';if(!det.dataset.done){det.dataset.done=1;det.firstChild.innerHTML=details(s)}};rows.append(tr,det);});
function details(s){const p=s.prompts[0];const tabs=[];
tabs.push(['Jev',s.jev.map(j=>'<h3>'+esc(j.phase)+' · '+ms(j.ms)+' · state '+fmt(j.stateBytes)+' bytes'+(j.usage?' · usage '+esc(JSON.stringify(j.usage)):'')+'</h3>'+(j.error?'<p class="bad">'+esc(j.error)+'</p>':'')+'<b>Questions</b>'+Object.entries(j.questions||{}).map(([id,q])=>'<details'+(id==='route'?' open':'')+'><summary>'+esc(id)+' ('+esc(q.type)+')'+(j.answers?.[id]?' → '+esc(j.answers[id].type==='noul'?'P='+j.answers[id].noul.toFixed(2):j.answers[id].choice):'')+'</summary><p>'+esc(q.instructions)+'</p>'+(q.criteria?'<ul>'+Object.entries(q.criteria).map(([k,d])=>'<li><b>'+esc(k)+'</b>'+(j.answers?.[id]?.probabilities?' <span class="muted">'+(j.answers[id].probabilities[k]??0).toFixed(2)+'</span>':'')+': '+esc(d)+'</li>').join('')+'</ul>':'')+'</details>').join('')+'<details><summary>State supplied to Jev</summary><pre>'+esc(JSON.stringify(j.state,null,2))+'</pre></details>').join('')]);
if(p){const total=Object.values(p.breakdown).reduce((a,b)=>a+b,0);const keys=Object.entries(p.breakdown).sort((a,b)=>b[1]-a[1]);tabs.push(['Prompt',(s.prompts.length>1?'<p class="muted">'+s.prompts.length+' attempts; showing the first.</p>':'')+'<p>'+fmt(p.tokens)+' tokens'+(W?' = '+Math.round(100*p.tokens/W)+'% of the '+fmt(W)+' working budget':'')+(C?', '+Math.round(100*p.tokens/C)+'% of the '+fmt(C)+' window':'')+' · '+fmt(total)+' characters</p><div class="bd">'+keys.map(([k,v],i)=>'<i style="width:'+(100*v/total)+'%;background:'+palette[i%palette.length]+'" title="'+esc(k)+' '+v+'"></i>').join('')+'</div><div class="legend">'+keys.map(([k,v],i)=>'<span><i style="display:inline-block;width:10px;height:10px;background:'+palette[i%palette.length]+';margin-right:4px"></i>'+esc(k)+' '+fmt(v)+' ('+Math.round(100*v/total)+'%)</span>').join('')+'</div><details open><summary>Exact prompt</summary><pre>'+esc(p.text?pretty(p.text):'(artifact missing: '+p.artifact+')')+'</pre></details>']);}
tabs.push(['Generation',s.bonsai.map(b=>{const sp=speed(b);return'<p>'+ms(b.ms)+(b.temperature!=null?' · temperature '+b.temperature:'')+(sp.g!=null?' · '+sp.g+' generated tokens'+(sp.gs?' @ '+sp.gs.toFixed(1)+' tok/s':''):'')+(sp.ps?' · prompt '+(b.timings?.prompt_n??b.promptTokens)+' tokens @ '+sp.ps.toFixed(0)+' tok/s':'')+(b.usage?.prompt_tokens_details?.cached_tokens?' · '+b.usage.prompt_tokens_details.cached_tokens+' cached':'')+(b.finishReason?' · finish '+esc(b.finishReason):'')+(b.error?' · <span class="bad">'+esc(b.error)+'</span>':'')+'</p>'}).join('')+(s.action?'<b>Generated arguments</b><pre>'+esc(JSON.stringify(s.action.args,null,2))+'</pre>':'<p class="muted">No arguments were accepted this step.</p>')]);
tabs.push(['Result',s.result?'<p class="'+(s.result.ok?'ok':'bad')+'">'+(s.result.ok?'ok':'failed')+' · '+ms(s.result.ms)+' · '+esc(s.result.artifact||'')+'</p><pre>'+esc(s.result.text||'(artifact missing)')+'</pre>':(s.undo?'<pre>'+esc(JSON.stringify(s.undo,null,2))+'</pre>':'<p class="muted">No tool ran.</p>')]);
const id='t'+s.step;return'<div class="tabs">'+tabs.map((t,i)=>'<button class="'+(i===0?'on':'')+'" onclick="show(\\''+id+'\\','+i+',this)">'+t[0]+'</button>').join('')+'</div>'+tabs.map((t,i)=>'<div id="'+id+'-'+i+'" style="display:'+(i?'none':'block')+'">'+t[1]+'</div>').join('');}
function pretty(t){try{const m=JSON.parse(t);return m.map(x=>'['+x.role+']\\n'+(x.role==='user'?JSON.stringify(JSON.parse(x.content),null,2):x.content)).join('\\n\\n')}catch{return t}}
function show(id,i,btn){for(let k=0;k<4;k++){const el=document.getElementById(id+'-'+k);if(el)el.style.display=k===i?'block':'none'}btn.parentNode.querySelectorAll('button').forEach(b=>b.classList.toggle('on',b===btn))}
</script></body></html>`;
}
