// Species modules (spec sec 3.3, A6): one animal table for every animal; species-specific fields live in `ext`, which
// is validated by ajv against the module's JSON Schema held in ref.species_module (v1: dog, cat). New species = new
// module row + schema file, no core change. The schema files in engine/schemas/species/ are the reviewed source; the
// migration carries byte-identical copies (test/species.test.ts checks they agree).
import { Ajv, type ValidateFunction } from 'ajv';
import { invalid } from './errors.js';

export interface SpeciesModule {
  code: string;
  schema: Record<string, unknown>;
  schema_version: number;
}

const compiled = new Map<string, ValidateFunction>();

function validatorFor(m: SpeciesModule): ValidateFunction {
  const key = `${m.code}:${m.schema_version}`;
  let v = compiled.get(key);
  if (!v) {
    // A fresh Ajv per module version, so two versions sharing an $id never collide. strict: unknown keywords are errors.
    v = new Ajv({ allErrors: true, strict: true }).compile(m.schema);
    compiled.set(key, v);
  }
  return v;
}

/** The problems with `ext` for this module, in plain words; empty when it is valid. */
export function extProblems(m: SpeciesModule, ext: unknown): string[] {
  const v = validatorFor(m);
  if (v(ext)) return [];
  return (v.errors ?? []).map((e) => {
    const where = e.instancePath ? e.instancePath.slice(1).replace(/\//g, '.') : m.code;
    if (e.keyword === 'additionalProperties') return `${String((e.params as { additionalProperty?: string }).additionalProperty)} is not a ${m.code} field`;
    if (e.keyword === 'enum') return `${where} must be one of ${((e.params as { allowedValues?: unknown[] }).allowedValues ?? []).join(', ')}`;
    return `${where} ${e.message ?? 'is not valid'}`;
  });
}

/** Throws 422 with every problem listed. */
export function assertExt(m: SpeciesModule, ext: unknown): Record<string, unknown> {
  const p = extProblems(m, ext);
  if (p.length) throw invalid(`these ${m.code} details are not valid: ${p.join('; ')}`);
  return ext as Record<string, unknown>;
}
