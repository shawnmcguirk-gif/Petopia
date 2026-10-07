// S4 pure rules: the derived current medication list (A18), the source badges (sec 4.1, A19), manual provenance,
// the record body schemas (ajv), generic database error text (review fix), microchip format (review fix).
import { Ajv } from 'ajv';
import { describe, expect, it } from 'vitest';
import { cleanMicrochip } from '../src/animals.js';
import { fromPg } from '../src/errors.js';
import { deriveCurrent, type MedEvent } from '../src/medications.js';
import { badgeFor, manualProvenance } from '../src/provenance.js';
import { KIND_CODES, schemaFor } from '../src/records.js';

let n = 0;
const ev = (medication_id: number, event_kind: MedEvent['event_kind'], event_on: string, more: Partial<MedEvent> = {}): MedEvent => ({
  id: ++n, medication_id, product_name: medication_id === 1 ? 'Meloxicam' : 'Gabapentin', strength: null, event_kind, event_on,
  dose_text: null, dose_amount: null, dose_unit: null, frequency: null, instructions_verbatim: null, reason: null,
  status: 'CONFIRMED', source_class: 'VET_ADVICE', channel: 'MANUAL', ...more,
});

describe('deriveCurrent (A18: stopping a medicine removes it from "current")', () => {
  it('started -> current with its dose; stopped -> gone', () => {
    const start = ev(1, 'STARTED', '2026-09-01', { dose_text: '1.5 ml', frequency: 'once a day' });
    expect(deriveCurrent([start])).toMatchObject([{ medication_id: 1, dose: '1.5 ml', frequency: 'once a day', since: '2026-09-01' }]);
    expect(deriveCurrent([start, ev(1, 'STOPPED', '2026-10-01')])).toEqual([]);
  });
  it('a dose change updates the dose but not "since"; a restart after a stop starts a new run', () => {
    const list = [
      ev(1, 'PRESCRIBED', '2026-08-01', { dose_amount: '2', dose_unit: 'ml' }),
      ev(1, 'DOSE_CHANGED', '2026-08-15', { dose_amount: '1', dose_unit: 'ml' }),
      ev(1, 'STOPPED', '2026-09-01'),
      ev(1, 'STARTED', '2026-10-01'),
    ];
    expect(deriveCurrent(list)).toMatchObject([{ since: '2026-10-01', dose: null }]);
    expect(deriveCurrent(list.slice(0, 2))).toMatchObject([{ since: '2026-08-01', dose: '1 ml' }]);
  });
  it('orders by date, not by entry order; ignores anything not CONFIRMED', () => {
    const late = ev(2, 'STOPPED', '2026-10-05');
    const early = ev(2, 'STARTED', '2026-10-01');
    expect(deriveCurrent([late, early])).toEqual([]);
    expect(deriveCurrent([ev(1, 'STARTED', '2026-10-01', { status: 'PROPOSED' })])).toEqual([]);
    expect(deriveCurrent([ev(1, 'STARTED', '2026-10-01'), ev(1, 'STOPPED', '2026-10-02', { status: 'DISPUTED' })])).toHaveLength(1);
  });
});

describe('badges (sec 4.1)', () => {
  it('the six kinds stay apart', () => {
    expect(badgeFor({ source_class: 'VET_RECORD', status: 'CONFIRMED', channel: 'MANUAL' }).text).toBe('Vet record');
    expect(badgeFor({ source_class: 'OWNER_OBSERVATION', status: 'CONFIRMED', channel: 'MANUAL' }).text).toBe('Our note');
    expect(badgeFor({ source_class: 'VET_ADVICE', status: 'CONFIRMED', channel: 'MANUAL' }).text).toBe('Vet advice');
    expect(badgeFor({ source_class: 'VET_RECORD', status: 'PROPOSED', channel: 'DOCUMENT' }).text).toBe('Read from document — check');
    expect(badgeFor({ source_class: 'VET_RECORD', status: 'PROPOSED', channel: 'MANUAL' }).code).toBe('WAITING');
    expect(badgeFor({ source_class: 'AI_SUGGESTION', status: 'PROPOSED', channel: 'MANUAL' }).text).toBe('AI suggestion');
  });
  it('manual provenance: confirmed by the person who may confirm, else a proposal', () => {
    expect(manualProvenance('Alex', 'OWNER_OBSERVATION', true)).toMatchObject({ status: 'CONFIRMED', confirmed_by: 'Alex', channel: 'MANUAL', extraction_method: 'MANUAL' });
    expect(manualProvenance('Sam', 'VET_RECORD', false)).toMatchObject({ status: 'PROPOSED', confirmed_by: null, confirmed_at: null, proposed_by: 'Sam' });
  });
});

describe('record body schemas (ajv, from the registry)', () => {
  const ajv = new Ajv({ allErrors: true, strict: true, allowUnionTypes: true });
  it('every kind compiles; unknown fields and AI_SUGGESTION as a typed source are refused', () => {
    for (const k of KIND_CODES) {
      const v = ajv.compile(schemaFor(k));
      expect(v({ nonsense: 1 }), k).toBe(false);
      expect(v({ source: 'AI_SUGGESTION' }), k).toBe(false);
    }
    const vacc = ajv.compile(schemaFor('vaccination'));
    expect(vacc({ vaccine: 'Rabies', given_on: '2025-10', next_due_on: '2026-10-02', source: 'VET_RECORD' })).toBe(true);
    expect(vacc({ vaccine: 'Rabies' })).toBe(false); // given_on required
  });
});

describe('review fixes', () => {
  it('database errors never echo Postgres text (23514 / 23505), known constraints get plain words', () => {
    const raw = { code: '23505', constraint: 'uq_animal_microchip', message: 'duplicate key value violates unique constraint "uq_animal_microchip" Key (workspace_id, upper(microchip))=(1, 985...)' };
    const e = fromPg(raw)!;
    expect(e.status).toBe(409);
    expect(e.message).toBe('another animal in this household already has that microchip number');
    for (const code of ['23514', '23505', '23503', '22P02']) {
      const x = fromPg({ code, constraint: 'something_internal', message: 'new row for relation "animal" violates check constraint "something_internal"' })!;
      expect(x.message).not.toMatch(/relation|constraint|violates|key|animal_/i);
    }
  });
  it('microchip: spaces removed, 6-23 letters or digits, anything else refused', () => {
    expect(cleanMicrochip('985 112 000 123 456')).toBe('985112000123456');
    expect(cleanMicrochip('')).toBeNull();
    for (const bad of ['12345', 'x'.repeat(24), '985-112', 'chip!!']) expect(() => cleanMicrochip(bad)).toThrow(/6 to 23/);
  });
});
