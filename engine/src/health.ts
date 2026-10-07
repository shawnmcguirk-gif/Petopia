// The Health tab in one read (spec sec 8.3): every record kind, the medicines with the derived current list, and the
// weight readings. Read-only; everyone with a role on the animal may look (sec 7.2 row 1).
import { requireOn } from './access.js';
import type { Client } from './db.js';
import { listMeasurements, type MeasurementView } from './measurements.js';
import { listMedications } from './medications.js';
import { KIND_CODES, listRecords, type Kind, type RecordView } from './records.js';

export async function getHealth(c: Client, animalId: number, member: string): Promise<{
  records: Record<Kind, RecordView[]>; medications: Awaited<ReturnType<typeof listMedications>>; measurements: MeasurementView[];
}> {
  await requireOn(c, animalId, member, 'VIEW');
  const records = {} as Record<Kind, RecordView[]>;
  for (const k of KIND_CODES) records[k] = await listRecords(c, k, animalId);
  return { records, medications: await listMedications(c, animalId, member), measurements: await listMeasurements(c, animalId, member) };
}
