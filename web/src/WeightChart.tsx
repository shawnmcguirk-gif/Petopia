// Weight over time (spec sec 9.4 "Weight": chart over 3 months / 1 year / all). Confirmed readings only -- the engine
// sends nothing else. One series, so no legend: the section title names it. Thin 2px moss line, 8px points with a
// surface ring, recessive grid, a readout for the point under the finger / cursor / keyboard focus, and the list of
// readings beneath it is the table view. No reference band: Petopia shows no breed "normal" (sec 10.3).
import { useEffect, useMemo, useRef, useState } from 'react';
import { niceDate } from './format';

export interface Point { on: string; value: number }
const RANGES = [{ key: '3m', label: '3 months', days: 92 }, { key: '1y', label: '1 year', days: 366 }, { key: 'all', label: 'All', days: Infinity }] as const;
const dayNo = (d: string): number => Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10))) / 86_400_000;

export function WeightChart({ points, unit = 'kg', compact = false, today }: { points: Point[]; unit?: string; compact?: boolean; today: string }) {
  const [range, setRange] = useState<(typeof RANGES)[number]['key']>('all');
  const [hover, setHover] = useState<number | null>(null);
  // Draw at the real pixel width, so axis text stays 12px on a phone and on a laptop alike.
  const box = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(600);
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([e]) => { if (e && e.contentRect.width > 0) setW(Math.round(e.contentRect.width)); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const shown = useMemo(() => {
    const days = compact ? Infinity : RANGES.find((r) => r.key === range)!.days;
    return points.filter((p) => dayNo(today) - dayNo(p.on) <= days);
  }, [points, range, compact, today]);

  const H = compact ? 64 : 200;
  const pad = compact ? { l: 4, r: 4, t: 8, b: 8 } : { l: 44, r: 16, t: 16, b: 28 };
  const xs = shown.map((p) => dayNo(p.on));
  const vs = shown.map((p) => p.value);
  const [x0, x1] = [Math.min(...xs), Math.max(...xs)];
  let [y0, y1] = [Math.min(...vs), Math.max(...vs)];
  const spread = Math.max(y1 - y0, Math.max(y1 * 0.05, 0.1));
  y0 = Math.max(0, y0 - spread * 0.25);
  y1 = y1 + spread * 0.25;
  const X = (d: number) => (x1 === x0 ? (pad.l + W - pad.r) / 2 : pad.l + ((d - x0) / (x1 - x0)) * (W - pad.l - pad.r));
  const Y = (v: number) => pad.t + (1 - (v - y0) / (y1 - y0)) * (H - pad.t - pad.b);
  const ticks = [y0 + (y1 - y0) * 0.15, (y0 + y1) / 2, y1 - (y1 - y0) * 0.15];
  const line = shown.map((p, i) => `${i ? 'L' : 'M'}${X(dayNo(p.on)).toFixed(1)},${Y(p.value).toFixed(1)}`).join(' ');
  const h = hover !== null ? shown[hover] : undefined;
  const fmt = (v: number) => String(Math.round(v * 100) / 100);

  return (
    <div ref={box}>
      {!compact && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="seg" role="group" aria-label="Time range">
            {RANGES.map((r) => <button key={r.key} type="button" aria-pressed={range === r.key} onClick={() => { setRange(r.key); setHover(null); }}>{r.label}</button>)}
          </div>
          <p className="m-0 min-h-6 text-[15px] tabular-nums" aria-live="polite">
            {h ? <><strong>{fmt(h.value)} {unit}</strong> <span className="text-ink-2">· {niceDate(h.on)}</span></> : <span className="text-ink-2">{shown.length} reading{shown.length === 1 ? '' : 's'}</span>}
          </p>
        </div>
      )}
      {shown.length === 0 ? (
        <p className="m-0 text-[15px] text-ink-2">No readings in this period.</p>
      ) : (
        <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full" role="img" aria-label={`Weight, ${shown.length} readings, latest ${fmt(vs[vs.length - 1]!)} ${unit}`} onMouseLeave={() => setHover(null)}>
          {!compact && ticks.map((t) => (
            <g key={t}>
              <line x1={pad.l} x2={W - pad.r} y1={Y(t)} y2={Y(t)} stroke="var(--line)" strokeWidth={1} />
              <text x={pad.l - 8} y={Y(t) + 4} textAnchor="end" fontSize={12} fill="var(--text-2)">{fmt(t)}</text>
            </g>
          ))}
          {!compact && (
            <>
              <text x={X(x0)} y={H - 6} fontSize={12} fill="var(--text-2)" textAnchor={shown.length > 1 ? 'start' : 'middle'}>{niceDate(shown[0]!.on)}</text>
              {shown.length > 1 && <text x={X(x1)} y={H - 6} fontSize={12} fill="var(--text-2)" textAnchor="end">{niceDate(shown[shown.length - 1]!.on)}</text>}
            </>
          )}
          {h && !compact && <line x1={X(dayNo(h.on))} x2={X(dayNo(h.on))} y1={pad.t} y2={H - pad.b} stroke="var(--line-strong)" strokeWidth={1} />}
          <path d={line} fill="none" stroke="var(--moss)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
          {shown.map((p, i) => {
            const last = i === shown.length - 1;
            if (compact && !last) return null;
            return (
              <g key={`${p.on}-${i}`}>
                <circle cx={X(dayNo(p.on))} cy={Y(p.value)} r={i === hover ? 6 : 4.5} fill="var(--moss)" stroke="var(--surface)" strokeWidth={2} />
                {!compact && (
                  <circle cx={X(dayNo(p.on))} cy={Y(p.value)} r={16} fill="transparent" tabIndex={0} aria-label={`${fmt(p.value)} ${unit} on ${niceDate(p.on)}`}
                    onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} onClick={() => setHover(i)} onBlur={() => setHover(null)} />
                )}
              </g>
            );
          })}
        </svg>
      )}
    </div>
  );
}
