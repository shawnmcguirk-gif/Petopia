// The measurement registry (spec sec 3.5 health.measurement, 9.4 "Weight"; S3, A16). Pure: no database.
// Stored units: weight kg, length/height cm, body condition score in the scale it was given (/9 or /5). Conversions use
// decimal.js, never float arithmetic on a stored value (Vitalis measures.ts). The DB keeps the same registry in
// ref.measure / ref.measure_unit (migration 008); a DB test fails if they drift.
// Plausibility: an entry that looks like a slip (61 kg for an animal last weighed at 6.1 kg) is not saved silently --
// the person is asked "did you mean 6.1 kg?" and must answer. Sanity ranges are wide bounds per species module, used
// only to catch typing slips; they are never shown as a breed average or a judgement about the animal (sec 10.3).
import { Decimal } from 'decimal.js';
import { bad } from './errors.js';

export type MeasureCode = 'weight' | 'length' | 'height' | 'bcs';
export const MEASURE_CODES: readonly MeasureCode[] = ['weight', 'length', 'height', 'bcs'];

export interface MeasureDef {
  code: MeasureCode;
  label: string;
  kind: 'MASS' | 'LENGTH' | 'SCORE';
  /** stored unit; null = stored in the unit it was entered in (scores) */
  stored: string | null;
  /** accepted unit -> factor to the stored unit (null = no conversion) */
  units: Record<string, string | null>;
}

export const MEASURES: Record<MeasureCode, MeasureDef> = {
  weight: { code: 'weight', label: 'Weight', kind: 'MASS', stored: 'kg', units: { kg: '1', g: '0.001', lb: '0.45359237' } },
  length: { code: 'length', label: 'Length', kind: 'LENGTH', stored: 'cm', units: { cm: '1', mm: '0.1', in: '2.54' } },
  height: { code: 'height', label: 'Height', kind: 'LENGTH', stored: 'cm', units: { cm: '1', mm: '0.1', in: '2.54' } },
  bcs: { code: 'bcs', label: 'Body condition score', kind: 'SCORE', stored: null, units: { '/9': null, '/5': null } },
};

/** Wide typing-slip bounds in the stored unit, per species module. Not reference values; never displayed as such. */
const SANITY: Partial<Record<MeasureCode, Record<string, [number, number]>>> = {
  weight: {
    dog: [0.1, 120], cat: [0.05, 15], rabbit: [0.05, 12], small_mammal: [0.005, 15], cage_bird: [0.005, 2.5], poultry: [0.1, 15],
    reptile: [0.001, 120], amphibian: [0.001, 2], aquarium_fish: [0.0005, 10], equine: [15, 1300], default: [0.001, 1500],
  },
  length: { default: [0.5, 400] },
  height: { default: [0.5, 300] },
};

/** "a dog", "a rabbit", "a horse": the module in words, with its article. Anything else is just "this animal". */
const KIND_WORDS: Record<string, string> = { dog: 'a dog', cat: 'a cat', rabbit: 'a rabbit', small_mammal: 'a small animal', cage_bird: 'a bird', poultry: 'a bird', reptile: 'a reptile', amphibian: 'an amphibian', aquarium_fish: 'a fish', equine: 'a horse' };
const kindOf = (module: string): string => KIND_WORDS[module] ?? 'this animal';

export const isMeasure = (v: unknown): v is MeasureCode => typeof v === 'string' && (MEASURE_CODES as readonly string[]).includes(v);

export function measureDef(code: unknown): MeasureDef {
  if (!isMeasure(code)) throw bad(`measure must be one of ${MEASURE_CODES.join(', ')}`);
  return MEASURES[code];
}

/** "6.1", "6,1" (comma decimal) or 6.1 -> Decimal. Throws 400 on anything else, zero or below. */
export function parseAmount(v: unknown, field = 'value'): Decimal {
  let s: string;
  if (typeof v === 'number' && Number.isFinite(v)) s = String(v);
  else if (typeof v === 'string' && /^\s*\d+([.,]\d+)?\s*$/.test(v)) s = v.trim().replace(',', '.');
  else throw bad(`${field} must be a number`);
  const d = new Decimal(s);
  if (d.lessThanOrEqualTo(0)) throw bad(`${field} must be more than zero`);
  if (d.decimalPlaces() > 3) throw bad(`${field} can have at most 3 decimal places`);
  return d;
}

export const fmt = (d: Decimal): string => d.toDecimalPlaces(3).toString();

export interface Normalised {
  measure: MeasureCode;
  value: Decimal; // in `unit`
  unit: string; // the stored unit
  entered: { value: Decimal; unit: string };
}

