'use client';
import type { FupStatus } from '@/lib/api';

// Connection/FUP status dot, shared by the Active Users and Subscribers lists so the two pages can
// never render the same state differently.
//
// The status arrives from the API as ONE computed enum rather than separate online/throttled
// booleans — four combinations would leave "offline but throttled" undefined, and the two pages
// would drift. Offline wins visually; the throttle stays in the data and reapplies on reconnect.
//
// Accessibility: green vs yellow is hard to tell apart with red-green colour blindness, and
// off vs green differ only in brightness, so every dot carries a title with the literal status and
// screen-reader text. Colour is never the only signal.
const STYLES: Record<FupStatus, { dot: string; label: string; title: string }> = {
  online: {
    dot: 'bg-green-500',
    label: 'Online',
    title: 'Online — full speed',
  },
  throttled: {
    // Ring makes throttled distinguishable from online by SHAPE, not just hue.
    dot: 'bg-yellow-400 ring-2 ring-yellow-400/40',
    label: 'Throttled',
    title: 'Throttled — FUP data allowance used up',
  },
  offline: {
    dot: 'bg-gray-300 dark:bg-gray-600',
    label: 'Offline',
    title: 'Offline — no active session',
  },
};

export default function StatusDot({
  status,
  showLabel = false,
}: {
  status?: FupStatus | null;
  showLabel?: boolean;
}) {
  const s = STYLES[(status as FupStatus) || 'offline'] || STYLES.offline;
  return (
    <span className="inline-flex items-center gap-1.5" title={s.title}>
      <span className={`inline-block h-2.5 w-2.5 rounded-full shrink-0 ${s.dot}`} aria-hidden="true" />
      {showLabel && <span className="text-xs text-gray-600 dark:text-gray-300">{s.label}</span>}
      <span className="sr-only">{s.title}</span>
    </span>
  );
}
