import { ChevronLeft } from 'lucide-react';

export function TopBar({ title, back = '#/' }: { title: string; back?: string }) {
  return (
    <div className="sticky top-0 z-20 border-b border-line bg-[color-mix(in_srgb,var(--bg)_88%,transparent)] backdrop-blur" style={{ paddingTop: 'env(safe-area-inset-top)' }}>
      <div className="mx-auto flex h-14 max-w-3xl items-center gap-2 px-2 sm:px-4">
        <a href={back} aria-label="Back" className="inline-flex h-11 w-11 items-center justify-center rounded-full text-ink no-underline hover:bg-surface-2">
          <ChevronLeft aria-hidden className="h-6 w-6" strokeWidth={1.75} />
        </a>
        <h1 className="m-0 truncate text-[17px] font-semibold">{title}</h1>
      </div>
    </div>
  );
}
