import type { JsonSchema, Route } from './types.js';
const str = (maxLength = 1000): JsonSchema => ({ type: 'string', maxLength });
const integer = (minimum: number, maximum: number): JsonSchema => ({ type: 'integer', minimum, maximum });
const obj = (properties: Record<string, JsonSchema>): JsonSchema => ({
  type: 'object', properties, required: Object.keys(properties), additionalProperties: false,
});
export const schemas: Record<Route, JsonSchema> = {
  read_files: obj({ files: { type: 'array', minItems: 1, maxItems: 3,
    items: obj({ path: str(500), start: integer(1, 1000000), end: integer(1, 1000000) }) } }),
  search_codebase: obj({ query: str(300), path: str(500), mode: { ...str(), enum: ['text', 'files'] } }),
  write: obj({ path: str(500), expectedHash: str(64), oldText: str(16000), newText: str(16000) }),
  move_lines: obj({ source: str(500), expectedHash: str(64), start: integer(1, 1000000), end: integer(1, 1000000),
    destination: str(500), destinationHash: str(64), replacement: str(4000), prefix: str(4000) }),
  bash: obj({ command: str(2000), purpose: str(500) }),
  tasks: obj({ tasks: { type: 'array', minItems: 1, maxItems: 12,
    items: obj({ id: { ...str(40), minLength: 1 }, description: str(300),
      status: { ...str(), enum: ['pending', 'done'] }, evidence: str(500) }) } }),
  finish: obj({ summary: str(4000) }),
  ask_user: obj({ question: str(2000) }),
};
// llama.cpp builds can reject repetition bounds such as maxLength=2000 in GBNF.
// Keep shape constraints during sampling and enforce all size limits locally.
export function samplingSchema(schema: JsonSchema): JsonSchema {
  const copy = structuredClone(schema);
  if (copy.type === 'string' && (copy.maxLength ?? 0) > 1000) delete copy.maxLength;
  if (copy.properties) copy.properties = Object.fromEntries(Object.entries(copy.properties).map(([k, v]) => [k, samplingSchema(v)]));
  if (copy.items) copy.items = samplingSchema(copy.items);
  return copy;
}
export function validate(schema: JsonSchema, value: unknown, path = 'args'): void {
  const fail = (reason: string): never => { throw new Error(`${path}: ${reason}`); };
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
      if ((value as string).length < (schema.minLength ?? 0) || (value as string).length > (schema.maxLength ?? Infinity)) fail('string length');
      if (schema.enum && !schema.enum.includes(value as string)) fail('unknown choice'); break;
    case 'integer':
      if (!Number.isSafeInteger(value) || (value as number) < (schema.minimum ?? -Infinity) || (value as number) > (schema.maximum ?? Infinity)) fail('integer out of range'); break;
    case 'boolean': if (typeof value !== 'boolean') fail('expected boolean');
  }
}
