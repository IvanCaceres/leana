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
  // that starts what is observed (empty when none), target the URL or command; inputs play a page
  // as its user would (empty for none, and for the other kinds).
  observe: obj({ kind: { type: 'string', enum: observerKinds }, start: str(500), target: str(1000),
    inputs: { type: 'array', maxItems: 12, items: obj({ do: { type: 'string', enum: ['press', 'hold', 'type', 'click', 'wait'] }, what: str(200), ms: integer(0, 10000) }) } }),
};
// One action of a step: its name, then its arguments under that action's schema. The step's
// reasoning is its one thought, written before all its actions;
export const actions = ['read_files', 'search_codebase', 'bash', 'create_file', 'rewrite_file', 'write', 'replace_lines', 'move_lines', 'plan', 'observe', 'finish', 'ask_user'] as const;
export const stepSchema: JsonSchema = { anyOf: actions.map(a => obj({ action: { type: 'string', const: a, enum: [a] }, args: schemas[a] })) };
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
      if ((value as unknown[]).length < (schema.minItems ?? 0) || (value as unknown[]).length > (schema.maxItems ?? Infinity)) fail(`array length ${(value as unknown[]).length}, not ${schema.maxItems === undefined ? `at least ${schema.minItems ?? 0}` : `${schema.minItems ?? 0} to ${schema.maxItems}`} items`);
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
// The arguments a call may leave out under the tools form (Session.form), with what each means when left out.
// A grammar has Bonsai write every field; a model's own tool calling sends what it decides and leaves out the
// rest, as its tools' schemas allow (run 94, steps 39-42: a deletion refused four times over newText, then
// prepend). at is where the fields are: the arguments themselves ([]) or each item of an array ('*').
export const argDefaults: Partial<Record<Route, { at: string[]; values: Record<string, unknown> }[]>> = {
  read_files: [{ at: ['files', '*'], values: { start: 1, end: 1000000 } }],
  search_codebase: [{ at: [], values: { path: '.', mode: 'text' } }],
  bash: [{ at: [], values: { purpose: '', check: false } }],
  replace_lines: [{ at: ['edits', '*'], values: { newText: '', prepend: '' } }],
  observe: [{ at: [], values: { start: '', inputs: [] } }, { at: ['inputs', '*'], values: { what: '', ms: 0 } }],
};
// The objects at a path of a value (or of a schema, by its properties and items).
function objectsAt(v: any, at: string[], schema: boolean): any[] {
  let found = [v];
  for (const key of at) found = found.flatMap(x => !x || typeof x !== 'object' ? [] : key === '*' ? (schema ? (x.items ? [x.items] : []) : Array.isArray(x) ? x : []) : schema ? (x.properties?.[key] ? [x.properties[key]] : []) : [x[key]]);
  return found.filter(x => x && typeof x === 'object' && !Array.isArray(x));
}
// The file actions as the model's own tools (the tools form): the model writes the content in its call, as it is
// trained to, so it sees in its own turn what it wrote (run 93: about fifteen reads of files it had just had
// generated in a request it never saw). write is an exact replacement whose anchor is the guard; its hash is optional.
export const toolForms: Partial<Record<Route, JsonSchema>> = {
  create_file: obj({ path: str(500), content: str() }),
  rewrite_file: { type: 'object', properties: { path: str(500), content: str(), start: integer(1, 1000000), end: integer(0, 1000000) }, required: ['path', 'content'], additionalProperties: false },
  write: { type: 'object', properties: { path: str(500), oldText: str(), newText: str(), expectedHash: str(16) }, required: ['path', 'oldText', 'newText'], additionalProperties: false },
};
// An action's arguments as one of the model's tools: its tools-form shape, the fields that have a default not required.
export function toolSchema(route: Route): JsonSchema {
  const copy = structuredClone(toolForms[route] ?? schemas[route]);
  for (const d of argDefaults[route] ?? []) for (const o of objectsAt(copy, d.at, true)) if (Array.isArray(o.required)) o.required = o.required.filter((k: string) => !(k in d.values));
  return copy;
}
// The arguments of a call with what it left out filled in by its defaults.
export function withDefaults(route: string, args: Record<string, any>): Record<string, any> {
  const copy = structuredClone(args);
  for (const d of argDefaults[route as Route] ?? []) for (const o of objectsAt(copy, d.at, false)) for (const [k, v] of Object.entries(d.values)) if (o[k] === undefined) o[k] = structuredClone(v);
  return copy;
}
