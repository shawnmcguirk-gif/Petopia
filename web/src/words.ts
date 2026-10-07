// Plain words for stored codes (CONVENTIONS sec 32). Only real data is ever turned into words; nothing is invented.
import type { Animal } from './api';

export const HEALTH_WORDS: Record<NonNullable<Animal['health_status']>, string> = {
  HEALTHY: 'Healthy',
  UNDER_TREATMENT: 'Under treatment',
  NEEDS_ATTENTION: 'Needs attention',
};
export const SEX_WORDS: Record<Animal['sex'], string | null> = { FEMALE: 'Female', MALE: 'Male', UNKNOWN: null };
export const NEUTER_WORDS: Record<Animal['neuter_status'], string | null> = { NEUTERED: 'Yes', ENTIRE: 'No', UNKNOWN: null };

/** "Shih Tzu · about 8 years · 6.1 kg" -- each part only when it is known. */
export function summaryLine(a: Pick<Animal, 'species' | 'breed' | 'age' | 'latest_weight'>): string {
  const parts = [a.breed || a.species];
  if (a.age) parts.push(a.age.text);
  if (a.latest_weight) parts.push(`${Number(a.latest_weight.kg)} kg`);
  return parts.join(' · ');
}

export const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? '' : 's'}`;

export const FOOD_TYPE_WORDS: Record<string, string> = {
  DRY: 'Dry', WET: 'Wet', RAW: 'Raw', MIXED: 'Mixed', PELLET: 'Pellets', FLAKE: 'Flakes', HAY: 'Hay', LIVE: 'Live food', OTHER: 'Other',
};

/** "Acme Senior · Wet · 60 g · 08:00, 18:00" -- only the parts that are known. */
export function foodLine(f: { brand: string | null; product: string | null; food_type: string; portion_amount: string | null; portion_unit: string | null; times: string[] }): string {
  const parts = [[f.brand, f.product].filter(Boolean).join(' '), FOOD_TYPE_WORDS[f.food_type] ?? f.food_type];
  if (f.portion_amount) parts.push(`${Number(f.portion_amount)} ${f.portion_unit ?? ''}`.trim());
  if (f.times.length) parts.push(f.times.join(', '));
  return parts.filter(Boolean).join(' · ');
}

// ---- S5 / S6 / S7 words
export const ROUTINE_WORDS: Record<string, string> = {
  FEED: 'Feed', WALK: 'Walk', GROOM: 'Grooming', BATH: 'Bath', NAILS: 'Nails', TEETH: 'Teeth', EARS: 'Ears', MEDICATION: 'Medication', FLEA: 'Flea treatment',
  WORM: 'Worming', VACCINATION: 'Vaccination', TANK_CLEAN: 'Tank clean', WATER_TEST: 'Water test', CAGE_CLEAN: 'Cage clean', BEDDING: 'Bedding', FEEDER_REFILL: 'Feeder refill', OTHER: 'Other care',
};
export const DOC_KIND_WORDS: Record<string, string> = {
  VET_LETTER: 'Vet letter', INVOICE: 'Vet invoice', VACCINATION_CERT: 'Vaccination certificate', INSURANCE_POLICY: 'Insurance policy', INSURANCE_CLAIM: 'Insurance claim',
  PRESCRIPTION: 'Prescription', LAB_REPORT: 'Lab report', ADOPTION: 'Adoption papers', PEDIGREE: 'Pedigree', MICROCHIP: 'Microchip papers', PHOTO: 'Photo', SCREENSHOT: 'Screenshot', OTHER: 'Other document',
};
export const TARGET_WORDS: Record<string, string> = {
  contact: 'Vet practice', vet_visit: 'Vet visit', vaccination: 'Vaccination', treatment: 'Treatment', condition: 'Condition', allergy: 'Allergy', procedure: 'Procedure',
  lab_result: 'Lab result', medication: 'Medicine', weight: 'Weight',
};
export const FIELD_WORDS: Record<string, string> = {
  name: 'Name', phone: 'Phone', visit_on: 'Date', kind: 'Kind', vet_name: 'Vet', reason: 'Reason', symptoms: 'Symptoms', examination: 'Examination', diagnosis_text: 'Diagnosis (as written)',
  treatment_text: 'Treatment', follow_up_on: 'Follow-up', notes: 'Notes', vaccine: 'Vaccine', given_on: 'Given', next_due_on: 'Next due', batch: 'Batch', product: 'Product',
  condition_status: 'Status', first_noted_on: 'First noted', substance: 'Substance', substance_kind: 'Kind', reaction: 'Reaction', certainty: 'Certainty', performed_on: 'Done on',
  outcome: 'Outcome', test: 'Test', analyte: 'Measure', value_printed: 'Value', unit_printed: 'Unit', ref_range_printed: 'Range', flag_printed: 'Flag', sampled_on: 'Sampled',
  product_name: 'Medicine', strength: 'Strength', form: 'Form', dose_text: 'Dose', dose_amount: 'Dose amount', dose_unit: 'Dose unit', frequency: 'How often',
  instructions_verbatim: 'Instructions', quantity_supplied: 'Quantity supplied', event_on: 'Prescribed on', value: 'Value', unit: 'Unit', on: 'Date', cost_amount: 'Total cost', cost_currency: 'Currency',
};
export const FLAG_WORDS: Record<string, string> = {
  AWAITING_AI_GO_AHEAD: 'Not read yet — AI reading is off', NEEDS_ANIMAL: 'Which animal?', DATE_ASSUMED: 'No date printed — please set it', VALUES_DROPPED: 'Some values were not shown: they were not in the document',
  NOT_PET_DOCUMENT: 'Does not look like a pet document', POSSIBLE_DUPLICATE: 'Possible duplicate', UNREADABLE: 'Couldn’t read — enter by hand', NO_TEXT_FOUND: 'No text found — enter by hand',
  UNSUPPORTED: 'This kind of file can’t be read', INVOICE_TOTAL_MISMATCH: 'The lines don’t add up to the total — check', DATE_NOT_IN_QUOTE: 'Date not in the quoted words — check', MOVE_FAILED: 'Filed, but the file could not be moved yet — retrying',
  KEEP_ONLY: 'Kept as a document only', PHONE_NOT_IN_QUOTE: 'Phone number not checked',
};
export const STATUS_WORDS: Record<string, string> = {
  DISCOVERED: 'Found', READ: 'Waiting to be read', ASSESSED: 'Being read', NEEDS_REVIEW: 'Ready to check', FILED_PENDING: 'Filing', FILED: 'Filed', IGNORED: 'Set aside', ASSESS_FAILED: 'Couldn’t read — enter by hand',
};
export const ROLE_WORDS: Record<string, string> = { OWNER: 'Owner', PRIMARY_CARER: 'Primary carer', FAMILY: 'Family member', VIEWER: 'Viewer' };

/** "Every day at 08:00, 18:00" / "Every 3 months" -- for the routine subset the engine accepts. */
export function scheduleWords(rrule: string, times: string[]): string {
  const f = /FREQ=(\w+)/.exec(rrule)?.[1] ?? '';
  const n = Number(/INTERVAL=(\d+)/.exec(rrule)?.[1] ?? '1');
  const days = /BYDAY=([A-Z,]+)/.exec(rrule)?.[1];
  const unit: Record<string, string> = { DAILY: 'day', WEEKLY: 'week', MONTHLY: 'month', YEARLY: 'year' };
  let s = n === 1 ? `Every ${unit[f] ?? f.toLowerCase()}` : `Every ${n} ${unit[f] ?? f.toLowerCase()}s`;
  if (days) s += ` on ${days.split(',').map((d) => ({ MO: 'Mon', TU: 'Tue', WE: 'Wed', TH: 'Thu', FR: 'Fri', SA: 'Sat', SU: 'Sun' })[d] ?? d).join(', ')}`;
  if (times.length) s += ` at ${times.join(', ')}`;
  return s;
}

/** "today", "tomorrow", "in 18 days", "3 days overdue". */
export function dueWords(days: number): string {
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days > 1) return `in ${days} days`;
  return `${-days} day${days === -1 ? '' : 's'} overdue`;
}
