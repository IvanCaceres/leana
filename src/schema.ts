import type { JsonSchema, Route } from './types.js';
import { observerKinds } from './observe-catalog.js';
const str = (maxLength?: number): JsonSchema => maxLength === undefined ? { type: 'string' } : { type: 'string', maxLength };
const integer = (minimum: number, maximum: number): JsonSchema => ({ type: 'integer', minimum, maximum });
const obj = (properties: Record<string, JsonSchema>): JsonSchema => ({
  type: 'object', properties, required: Object.keys(properties), additionalProperties: false,
});
// Length caps exist only where exceeding them is itself a content error (a path,
// a hash) and the grammar can enforce them (1000 characters or less). Code, prose and summaries are never capped: the
// grammar cannot enforce a string length, so a cap on generated content is by
// construction a rule that discards a finished generation. Descriptive fields
// are clipped where they are stored; content fields are bounded by the token
// budget and continued when it runs out.
export const schemas: Record<Route, JsonSchema> = {
  read_files: obj({ files: { type: 'array', minItems: 1, maxItems: 3,
    items: obj({ path: str(500), start: integer(1, 1000000), end: integer(1, 1000000) }) } }),
  search_codebase: obj({ query: str(300), path: str(500), mode: { ...str(), enum: ['text', 'files'] } }),
  // The content of a new file is generated as raw text in a second, grammar-free
  // request; the worker names only the path here.
  create_file: obj({ path: str(500), purpose: str() }),
  // A whole existing file regenerated as code: the worker names it and what must change.
  // Optional start/end limit the regeneration to one block, spliced into the file.
  rewrite_file: { type: 'object', properties: { path: str(500), purpose: str(), start: integer(1, 1000000), end: integer(0, 1000000) }, required: ['path', 'purpose'], additionalProperties: false },
  // An anchor replacement in an existing file. Creation is create_file's alone.
  write: obj({ path: str(500), expectedHash: str(16), oldText: str(), newText: str() }),
  replace_lines: obj({ path: str(500), expectedHash: str(16), edits: { type: 'array', minItems: 1, maxItems: 40,
    items: obj({ start: integer(1, 1000000), end: integer(1, 1000000), newText: str(), prepend: str(200) }) } }),
  // A plain cut and paste: the lines leave source and are appended to destination unchanged.
  move_lines: obj({ source: str(500), expectedHash: str(16), start: integer(1, 1000000), end: integer(1, 1000000),
    destination: str(500), destinationHash: str(16) }),
  bash: obj({ command: str(), purpose: str(), check: { type: 'boolean' } }),
  finish: obj({ summary: str() }),
  ask_user: obj({ question: str() }),
  // The worker's own notes: its plan and what it has learned, replaced whole.
  plan: obj({ notes: str() }),
  // Observe the result as its user does: kind names the observer, start the command
  // that starts what is observed (empty when none), target the URL or command.
  observe: obj({ kind: { type: 'string', enum: observerKinds }, start: str(500), target: str(1000) }),
};
// One step of the orient-reason-act loop: the worker reasons in a few
// sentences, then names one action; the action's arguments are generated next
// under that action's schema, with the reasoning in front of the worker.
export const actions = ['read_files', 'search_codebase', 'bash', 'create_file', 'rewrite_file', 'write', 'replace_lines', 'move_lines', 'plan', 'observe', 'finish', 'ask_user'] as const;
export const stepSchema: JsonSchema = { anyOf: actions.map(a => obj({ thought: str(), action: { type: 'string', const: a, enum: [a] }, args: schemas[a] })) };
// A decided edit of a known file: the harness fills path and expectedHash, so
// the worker generates only the edits it was asked for.
export const focusedEditSchema: JsonSchema = obj({ edits: schemas.replace_lines.properties!.edits! });
// llama.cpp builds can reject repetition bounds such as maxLength=2000 in GBNF.
// Keep shape constraints during sampling and enforce all size limits locally.
export function samplingSchema(schema: JsonSchema): JsonSchema {
  const copy = structuredClone(schema);
  if (copy.type === 'string' && (copy.maxLength ?? 0) > 1000) delete copy.maxLength;
  if (copy.properties) copy.properties = Object.fromEntries(Object.entries(copy.properties).map(([k, v]) => [k, samplingSchema(v)]));
  if (copy.items) copy.items = samplingSchema(copy.items);
  if (copy.anyOf) copy.anyOf = copy.anyOf.map(samplingSchema);
  return copy;
}
export function validate(schema: JsonSchema, value: unknown, path = 'args'): void {
  const fail = (reason: string): never => { throw new Error(`${path}: ${reason}`); };
  if (schema.anyOf) { const errors: string[] = []; for (const alt of schema.anyOf) { try { validate(alt, value, path); return; } catch (e) { errors.push((e as Error).message); } } fail(`matches no alternative (${errors.slice(0, 3).join(' / ')})`); }
  if (schema.const !== undefined && value !== schema.const) fail(`expected ${schema.const}`);
  switch (schema.type) {
    case 'object': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) fail('expected object');
      const v = value as Record<string, unknown>;
      for (const key of schema.required ?? []) if (!Object.hasOwn(v, key)) fail(`missing ${key}`);
      for (const key of Object.keys(v)) {
        const sub = schema.properties?.[key];
        if (!sub) fail(`unknown property ${key}`);
        validate(sub!, v[key], `${path}.${key}`);
      }
      break;
    }
    case 'array':
      if (!Array.isArray(value)) fail('expected array');
      if ((value as unknown[]).length < (schema.minItems ?? 0) || (value as unknown[]).length > (schema.maxItems ?? Infinity)) fail('array length');
      (value as unknown[]).forEach((v, i) => validate(schema.items!, v, `${path}[${i}]`)); break;
    case 'string':
      if (typeof value !== 'string') fail('expected string');
      if ((value as string).length < (schema.minLength ?? 0)) fail(`string length ${(value as string).length} is below the minimum ${schema.minLength}`);
      if ((value as string).length > (schema.maxLength ?? Infinity)) fail(`string length ${(value as string).length} exceeds the maximum ${schema.maxLength}; shorten this field`);
      if (schema.enum && !schema.enum.includes(value as string)) fail('unknown choice'); break;
    case 'integer':
      if (!Number.isSafeInteger(value) || (value as number) < (schema.minimum ?? -Infinity) || (value as number) > (schema.maximum ?? Infinity)) fail('integer out of range'); break;
    case 'boolean': if (typeof value !== 'boolean') fail('expected boolean');
  }
}
// The body of the first fenced code block, or the whole text when the model
// wrote none: a mechanical unwrap, never a reason to regenerate. A block cut
// short by the token budget has no closing fence and is taken to the end.
export function extractCode(text: string): string {
  const open = text.match(/(^|\n)\s*```[^\n]*\n/);
  if (!open || open.index === undefined) return text.replace(/\s+$/, '') + '\n';
  const start = open.index + open[0].length;
  const close = text.indexOf('\n```', start);
  const body = close < 0 ? text.slice(start) : text.slice(start, close);
  return body.replace(/\s+$/, '') + '\n';
}