/** Converts what was typed to the stored unit (3 decimal places). Throws 400 for an unknown unit or a bad score. */
export function normalise(code: unknown, value: unknown, unit: unknown): Normalised {
  const m = measureDef(code);
  if (typeof unit !== 'string' || !(unit in m.units)) throw bad(`${m.label.toLowerCase()} can be entered in ${Object.keys(m.units).join(', ')}`);
  const v = parseAmount(value);
  const factor = m.units[unit];
  if (m.kind === 'SCORE') {
    const max = unit === '/9' ? 9 : 5;
    const step = unit === '/9' ? new Decimal(1) : new Decimal(0.5);
    if (v.lessThan(1) || v.greaterThan(max) || !v.mod(step).isZero()) {
      throw bad(`a body condition score ${unit} is ${unit === '/9' ? 'a whole number from 1 to 9' : 'from 1 to 5 in half steps'}`);
    }
    return { measure: m.code, value: v, unit, entered: { value: v, unit } };
  }
  const stored = v.times(factor ?? '1').toDecimalPlaces(3);
  if (stored.isZero()) throw bad(`${fmt(v)} ${unit} is too small to record`);
  return { measure: m.code, value: stored, unit: m.stored!, entered: { value: v, unit } };
}

export interface Previous { value: Decimal; unit: string; on: string }
export type Plausibility =
  | { ok: true }
  | { ok: false; question: string; suggestion: { value: string; unit: string } | null };

/** Above this relative change from the nearest earlier confirmed reading, the person is asked first. */
export const MAX_CHANGE = new Decimal('0.2');

const within = (a: Decimal, b: Decimal, rel: Decimal): boolean => a.minus(b).abs().lessThanOrEqualTo(b.times(rel));

/** What a slip most likely was: a misplaced decimal point, or the wrong unit chosen. In the ENTERED unit when possible. */
function candidates(n: Normalised): { stored: Decimal; shown: { value: Decimal; unit: string } }[] {
  const m = MEASURES[n.measure];
  const out: { stored: Decimal; shown: { value: Decimal; unit: string } }[] = [];
  for (const f of ['0.1', '0.01', '10', '0.001', '100']) {
    const ev = n.entered.value.times(f);
    if (ev.decimalPlaces() > 3) continue;
    out.push({ stored: n.value.times(f).toDecimalPlaces(3), shown: { value: ev, unit: n.entered.unit } });
  }
  for (const [u, factor] of Object.entries(m.units)) {
    if (u === n.entered.unit || factor === null) continue;
    out.push({ stored: n.entered.value.times(factor).toDecimalPlaces(3), shown: { value: n.entered.value, unit: u } });
  }
  return out;
}

/**
 * Is this reading believable? Compared with the nearest earlier confirmed reading (same stored unit) when there is
 * one, else with the module's wide sanity bounds. Scores are always in range already (normalise checked them).
 */
export function plausibility(n: Normalised, previous: Previous | null, module: string): Plausibility {
  const m = MEASURES[n.measure];
  if (m.kind === 'SCORE') return { ok: true };
  const typed = `${fmt(n.entered.value)} ${n.entered.unit}`;
  const suggest = (ok: (d: Decimal) => boolean) => {
    const c = candidates(n).find((x) => ok(x.stored));
    return c ? { value: fmt(c.shown.value), unit: c.shown.unit } : null;
  };
  if (previous && previous.unit === n.unit) {
    if (within(n.value, previous.value, MAX_CHANGE)) return { ok: true };
    const s = suggest((d) => within(d, previous.value, MAX_CHANGE));
    const last = `${fmt(previous.value)} ${previous.unit} on ${previous.on}`;
    return {
      ok: false,
      suggestion: s,
      question: s
        ? `${typed} is very different from the last ${m.label.toLowerCase()} (${last}). Did you mean ${s.value} ${s.unit}?`
        : `${typed} is very different from the last ${m.label.toLowerCase()} (${last}). Is that right?`,
    };
  }
  const bounds = SANITY[n.measure];
  const [lo, hi] = bounds ? (bounds[module] ?? bounds.default!) : [0, Infinity];
  if (n.value.greaterThanOrEqualTo(lo) && n.value.lessThanOrEqualTo(hi)) return { ok: true };
  const s = suggest((d) => d.greaterThanOrEqualTo(lo) && d.lessThanOrEqualTo(hi));
  return {
    ok: false,
    suggestion: s,
    question: s ? `${typed} looks unusual for ${kindOf(module)}. Did you mean ${s.value} ${s.unit}?` : `${typed} looks unusual for ${kindOf(module)}. Is that right?`,
  };
}

export interface Reading { value: string; unit: string; on: string }
/** Each reading with its change since the one before it (same unit only), oldest first in, oldest first out. */
export function withChanges<T extends Reading>(rows: T[]): (T & { change: string | null })[] {
  return rows.map((r, i) => {
    const prev = rows[i - 1];
    if (!prev || prev.unit !== r.unit) return { ...r, change: null };
    const d = new Decimal(r.value).minus(prev.value);
    return { ...r, change: d.isZero() ? '0' : `${d.isPositive() ? '+' : ''}${fmt(d)}` };
  });
}
