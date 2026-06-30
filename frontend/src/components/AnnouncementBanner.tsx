'use client';
import { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getAnnouncements } from '@/lib/api';
import { Info, AlertTriangle, AlertOctagon, X } from 'lucide-react';

const STYLES = {
  INFO: { bg: 'bg-blue-50 dark:bg-blue-950/40 border-blue-200 dark:border-blue-900 text-blue-800 dark:text-blue-200', Icon: Info },
  WARNING: { bg: 'bg-amber-50 dark:bg-amber-950/40 border-amber-200 dark:border-amber-900 text-amber-800 dark:text-amber-200', Icon: AlertTriangle },
  CRITICAL: { bg: 'bg-red-50 dark:bg-red-950/40 border-red-200 dark:border-red-900 text-red-800 dark:text-red-200', Icon: AlertOctagon },
} as const;

const KEY = 'dartbit_dismissed_announcements';

export default function AnnouncementBanner() {
  const { data: announcements = [] } = useQuery({
    queryKey: ['announcements'],
    queryFn: getAnnouncements,
    refetchInterval: 5 * 60 * 1000,
    retry: false,
  });
  const [dismissed, setDismissed] = useState<string[]>([]);

  useEffect(() => {
    try { setDismissed(JSON.parse(localStorage.getItem(KEY) || '[]')); } catch { /* ignore */ }
  }, []);

  const dismiss = (id: string) => {
    const next = [...dismissed, id];
    setDismissed(next);
    try { localStorage.setItem(KEY, JSON.stringify(next.slice(-100))); } catch { /* ignore */ }
  };

  const visible = announcements.filter(a => !dismissed.includes(a.id));
  if (visible.length === 0) return null;

  return (
    <div className="space-y-2 mb-4">
      {visible.map(a => {
        const s = STYLES[a.level] || STYLES.INFO;
        const Icon = s.Icon;
        return (
          <div key={a.id} className={`flex items-start gap-3 border rounded-xl px-4 py-3 ${s.bg}`}>
            <Icon size={18} className="shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <div className="font-semibold text-sm">{a.title}</div>
              <div className="text-sm opacity-90 whitespace-pre-wrap">{a.body}</div>
            </div>
            <button onClick={() => dismiss(a.id)} className="shrink-0 opacity-60 hover:opacity-100 transition-opacity" aria-label="Dismiss">
              <X size={16} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
