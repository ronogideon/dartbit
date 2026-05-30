// Speed unit conversion + validity preset list, shared by the package form and displays.

export type SpeedUnit = 'Kbps' | 'Mbps' | 'Gbps';

// Convert a value+unit to Kbps (what the backend stores).
export function toKbps(value: number, unit: SpeedUnit): number {
  if (unit === 'Gbps') return Math.round(value * 1024 * 1024);
  if (unit === 'Mbps') return Math.round(value * 1024);
  return Math.round(value);
}

// Pick the most natural unit for a stored Kbps value, for editing.
export function fromKbps(kbps: number): { value: number; unit: SpeedUnit } {
  if (kbps >= 1024 * 1024 && kbps % (1024 * 1024) === 0) return { value: kbps / (1024 * 1024), unit: 'Gbps' };
  if (kbps >= 1024 && kbps % 1024 === 0) return { value: kbps / 1024, unit: 'Mbps' };
  if (kbps >= 1024) return { value: Math.round((kbps / 1024) * 10) / 10, unit: 'Mbps' };
  return { value: kbps, unit: 'Kbps' };
}

// Human-readable speed for tables.
export function formatSpeed(kbps: number): string {
  if (kbps >= 1024 * 1024) return `${(kbps / (1024 * 1024)).toFixed(kbps % (1024 * 1024) === 0 ? 0 : 1)} Gbps`;
  if (kbps >= 1024) return `${(kbps / 1024).toFixed(kbps % 1024 === 0 ? 0 : 1)} Mbps`;
  return `${kbps} Kbps`;
}

// Validity presets (label → minutes), in the order requested.
export const VALIDITY_OPTIONS: { label: string; minutes: number }[] = [
  { label: '5 min', minutes: 5 },
  { label: '10 min', minutes: 10 },
  { label: '15 min', minutes: 15 },
  { label: '20 min', minutes: 20 },
  { label: '30 min', minutes: 30 },
  { label: '45 min', minutes: 45 },
  { label: '1 hour', minutes: 60 },
  { label: '1 hour 30 min', minutes: 90 },
  { label: '2 hours', minutes: 120 },
  { label: '2 hours 30 min', minutes: 150 },
  { label: '3 hours', minutes: 180 },
  { label: '3 hours 30 min', minutes: 210 },
  { label: '4 hours', minutes: 240 },
  { label: '5 hours', minutes: 300 },
  { label: '6 hours', minutes: 360 },
  { label: '7 hours', minutes: 420 },
  { label: '8 hours', minutes: 480 },
  { label: '9 hours', minutes: 540 },
  { label: '10 hours', minutes: 600 },
  { label: '12 hours', minutes: 720 },
  { label: '15 hours', minutes: 900 },
  { label: '18 hours', minutes: 1080 },
  { label: '24 hours', minutes: 1440 },
  { label: '1 day', minutes: 1440 },
  { label: '2 days', minutes: 2880 },
  { label: '3 days', minutes: 4320 },
  { label: '4 days', minutes: 5760 },
  { label: '5 days', minutes: 7200 },
  { label: '6 days', minutes: 8640 },
  { label: '7 days', minutes: 10080 },
  { label: '1 week', minutes: 10080 },
  { label: '14 days', minutes: 20160 },
  { label: '2 weeks', minutes: 20160 },
  { label: '30 days', minutes: 43200 },
  { label: '1 Month', minutes: 43200 },
  { label: '2 months', minutes: 86400 },
  { label: '3 months', minutes: 129600 },
  { label: '4 months', minutes: 172800 },
  { label: '5 months', minutes: 216000 },
  { label: '6 months', minutes: 259200 },
  { label: '7 months', minutes: 302400 },
  { label: '8 months', minutes: 345600 },
  { label: '9 months', minutes: 388800 },
  { label: '10 months', minutes: 432000 },
  { label: '11 months', minutes: 475200 },
  { label: '12 months', minutes: 518400 },
  { label: '1 year', minutes: 525600 },
];

// Human-readable validity for tables. Prefers an exact preset label, else derives one.
export function formatValidity(mins: number): string {
  const exact = VALIDITY_OPTIONS.find(o => o.minutes === mins);
  if (exact) return exact.label;
  if (mins < 60) return `${mins} min`;
  if (mins < 1440) return `${Math.round((mins / 60) * 10) / 10} hr`;
  if (mins < 43200) return `${Math.round((mins / 1440) * 10) / 10} days`;
  return `${Math.round((mins / 43200) * 10) / 10} months`;
}
