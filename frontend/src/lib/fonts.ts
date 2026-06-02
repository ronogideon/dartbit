// Selectable font styles for tenant branding. Each maps to a web-safe / system font stack so
// no external font loading is required. The key is stored on the tenant (fontFamily); the stack
// is applied at the app root via a CSS variable.
export interface FontOption { key: string; label: string; stack: string }

export const FONT_OPTIONS: FontOption[] = [
  { key: 'default', label: 'Default (System)', stack: '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif' },
  { key: 'inter', label: 'Inter / Modern', stack: 'Inter,"Segoe UI",Roboto,sans-serif' },
  { key: 'rounded', label: 'Rounded', stack: '"Nunito","Quicksand","Segoe UI",sans-serif' },
  { key: 'serif', label: 'Serif / Classic', stack: 'Georgia,"Times New Roman",serif' },
  { key: 'mono', label: 'Monospace / Technical', stack: '"SF Mono",ui-monospace,"Cascadia Code","Courier New",monospace' },
  { key: 'condensed', label: 'Condensed', stack: '"Arial Narrow","Roboto Condensed",sans-serif' },
];

export function fontStack(key: string | null | undefined): string {
  const f = FONT_OPTIONS.find(o => o.key === key);
  return (f || FONT_OPTIONS[0]).stack;
}
