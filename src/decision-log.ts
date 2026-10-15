import type { Answers, Questions } from './types.js';
function code(value: unknown): string {
  const text = JSON.stringify(value, null, 2);
  const fence = '`'.repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map(m => m[0].length + 1)));
  return `${fence}json\n${text}\n${fence}\n`;
}
export function decisionLog(type: string, data: any, at: string): string {
  if (type === 'jev-request') {
    const lines = [
      `## Request ${data.requestId}`,
      '',
      `${at} · Step ${data.step ?? 'n/a'} · ${data.phase ?? 'evaluation'} · ${data.model}`,
      '',
    ];
    for (const [id, q] of Object.entries(data.questions as Questions)) {
      lines.push(`### Question: ${id} (${q.type})`, '', q.instructions, '');
      if (q.type === 'choice') {
        for (const [option, description] of Object.entries(q.criteria)) lines.push(`- ${option}: ${description}`);
        lines.push('');
      }
    }
    lines.push('### State supplied to Jev', '', code(data.state), '');
    return lines.join('\n');
  }
  if (type === 'jev') {
    const lines = [`### Answers for ${data.requestId}`, '', `${at} · ${data.model} · ${data.ms.toFixed(1)} ms`, ''];
    for (const [id, a] of Object.entries(data.answers as Answers)) {
      if (a.type === 'noul') lines.push(`- ${id}: P(yes) = ${a.noul}`);
      else {
        lines.push(`- ${id}: selected ${a.choice}; confidence = ${a.confidence}`);
        for (const [option, p] of Object.entries(a.probabilities).sort((a, b) => b[1] - a[1]))
          lines.push(`  - ${option}: ${p}`);
      }
    }
    if (data.usage) lines.push('', `Usage: ${JSON.stringify(data.usage)}`);
    return lines.join('\n') + '\n\n---\n\n';
  }
  if (type === 'jev-error')
    return `### Error for ${data.requestId}\n\n${at} · ${data.ms.toFixed(1)} ms\n\n${data.error}\n\n---\n\n`;
  return '';
}
