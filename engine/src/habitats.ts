// Habitats (spec sec 3.4, A7): first-class from day one; Home and Garden are seeded by migration 003.
import { kdb, type Client } from './db.js';

export interface HabitatView { id: number; name: string; kind: string; parent_id: number | null }

export async function listHabitats(c: Client): Promise<HabitatView[]> {
  const rows = await kdb(c).selectFrom('core.habitat').select(['habitat_id', 'name', 'kind', 'parent_id']).where('retired_at', 'is', null).orderBy('habitat_id').execute();
  return rows.map((r) => ({ id: Number(r.habitat_id), name: r.name, kind: r.kind, parent_id: r.parent_id === null ? null : Number(r.parent_id) }));
}
