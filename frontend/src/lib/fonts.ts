// Selectable font styles for tenant branding — 15 popular Google Fonts. Each maps to a family
// name + a CSS stack. The fonts are loaded via a Google Fonts <link> (see FontLoader) so the
// chosen family renders everywhere. The key is stored on the tenant (fontFamily).
export interface FontOption { key: string; label: string; family: string; stack: string }

const sans = ',system-ui,-apple-system,"Segoe UI",Roboto,sans-serif';
const serif = ',Georgia,"Times New Roman",serif';

export const FONT_OPTIONS: FontOption[] = [
  { key: 'default',     label: 'Default (System)', family: '',                stack: `system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif` },
  { key: 'inter',       label: 'Inter',            family: 'Inter',           stack: `"Inter"${sans}` },
  { key: 'roboto',      label: 'Roboto',           family: 'Roboto',          stack: `"Roboto"${sans}` },
  { key: 'open-sans',   label: 'Open Sans',        family: 'Open Sans',       stack: `"Open Sans"${sans}` },
  { key: 'montserrat',  label: 'Montserrat',       family: 'Montserrat',      stack: `"Montserrat"${sans}` },
  { key: 'nunito',      label: 'Nunito',           family: 'Nunito',          stack: `"Nunito"${sans}` },
  { key: 'noto-sans',   label: 'Noto Sans',        family: 'Noto Sans',       stack: `"Noto Sans"${sans}` },
  { key: 'poppins',     label: 'Poppins',          family: 'Poppins',         stack: `"Poppins"${sans}` },
  { key: 'lato',        label: 'Lato',             family: 'Lato',            stack: `"Lato"${sans}` },
  { key: 'raleway',     label: 'Raleway',          family: 'Raleway',         stack: `"Raleway"${sans}` },
  { key: 'work-sans',   label: 'Work Sans',        family: 'Work Sans',       stack: `"Work Sans"${sans}` },
  { key: 'dm-sans',     label: 'DM Sans',          family: 'DM Sans',         stack: `"DM Sans"${sans}` },
  { key: 'rubik',       label: 'Rubik',            family: 'Rubik',           stack: `"Rubik"${sans}` },
  { key: 'merriweather',label: 'Merriweather',     family: 'Merriweather',    stack: `"Merriweather"${serif}` },
  { key: 'playfair',    label: 'Playfair Display', family: 'Playfair Display',stack: `"Playfair Display"${serif}` },
];

export function fontStack(key: string | null | undefined): string {
  const f = FONT_OPTIONS.find(o => o.key === key);
  return (f || FONT_OPTIONS[0]).stack;
}

// The Google Fonts families to request (skips 'default' which uses the system font).
export function googleFontsHref(): string {
  const families = FONT_OPTIONS
    .filter(f => f.family)
    .map(f => `family=${f.family.replace(/ /g, '+')}:wght@400;500;600;700`)
    .join('&');
  return `https://fonts.googleapis.com/css2?${families}&display=swap`;
}
