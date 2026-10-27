/**
 * The design playground's settings: one schema that gives every control its range, its default,
 * its validation on import, and the CSS custom property or data attribute it drives on the
 * preview root. Nothing here reaches production pages; the variables only exist under
 * `[data-pg-preview]`.
 */

type ColorSpec = { kind: 'color'; default: string };
type NumberSpec = {
  kind: 'number';
  default: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
};
type EnumSpec<T extends string = string> = { kind: 'enum'; default: T; options: readonly T[] };
type BoolSpec = { kind: 'bool'; default: boolean };
type TextSpec = { kind: 'text'; default: string; maxLength: number };
export type Spec = ColorSpec | NumberSpec | EnumSpec | BoolSpec | TextSpec;

const color = (d: string): ColorSpec => ({ kind: 'color', default: d });
const num = (d: number, min: number, max: number, step: number, unit?: string): NumberSpec => ({
  kind: 'number',
  default: d,
  min,
  max,
  step,
  unit,
});
const pick = <T extends string>(d: T, options: readonly T[]): EnumSpec<T> => ({
  kind: 'enum',
  default: d,
  options,
});
const bool = (d: boolean): BoolSpec => ({ kind: 'bool', default: d });

export const SCHEMA = {
  appearance: {
    page: color('#ffffff'),
    surface: color('#f4f4f1'),
    sidebar: color('#fafaf8'),
    card: color('#ffffff'),
    accent: color('#111111'),
    text: color('#0f0f0f'),
    muted: color('#62625c'),
    border: color('#e2e2dc'),
  },
  typography: {
    family: pick('inter', ['inter', 'jakarta', 'plex', 'system'] as const),
    display: pick('jakarta', ['jakarta', 'inter', 'plex', 'system'] as const),
    voice: pick('mono', ['mono', 'sans', 'muted'] as const),
    baseSize: num(14, 12, 18, 0.5, 'px'),
    headingScale: num(1.25, 1.1, 1.5, 0.01),
    bodySize: num(16, 13, 20, 0.5, 'px'),
    headingWeight: pick('600', ['500', '600'] as const),
    bodyWeight: pick('400', ['400', '500'] as const),
    lineHeight: num(1.55, 1.3, 1.85, 0.05),
    tracking: num(-0.025, -0.04, 0.02, 0.005, 'em'),
  },
  layout: {
    contentWidth: num(1240, 880, 1600, 20, 'px'),
    sidebarWidth: num(232, 196, 300, 4, 'px'),
    rightWidth: num(340, 280, 440, 10, 'px'),
    pagePadding: num(32, 12, 72, 2, 'px'),
    sectionSpacing: num(112, 48, 200, 4, 'px'),
    gap: num(20, 8, 40, 2, 'px'),
    density: pick('comfortable', ['compact', 'comfortable', 'spacious'] as const),
    showSidebar: bool(true),
    showRight: bool(true),
  },
  components: {
    radius: num(4, 0, 22, 1, 'px'),
    borderWidth: num(1, 0, 3, 0.5, 'px'),
    shadow: num(0, 0, 100, 5, '%'),
    cardStyle: pick('outline', ['outline', 'filled', 'elevated'] as const),
    buttonSize: pick('md', ['sm', 'md', 'lg'] as const),
    inputStyle: pick('outline', ['outline', 'filled', 'underline'] as const),
    tableDensity: pick('regular', ['compact', 'regular', 'relaxed'] as const),
  },
  brand: {
    logoVariant: pick('lockup', ['lockup', 'wordmark', 'mark', 'icon'] as const),
    logoSize: num(24, 16, 44, 1, 'px'),
    logoAnimation: pick('draw', ['none', 'draw', 'rise', 'wipe'] as const),
    logoLoop: bool(true),
    logoEvery: num(6, 3, 15, 1, 's'),
    motionSpeed: num(1, 0.5, 2, 0.1, '×'),
    intensity: num(60, 0, 100, 5, '%'),
    dotDensity: num(90, 30, 100, 5, '%'),
    transition: num(180, 0, 600, 20, 'ms'),
    hover: bool(true),
  },
  tweaks: {
    heroMeasure: num(18, 10, 26, 0.5, 'ch'),
    heroAlign: pick('left', ['left', 'center'] as const),
    showFigures: bool(true),
    showFlow: bool(true),
    showSpecs: bool(true),
    showClosing: bool(true),
    ctaPlacement: pick('both', ['hero', 'both', 'closing'] as const),
    cardGap: num(0, 0, 32, 2, 'px'),
    buttonPadX: num(18, 10, 36, 1, 'px'),
    buttonMinWidth: num(0, 0, 220, 10, 'px'),
    iconSize: num(18, 12, 26, 1, 'px'),
    navGap: num(28, 8, 56, 2, 'px'),
    panelAlign: pick('start', ['start', 'stretch'] as const),
    particles: bool(true),
    terminal: bool(false),
    gridLines: bool(true),
    sectionLabels: bool(false),
    dotWordmark: bool(true),
    artPanel: bool(true),
    loginState: pick('live', ['live', 'error', 'notice', 'loading'] as const),
  },
  custom: {
    enabled: bool(false),
    css: { kind: 'text', default: '', maxLength: 20000 } as TextSpec,
  },
} as const satisfies Record<string, Record<string, Spec>>;

