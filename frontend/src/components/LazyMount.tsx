'use client';
import { useEffect, useRef, useState } from 'react';

// Renders `placeholder` until the wrapper scrolls within `rootMargin` of the viewport, then swaps in
// `children` and stops observing. Used to keep heavy, below-the-fold widgets (e.g. the recharts
// analytics panel) from fetching their chunk or executing during initial page load — the single
// biggest lever on Total Blocking Time for anything that isn't visible on first paint. Degrades
// gracefully to rendering immediately where IntersectionObserver is unavailable.
export default function LazyMount({
  children,
  placeholder = null,
  rootMargin = '200px',
}: {
  children: React.ReactNode;
  placeholder?: React.ReactNode;
  rootMargin?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (show) return;
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === 'undefined') {
      setShow(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setShow(true);
          io.disconnect();
        }
      },
      { rootMargin },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [show, rootMargin]);

  return <div ref={ref}>{show ? children : placeholder}</div>;
}
