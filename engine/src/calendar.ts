// Vet appointments to the calendar (Petopia D1 spec sec 6 "Calendar detail"; S6, A25), copied from Vitalis
// engine/src/calendar.ts. Synapse owns calendars (core.events, Synapse D25): Petopia asks its events router
// (POST /webhook/events, header X-Serenity-Service) to add, move or cancel an event on the Primary carer's calendar
// (else the Owner's, else whoever booked it). The router saves it, and mirrors it to that person's Google Calendar only
// if they connected Google. Best effort: a failure never stops the appointment being saved; it shows "not on a
// calendar" with a retry. Edits made in Google do not flow back. Daily care is never sent (no notification noise).
// Env: PETOPIA_EVENTS_URL (default n8n on localhost), PETOPIA_SERVICE_SECRET (unset = calendar off, says nothing).
export type CalendarState = 'SAVED' | 'ON_GOOGLE' | 'FAILED';
export const REMINDER_MINUTES = 120;

export interface VisitInfo { id: number; ws: number; with_whom: string; scheduled_on: string | null; scheduled_time: string | null; reason: string | null; calendar_event_id: number | null; }
export interface CalendarResult { state: CalendarState | null; event_id: number | null; }

const URL_ = (): string => process.env.PETOPIA_EVENTS_URL ?? 'http://localhost:5678/webhook/events';
const SECRET = (): string => process.env.PETOPIA_SERVICE_SECRET ?? '';

/** Wall-clock time in Europe/Dublin to an ISO instant (handles summer time). */
export function dublinToIso(date: string, time: string): string {
  const [y, mo, d] = date.split('-').map(Number) as [number, number, number];
  const [h, mi] = time.split(':').map(Number) as [number, number];
  const want = Date.UTC(y, mo - 1, d, h, mi);
  const offsetAt = (ms: number): number => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Dublin', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute)) - ms;
  };
  let t = want - offsetAt(want);
  t = want - offsetAt(t);
  return new Date(t).toISOString();
}

export function eventPayload(v: VisitInfo, recordName: string, actorOwnsRecord: boolean): Record<string, unknown> | null {
  if (!v.scheduled_on) return null;
  const title = `${actorOwnsRecord ? '' : `${recordName}: `}${v.with_whom}`.slice(0, 200);
  const p: Record<string, unknown> = { title, description: v.reason ?? null, tz: 'Europe/Dublin', source: 'manual' };
  if (v.scheduled_time) { p.starts_at = dublinToIso(v.scheduled_on, v.scheduled_time); p.reminder_minutes = REMINDER_MINUTES; }
  else { p.starts_at = dublinToIso(v.scheduled_on, '00:00'); p.all_day = true; }
  return p;
}

async function call(persona: string, action: 'add' | 'update' | 'cancel', payload: Record<string, unknown>, requestId: string): Promise<{ ok: boolean; id: number | null; google: boolean }> {
  const res = await fetch(URL_(), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-serenity-service': SECRET() },
    body: JSON.stringify({ action, request_id: requestId, persona_key: persona, payload }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return { ok: false, id: null, google: false };
  const b = (await res.json()) as { ok?: boolean; event?: { id?: number | string }; markdown?: string };
  const id = b.event?.id !== undefined ? Number(b.event.id) : null;
  return { ok: b.ok === true, id: Number.isFinite(id) ? id : null, google: typeof b.markdown === 'string' && /Google mirror/i.test(b.markdown) };
}

/** Make the calendar match the visit. cancelled = the visit was cancelled. Never throws. */
export async function syncVisit(persona: string | undefined, v: VisitInfo, recordName: string, actorOwnsRecord: boolean, cancelled = false): Promise<CalendarResult | null> {
  if (!persona || !SECRET()) return null; // not linked to a Synapse persona, or not set up: say nothing
  try {
    if (cancelled) {
      if (v.calendar_event_id === null) return null;
      const r = await call(persona, 'cancel', { event_id: v.calendar_event_id }, `petopia-appt-${v.ws}-${v.id}-cancel`);
      return { state: r.ok ? null : 'FAILED', event_id: r.ok ? null : v.calendar_event_id };
    }
    const payload = eventPayload(v, recordName, actorOwnsRecord);
    if (!payload) return null;
    if (v.calendar_event_id !== null) {
      const r = await call(persona, 'update', { ...payload, event_id: v.calendar_event_id }, `petopia-appt-${v.ws}-${v.id}-upd-${Date.now()}`);
      return { state: r.ok ? (r.google ? 'ON_GOOGLE' : 'SAVED') : 'FAILED', event_id: v.calendar_event_id };
    }
    const r = await call(persona, 'add', payload, `petopia-appt-${v.ws}-${v.id}-add`);
    return { state: r.ok ? (r.google ? 'ON_GOOGLE' : 'SAVED') : 'FAILED', event_id: r.id };
  } catch {
    return { state: 'FAILED', event_id: v.calendar_event_id };
  }
}