type ValueOf<S> = S extends ColorSpec
  ? string
  : S extends NumberSpec
    ? number
    : S extends EnumSpec<infer T>
      ? T
      : S extends BoolSpec
        ? boolean
        : string;

export type Settings = {
  [G in keyof typeof SCHEMA]: { [K in keyof (typeof SCHEMA)[G]]: ValueOf<(typeof SCHEMA)[G][K]> };
};
export type Group = keyof Settings;

export const SETTINGS_VERSION = 1;
export const STORAGE_KEY = 'specfix.design-playground.v1';

function defaultsOf(): Settings {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [g, fields] of Object.entries(SCHEMA)) {
    out[g] = {};
    for (const [k, spec] of Object.entries(fields)) out[g]![k] = (spec as Spec).default;
  }
  return out as Settings;
}

export const DEFAULTS: Settings = defaultsOf();

const HEX = /^#[0-9a-f]{6}$/i;

/** One value against its spec: the value when valid (numbers clamped to range), else undefined. */
function check(spec: Spec, value: unknown): unknown {
  switch (spec.kind) {
    case 'color':
      return typeof value === 'string' && HEX.test(value) ? value.toLowerCase() : undefined;
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
      return Math.min(spec.max, Math.max(spec.min, value));
    }
    case 'enum':
      return typeof value === 'string' && spec.options.includes(value) ? value : undefined;
    case 'bool':
      return typeof value === 'boolean' ? value : undefined;
    case 'text':
      return typeof value === 'string' && value.length <= spec.maxLength ? value : undefined;
  }
}

/**
 * Merge untrusted input (localStorage, an imported file) onto a base. Unknown keys are ignored,
 * invalid values keep the base value, and every rejected field is named so the import can say so.
 */
export function sanitize(
  input: unknown,
  base: Settings = DEFAULTS
): { settings: Settings; rejected: string[] } {
  const rejected: string[] = [];
  const source = (
    input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  ) as Record<string, unknown>;
  const out = structuredClone(base) as Record<string, Record<string, unknown>>;
  for (const [g, fields] of Object.entries(SCHEMA)) {
    const group = source[g];
    if (group === undefined) continue;
    if (!group || typeof group !== 'object') {
      rejected.push(g);
      continue;
    }
    for (const [k, spec] of Object.entries(fields)) {
      if (!(k in group)) continue;
      const valid = check(spec as Spec, (group as Record<string, unknown>)[k]);
      if (valid === undefined) rejected.push(`${g}.${k}`);
      else out[g]![k] = valid;
    }
  }
  return { settings: out as Settings, rejected };
}

