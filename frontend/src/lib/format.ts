// Shared display formatters.

// Rounds a future expiry to a friendly relative estimate: "in 45 min", "in 3 hours",
// "in 2 days", "in 3 weeks", "in 5 months", "in 1 year". Returns "Expired" for past dates
// and "No expiry" when null.
export function formatExpiryRelative(expiresAt: string | null | undefined): string {
  if (!expiresAt) return 'No expiry';
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (ms <= 0) return 'Expired';

  const mins = ms / 60000;
  const hours = mins / 60;
  const days = hours / 24;
  const weeks = days / 7;
  const months = days / 30;
  const years = days / 365;

  const round = (n: number) => Math.max(1, Math.round(n));
  let unit: string, val: number;
  if (mins < 60) { val = round(mins); unit = 'min'; }
  else if (hours < 24) { val = round(hours); unit = 'hour'; }
  else if (days < 14) { val = round(days); unit = 'day'; }
  else if (weeks < 8) { val = round(weeks); unit = 'week'; }
  else if (months < 12) { val = round(months); unit = 'month'; }
  else { val = round(years); unit = 'year'; }

  const plural = val === 1 ? unit : `${unit}s`;
  return `in ${val} ${plural}`;
}

// Tiered expiry for colored status pills:
//  - 'none'    → no expiry set (render a dash)
//  - 'expired' → past expiry (red)
//  - 'soon'    → <= 5 days left (orange)
//  - 'ok'      → > 5 days left (green)
export type ExpiryTier = 'none' | 'expired' | 'soon' | 'ok';
export function expiryInfo(expiresAt: string | null | undefined): { tier: ExpiryTier; text: string } {
  if (!expiresAt) return { tier: 'none', text: '—' };
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (ms <= 0) return { tier: 'expired', text: 'Expired' };
  const days = ms / 86400000;
  const tier: ExpiryTier = days > 5 ? 'ok' : 'soon';
  return { tier, text: formatExpiryRelative(expiresAt) };
}

// Human-readable bytes (e.g. 1.5 GB).
export function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const val = bytes / Math.pow(1024, i);
  return `${val.toFixed(val >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}
