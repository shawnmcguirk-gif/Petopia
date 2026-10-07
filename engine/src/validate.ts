// Request bodies are checked against a JSON Schema with ajv before any rule runs (spec sec 2: ajv for every input
// that crosses a boundary). additionalProperties is false everywhere: an unknown field is a mistake, not ignored.
// Problems come back as one 400 in plain words.
import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv';
import { bad } from './errors.js';

const ajv = new Ajv({ allErrors: true, strict: true, allowUnionTypes: true });

function words(errors: ErrorObject[] | null | undefined): string {
  return (errors ?? []).map((e) => {
    const where = e.instancePath ? e.instancePath.slice(1).replace(/\//g, '.') : 'the request';
    if (e.keyword === 'additionalProperties') return `${String((e.params as { additionalProperty?: string }).additionalProperty)} is not a field here`;
    if (e.keyword === 'required') return `${String((e.params as { missingProperty?: string }).missingProperty)} is required`;
    if (e.keyword === 'enum') return `${where} must be one of ${((e.params as { allowedValues?: unknown[] }).allowedValues ?? []).join(', ')}`;
    return `${where} ${e.message ?? 'is not valid'}`;
  }).join('; ');
}

export type Schema = Record<string, unknown>;

/** Compiles once; the returned function throws 400 with every problem, or returns the body typed as T. */
export function bodyChecker<T>(schema: Schema): (body: unknown) => T {
  const v: ValidateFunction = ajv.compile(schema);
  return (body: unknown): T => {
    if (!v(body)) throw bad(words(v.errors));
    return body as T;
  };
}

// Small schema builders, so the schemas read like the spec tables.
export const S = {
  text: (max = 200): Schema => ({ type: ['string', 'null'], maxLength: max }),
  date: (): Schema => ({ type: ['string', 'null'], pattern: '^\\d{4}-\\d{1,2}-\\d{1,2}$' }),
  vagueDate: (): Schema => ({ type: ['string', 'null'], pattern: '^\\d{4}(-\\d{1,2}){0,2}$' }),
  oneOf: (values: readonly string[]): Schema => ({ type: 'string', enum: [...values] }),
  number: (): Schema => ({ type: ['number', 'string', 'null'] }),
  id: (): Schema => ({ type: ['integer', 'null'], minimum: 1 }),
  object: (properties: Record<string, Schema>, required: string[] = []): Schema => ({ type: 'object', additionalProperties: false, properties, required }),
};
