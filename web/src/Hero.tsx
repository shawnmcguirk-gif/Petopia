// The Home hero (spec sec 9.2): the landscape image on wider screens, the portrait-derived crop at phone width.
// Both already carry the Petopia wordmark, so no title is laid over them.
export function Hero() {
  return (
    <header className="relative">
      <picture>
        <source media="(max-width: 640px)" srcSet="./petopia-hero-phone.jpg" />
        <source media="(max-width: 1100px)" srcSet="./petopia-hero-1024.jpg" />
        <img src="./petopia-hero.jpg" alt="Petopia — your world of pets and wildlife" className="block aspect-[828/785] w-full object-cover sm:aspect-[1672/941]" fetchPriority="high" />
      </picture>
      <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-24" style={{ background: 'linear-gradient(to bottom, transparent, var(--bg))' }} />
    </header>
  );
}
