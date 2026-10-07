// Provenance on the engine side (spec sec 4). The database holds the rules (migration 007's core.apply_provenance and
// 008's append-only guard); this file is the first line: how a fact typed by a person is stamped, and which badge
// (sec 4.1) a stored row shows. Nothing here can make a row CONFIRMED that the database would refuse.
import type { Client } from './db.js';

export const SOURCE_CLASSES = ['VET_RECORD', 'VET_ADVICE', 'OWNER_OBSERVATION', 'AI_SUGGESTION'] as const;
export type SourceClass = (typeof SOURCE_CLASSES)[number];
/** What a person may say a hand-typed entry came from. AI_SUGGESTION is never typed in by hand. */
export const MANUAL_SOURCES = ['OWNER_OBSERVATION', 'VET_RECORD', 'VET_ADVICE'] as const;
export type ManualSource = (typeof MANUAL_SOURCES)[number];
export type FactStatus = 'PROPOSED' | 'CONFIRMED' | 'SUPERSEDED' | 'DISPUTED';

export interface Badge { code: 'VET_RECORD' | 'OUR_NOTE' | 'VET_ADVICE' | 'AI_SUGGESTION' | 'READ_FROM_DOCUMENT' | 'WAITING'; text: string }

/** The sec 4.1 badge for a row. "Read from a document" is a state (PROPOSED + DOCUMENT), not a source. */
export function badgeFor(p: { source_class: string; status: string; channel: string }): Badge {
  if (p.source_class === 'AI_SUGGESTION') return { code: 'AI_SUGGESTION', text: 'AI suggestion' };
  if (p.status === 'PROPOSED') {
    return p.channel === 'DOCUMENT' ? { code: 'READ_FROM_DOCUMENT', text: 'Read from document — check' } : { code: 'WAITING', text: 'Waiting to be checked' };
  }
  if (p.source_class === 'VET_RECORD') return { code: 'VET_RECORD', text: 'Vet record' };
  if (p.source_class === 'VET_ADVICE') return { code: 'VET_ADVICE', text: 'Vet advice' };
  return { code: 'OUR_NOTE', text: 'Our note' };
}

/**
 * The provenance columns for something a person typed in (channel MANUAL, extraction MANUAL). Confirmed at once, by
 * them, when they may confirm; otherwise PROPOSED, waiting for an Owner / Primary carer (sec 7.2).
 */
export function manualProvenance(member: string, source: ManualSource, confirm: boolean): Record<string, unknown> {
  return {
    status: confirm ? 'CONFIRMED' : 'PROPOSED',
    source_class: source,
    channel: 'MANUAL',
    extraction_method: 'MANUAL',
    proposed_by: member,
    confirmed_by: confirm ? member : null,
    confirmed_at: confirm ? new Date().toISOString() : null,
  };
}

/** INSERT one row of plain column -> value pairs (names come from code, never from a request), returning its id. */
export async function insertRow(c: Client, table: string, pk: string, row: Record<string, unknown>): Promise<number> {
  const cols = Object.keys(row);
  const r = await c.query<{ id: string }>(
    `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING ${pk}::text AS id`,
    Object.values(row),
  );
  return Number(r.rows[0]!.id);
}
