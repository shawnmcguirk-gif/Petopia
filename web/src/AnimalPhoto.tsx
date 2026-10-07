// An animal's photo, or -- when there is none yet -- the first letter of the name on a quiet moss ground.
// No cartoon paw prints anywhere (spec sec 9.1).
import { useEffect, useState } from 'react';
import { photoUrl } from './api';

export function AnimalPhoto({ path, name, className = '', rounded = 'rounded-2xl' }: { path: string | null; name: string; className?: string; rounded?: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setSrc(null);
    if (path) photoUrl(path).then((u) => { if (live) setSrc(u); }, () => undefined);
    return () => { live = false; };
  }, [path]);
  if (path && src) return <img src={src} alt={`Photo of ${name}`} className={`object-cover ${rounded} ${className}`} />;
  return (
    <div
      role="img"
      aria-label={path ? `Loading photo of ${name}` : `No photo of ${name} yet`}
      className={`flex items-center justify-center ${rounded} ${className}`}
      style={{ background: 'radial-gradient(120% 90% at 30% 20%, var(--moss-soft), transparent 60%), linear-gradient(160deg, var(--surface-2), var(--bg-2))' }}
    >
      <span className="name text-5xl text-ink-2 opacity-70">{name.slice(0, 1).toUpperCase()}</span>
    </div>
  );
}
