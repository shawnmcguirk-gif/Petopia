// The engine-owned inbox sweep (spec sec 2 "Scheduling", 5.2), copied from Vitalis engine/src/sweep.ts: every
// PETOPIA_SWEEP_SECONDS (default 60; 0 turns it off) the engine itself scans each folder whose person said yes, reads
// anything new, assesses it with the reader that person allows, and finishes any filing whose move failed. n8n never
// touches the database. The log carries counts only -- never a file name, a value or a quote.
import { sweepWorkspace, workspacesToSweep, type InboxDeps, type SweepReport } from './inbox.js';

let running = false;

export async function sweepOnce(deps: InboxDeps, only?: number[]): Promise<SweepReport[]> {
  const out: SweepReport[] = [];
  for (const ws of await workspacesToSweep()) {
    if (only && !only.includes(ws)) continue;
    const r = await sweepWorkspace(ws, deps);
    if (r) out.push(r);
  }
  return out;
}

export function startSweep(deps: InboxDeps, seconds = Number(process.env.PETOPIA_SWEEP_SECONDS ?? 60)): NodeJS.Timeout | null {
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      for (const r of await sweepOnce(deps)) {
        if (r.discovered || r.read || r.assessed || r.failed || r.filed) {
          console.log(`petopia-sweep: household ${r.workspace_id}: found ${r.discovered}, read ${r.read}, assessed ${r.assessed}, waiting for a go-ahead ${r.waiting}, failed ${r.failed}, filed ${r.filed}`);
        }
      }
    } catch (e) {
      console.error('petopia-sweep: failed', e instanceof Error ? e.name : 'error');
    } finally {
      running = false;
    }
  };
  const t = setInterval(() => void tick(), seconds * 1000);
  t.unref();
  setTimeout(() => void tick(), 5000).unref();
  return t;
}
