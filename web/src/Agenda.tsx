// Today and Coming Up (spec sec 9.3; S6, A23): what the engine derived, nothing stored here. Today's items carry a
// one-tap Done that writes the shared care log (who, when); if someone else already did it, it says who. Viewers see
// the list without the button. An empty list renders nothing -- the caller hides the section.
import { Check } from 'lucide-react';
import { useState } from 'react';
import { ApiError, post, type AgendaItem, type LogResult } from './api';
import { niceDate } from './format';
import { Card } from './ui';
import { dueWords } from './words';

export function AgendaList({ items, showAnimal = true, onDone, done = false }: { items: AgendaItem[]; showAnimal?: boolean; onDone?: () => void; done?: boolean }) {
  if (!items.length) return null;
  return (
    <Card className="divide-y divide-line overflow-hidden">
      {items.map((x) => <Row key={x.key} x={x} showAnimal={showAnimal} onDone={onDone} canTick={done} />)}
    </Card>
  );
}

function Row({ x, showAnimal, onDone, canTick }: { x: AgendaItem; showAnimal: boolean; onDone?: () => void; canTick: boolean }) {
  const [state, setState] = useState<'idle' | 'busy' | { by: string; mine: boolean } | { error: string }>('idle');
  const tone = x.overdue ? 'text-red' : x.days <= 3 ? 'text-amber' : 'text-ink-2';
  async function tick() {
    setState('busy');
    try {
      const r = await post<LogResult>(`api/animals/${x.animal_id}/care-log`, { routine_id: x.routine_id, due_on: x.due_on, due_slot: x.time ?? '' });
      setState({ by: r.by, mine: r.logged });
      onDone?.();
    } catch (e) {
      setState({ error: e instanceof ApiError ? e.message : 'Not saved — try again.' });
    }
  }
  const finished = typeof state === 'object' && 'by' in state;
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-3">
      <div className="min-w-0">
        <p className="m-0 font-semibold">{showAnimal ? `${x.animal} — ` : ''}{x.title}{x.time ? <span className="font-normal text-ink-2"> · {x.time}</span> : null}</p>
        <p className={`m-0 text-[14px] ${tone}`}>{canTick ? (x.overdue ? `${dueWords(x.days)} (since ${niceDate(x.due_on)})` : x.detail ?? 'today') : `${niceDate(x.due_on)} · ${dueWords(x.days)}`}{!canTick && x.detail ? ` · ${x.detail}` : ''}</p>
        {finished && <p className="m-0 text-[13px] text-moss">{state.mine ? 'Done — thanks' : `Already done by ${state.by}`}</p>}
        {typeof state === 'object' && 'error' in state && <p role="alert" className="m-0 text-[13px] text-red">{state.error}</p>}
      </div>
      {canTick && x.can_log && x.routine_id !== null && !finished && (
        <button type="button" className="btn min-h-11 shrink-0 px-4" disabled={state === 'busy'} onClick={() => void tick()} aria-label={`Done: ${x.animal} ${x.title}${x.time ? ` ${x.time}` : ''}`}>
          <Check aria-hidden className="h-5 w-5" strokeWidth={2} />Done
        </button>
      )}
    </div>
  );
}
