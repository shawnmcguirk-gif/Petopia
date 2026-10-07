// Small shared pieces for the animal tabs (S3/S4), in the shell's visual language: section labels in small caps,
// rounded surface cards, gold primary buttons, moss for "on track". Nothing here invents content.
import { Plus, X } from 'lucide-react';
import { useId, type ReactNode } from 'react';
import type { Badge } from './api';

export function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="mt-8">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 id={id} className="m-0 text-[13px] font-semibold uppercase tracking-[.08em] text-ink-2">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

export const Card = ({ children, className = '' }: { children: ReactNode; className?: string }) => (
  <div className={`rounded-2xl border border-line bg-surface ${className}`}>{children}</div>
);

/** The sec 4.1 source badge. Waiting / read-from-document get amber; everything confirmed is quiet. */
export function BadgeChip({ badge }: { badge: Badge }) {
  const tone = badge.code === 'WAITING' || badge.code === 'READ_FROM_DOCUMENT' ? 'text-amber bg-gold-soft'
    : badge.code === 'AI_SUGGESTION' ? 'text-ink-2 bg-surface-2 border border-dashed border-line-strong'
    : badge.code === 'OUR_NOTE' ? 'text-moss bg-moss-soft' : 'text-gold bg-gold-soft';
  return <span className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[12px] font-semibold ${tone}`}>{badge.text}</span>;
}

export function AddButton({ label, onClick }: { label: string; onClick: () => void }) {
  return <button type="button" className="btn min-h-10 px-3 text-[14px]" onClick={onClick}><Plus aria-hidden className="h-4 w-4" strokeWidth={2} />{label}</button>;
}

/** A form panel that slides in under its section. */
export function Panel({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <Card className="mb-4 p-4 sm:p-5">
      <div className="mb-3 flex items-center justify-between">
        <h4 className="m-0 text-[17px] font-semibold">{title}</h4>
        <button type="button" aria-label="Close" className="inline-flex h-10 w-10 items-center justify-center rounded-full border-0 bg-transparent text-ink-2 hover:bg-surface-2" onClick={onClose}>
          <X aria-hidden className="h-5 w-5" strokeWidth={1.75} />
        </button>
      </div>
      {children}
    </Card>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[14px] font-medium">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[13px] text-ink-2">{hint}</span>}
    </label>
  );
}

export const ErrorText = ({ text }: { text: string | null }) => (text ? <p role="alert" className="m-0 mt-3 text-[15px] text-red">{text}</p> : null);