/** Parse an exported file. Throws with a message fit to show when it is not one. */
export function parseExport(text: string): { settings: Settings; rejected: string[] } {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('That file is not valid JSON.');
  }
  if (!data || typeof data !== 'object') throw new Error('Expected a settings object.');
  const record = data as Record<string, unknown>;
  if (record.kind !== 'specfix-design-settings') {
    throw new Error('This is not a SpecFix design settings file.');
  }
  if (typeof record.version !== 'number' || record.version > SETTINGS_VERSION) {
    throw new Error('These settings come from a newer playground version.');
  }
  return sanitize(record.settings);
}

export function toExport(settings: Settings): string {
  return JSON.stringify(
    {
      kind: 'specfix-design-settings',
      version: SETTINGS_VERSION,
      exportedAt: new Date().toISOString(),
      settings,
    },
    null,
    2
  );
}

type Partialish = { [G in Group]?: Partial<Settings[G]> };
const preset = (label: string, note: string, patch: Partialish) => ({ label, note, patch });

/** Starting points. Each applies on top of the defaults, so switching presets never stacks. */
export const PRESETS = {
  editorial: preset(
    'Editorial',
    'The reference video: white ground, ink, hairlines, square corners.',
    {}
  ),
  workspace: preset(
    'Soft workspace',
    'The dashboard screenshots: rounded, raised panels, a cool accent.',
    {
      appearance: {
        page: '#f3f4f6',
        surface: '#f7f7f8',
        sidebar: '#ffffff',
        card: '#ffffff',
        accent: '#2b5fd9',
        text: '#16181d',
        muted: '#5d6371',
        border: '#e3e5ea',
      },
      typography: { display: 'inter', voice: 'muted' },
      components: { radius: 14, shadow: 35, cardStyle: 'elevated', inputStyle: 'filled' },
      tweaks: { gridLines: false, cardGap: 16 },
    }
  ),
  compact: preset('Compact review', 'Dense type and rows for long queues.', {
    typography: { baseSize: 13, bodySize: 14, lineHeight: 1.45 },
    layout: { density: 'compact', gap: 12, pagePadding: 20, sectionSpacing: 72, sidebarWidth: 208 },
    components: { radius: 3, buttonSize: 'sm', tableDensity: 'compact' },
  }),
  paper: preset('Warm paper', 'A cream ground and warm ink, closer to the logo sheet.', {
    appearance: {
      page: '#f6f2ea',
      surface: '#efe9dd',
      sidebar: '#f3eee4',
      card: '#fbf8f2',
      accent: '#1c1a16',
      text: '#1c1a16',
      muted: '#625a4c',
      border: '#ded6c6',
    },
    components: { radius: 8, cardStyle: 'filled' },
  }),
} as const;
export type PresetId = keyof typeof PRESETS;

export function applyPreset(id: PresetId): Settings {
  return sanitize(PRESETS[id].patch).settings;
}

function channels(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`;
}

function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
}

/** WCAG contrast ratio between two hex colours. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const FONTS = {
  inter: 'var(--font-inter), system-ui, sans-serif',
  jakarta: 'var(--font-display), system-ui, sans-serif',
  plex: 'var(--font-mono), ui-monospace, monospace',
  system: 'system-ui, -apple-system, "Segoe UI", sans-serif',
} as const;

const DENSITY = { compact: 0.78, comfortable: 1, spacious: 1.22 } as const;
const BUTTON = { sm: [32, 13], md: [40, 14], lg: [48, 15] } as const;
const ROW = { compact: 36, regular: 48, relaxed: 60 } as const;

/** The custom properties for the preview root. */
export function cssVars(s: Settings): Record<string, string> {
  const a = s.appearance;
  const t = s.typography;
  const l = s.layout;
  const c = s.components;
  const b = s.brand;
  const q = s.tweaks;
  const [btnH, btnFont] = BUTTON[c.buttonSize];
  const voice = t.voice === 'mono' ? FONTS.plex : FONTS[t.display];
  return {
    '--pg-page': a.page,
    '--pg-surface': a.surface,
    '--pg-sidebar': a.sidebar,
    '--pg-card': a.card,
    '--pg-accent': a.accent,
    '--pg-on-accent':
      contrast(a.accent, '#ffffff') >= contrast(a.accent, '#111111') ? '#ffffff' : '#111111',
    '--pg-text': a.text,
    '--pg-muted': a.muted,
    '--pg-border': a.border,
    '--pg-font': FONTS[t.family],
    '--pg-display': FONTS[t.display],
    '--pg-voice': voice,
    '--pg-voice-color': t.voice === 'sans' ? a.text : a.muted,
    '--pg-base': `${t.baseSize}px`,
    '--pg-scale': String(t.headingScale),
    '--pg-body': `${t.bodySize}px`,
    '--pg-hw': t.headingWeight,
    '--pg-bw': t.bodyWeight,
    '--pg-lh': String(t.lineHeight),
    '--pg-track': `${t.tracking}em`,
    '--pg-content': `${l.contentWidth}px`,
    '--pg-sidebar-w': `${l.sidebarWidth}px`,
    '--pg-right-w': `${l.rightWidth}px`,
    '--pg-pad': `${l.pagePadding}px`,
    '--pg-section': `${l.sectionSpacing}px`,
    '--pg-gap': `${l.gap}px`,
    '--pg-density': String(DENSITY[l.density]),
    '--pg-radius': `${c.radius}px`,
    '--pg-line': `${c.borderWidth}px`,
    '--pg-shadow': String(c.shadow / 100),
    '--pg-btn-h': `${btnH}px`,
    '--pg-btn-font': `${btnFont}px`,
    '--pg-row': `${ROW[c.tableDensity]}px`,
    '--pg-logo': `${b.logoSize}px`,
    '--pg-logo-every': `${b.logoEvery}s`,
    '--pg-speed': String(b.motionSpeed),
    '--pg-intensity': String(b.intensity / 100),
    '--pg-transition': `${b.transition}ms`,
    '--pg-hero-measure': `${q.heroMeasure}ch`,
    '--pg-card-gap': `${q.cardGap}px`,
    '--pg-btn-px': `${q.buttonPadX}px`,
    '--pg-btn-min': `${q.buttonMinWidth}px`,
    '--pg-icon': `${q.iconSize}px`,
    '--pg-nav-gap': `${q.navGap}px`,
    // The app's own RGB-channel tokens, remapped so real components (the agent transcript)
    // render in the playground's light theme rather than the graphite workspace.
    '--frame': channels(a.page),
    '--sheet': channels(a.card),
    '--raised': channels(a.surface),
    '--active': channels(a.surface),
    '--border': channels(a.border),
    '--rule': channels(a.border),
    '--control': channels(a.border),
    '--field': channels(a.muted),
    '--text': channels(a.text),
    '--muted': channels(a.muted),
    '--primary': channels(a.accent),
    '--accent': channels(a.accent),
    '--accent-ink': channels(a.text),
    '--accent-tag': channels(a.surface),
    '--mark': '252 238 196',
    '--mark-selected': '247 220 150',
    '--positive': '46 125 80',
    '--positive-bg': '228 242 233',
    '--positive-ink': '30 98 60',
    '--negative': '186 52 40',
    '--negative-bg': '251 233 230',
    '--negative-ink': '160 40 30',
    '--warning': '163 106 0',
    '--warning-bg': '252 242 220',
    '--warning-ink': '128 82 0',
    '--warning-line': '232 204 150',
    '--neutral-bg': '238 238 234',
    '--neutral-ink': '68 68 63',
  };
}

/** Data attributes for choices that switch whole rule sets rather than a single value. */
export function dataAttrs(s: Settings): Record<string, string> {
  return {
    'data-card': s.components.cardStyle,
    'data-input': s.components.inputStyle,
    'data-density': s.layout.density,
    'data-hover': s.brand.hover ? 'on' : 'off',
    'data-hero-align': s.tweaks.heroAlign,
    'data-panel-align': s.tweaks.panelAlign,
    'data-grid': s.tweaks.gridLines ? 'on' : 'off',
    'data-labels': s.tweaks.sectionLabels ? 'on' : 'off',
    'data-logo-loop': s.brand.logoLoop ? 'on' : 'off',
  };
}
