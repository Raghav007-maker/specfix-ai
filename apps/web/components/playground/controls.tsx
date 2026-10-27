'use client';

import { createContext, useContext, useId, useRef, useState, type ReactNode } from 'react';
import { Download, RotateCcw, Upload, X, Copy, Play } from 'lucide-react';
import {
  SCHEMA,
  PRESETS,
  contrast,
  type Group,
  type PresetId,
  type Settings,
  type Spec,
} from './settings';
import type { ScopedCss } from './scope-css';
import s from './controls.module.css';

export type PreviewId = 'landing' | 'login' | 'dashboard';

type Update = <G extends Group, K extends keyof Settings[G]>(
  group: G,
  key: K,
  value: Settings[G][K]
) => void;

/** Human labels for enum options; anything missing falls back to the option itself, capitalised. */
const OPTION_LABELS: Record<string, string> = {
  inter: 'Inter',
  jakarta: 'Plus Jakarta Sans',
  plex: 'IBM Plex Mono',
  system: 'System UI',
  mono: 'Mono, muted',
  sans: 'Same as heading',
  muted: 'Heading face, muted',
  lockup: 'Mark + wordmark',
  wordmark: 'Wordmark only',
  mark: 'SF mark only',
  icon: 'App icon + wordmark',
  none: 'None',
  draw: 'Draw on',
  rise: 'Rise in',
  wipe: 'Wipe in',
  both: 'Hero and closing',
  hero: 'Hero only',
  closing: 'Closing only',
  start: 'Top',
  stretch: 'Fill height',
  live: 'Live form',
  error: 'Error message',
  notice: 'Notice message',
  loading: 'Loading',
  sm: 'Small',
  md: 'Medium',
  lg: 'Large',
};
const label = (o: string) => OPTION_LABELS[o] ?? o[0]!.toUpperCase() + o.slice(1);

const Ctx = createContext<{ settings: Settings; update: Update } | null>(null);

function Field<G extends Group>({
  group,
  k,
  children,
  hint,
}: {
  group: G;
  k: keyof Settings[G] & string;
  children: ReactNode;
  hint?: ReactNode;
}) {
  const { settings, update } = useContext(Ctx)!;
  const id = useId();
  const spec = (SCHEMA[group] as unknown as Record<string, Spec>)[k]!;
  const value = settings[group][k] as unknown;
  const set = (v: unknown) => update(group, k, v as Settings[G][typeof k]);

  if (spec.kind === 'bool') {
    return (
      <label className={s.toggle} htmlFor={id}>
        <span>{children}</span>
        <input
          id={id}
          type="checkbox"
          role="switch"
          checked={value as boolean}
          onChange={(e) => set(e.target.checked)}
        />
        <i aria-hidden="true" />
      </label>
    );
  }

  return (
    <div className={s.field}>
      <div className={s.fieldTop}>
        <label htmlFor={id}>{children}</label>
        {spec.kind === 'number' ? (
          <output htmlFor={id}>
            {value as number}
            {spec.unit && spec.unit !== '×' ? spec.unit : spec.unit === '×' ? '×' : ''}
          </output>
        ) : null}
      </div>
      {spec.kind === 'number' ? (
        <input
          id={id}
          type="range"
          min={spec.min}
          max={spec.max}
          step={spec.step}
          value={value as number}
          onChange={(e) => set(Number(e.target.value))}
        />
      ) : spec.kind === 'color' ? (
        <div className={s.color}>
          <input
            id={id}
            type="color"
            value={value as string}
            onChange={(e) => set(e.target.value)}
          />
          <HexInput value={value as string} onCommit={set} label={`${children} hex value`} />
        </div>
      ) : spec.kind === 'enum' ? (
        spec.options.length <= 3 ? (
          <div className={s.segment} role="radiogroup" aria-labelledby={`${id}-l`} id={id}>
            <span id={`${id}-l`} className={s.srOnly}>
              {children}
            </span>
            {spec.options.map((o: string) => (
              <button
                key={o}
                type="button"
                role="radio"
                aria-checked={value === o}
                onClick={() => set(o)}
              >
                {label(o)}
              </button>
            ))}
          </div>
        ) : (
          <select id={id} value={value as string} onChange={(e) => set(e.target.value)}>
            {spec.options.map((o: string) => (
              <option key={o} value={o}>
                {label(o)}
              </option>
            ))}
          </select>
        )
      ) : null}
      {hint ? <p className={s.hint}>{hint}</p> : null}
    </div>
  );
}

/** Hex text that commits only a valid #rrggbb, so typing never pushes a broken colour live. */
function HexInput({
  value,
  onCommit,
  label: aria,
}: {
  value: string;
  onCommit: (v: string) => void;
  label: string;
}) {
  const [draft, setDraft] = useState(value);
  const [focused, setFocused] = useState(false);
  const shown = focused ? draft : value;
  const valid = /^#[0-9a-f]{6}$/i.test(shown);
  return (
    <input
      className={s.hex}
      aria-label={aria}
      value={shown}
      spellCheck={false}
      aria-invalid={!valid || undefined}
      onFocus={() => {
        setDraft(value);
        setFocused(true);
      }}
      onBlur={() => setFocused(false)}
      onChange={(e) => {
        const v = e.target.value.trim();
        setDraft(v);
        if (/^#[0-9a-f]{6}$/i.test(v)) onCommit(v.toLowerCase());
      }}
    />
  );
}

function Group({
  title,
  open,
  children,
  note,
}: {
  title: string;
  open?: boolean;
  children: ReactNode;
  note?: ReactNode;
}) {
  return (
    <details className={s.group} open={open}>
      <summary>{title}</summary>
      <div className={s.groupBody}>
        {note ? <p className={s.hint}>{note}</p> : null}
        {children}
      </div>
    </details>
  );
}

function ContrastNote({ settings }: { settings: Settings }) {
  const a = settings.appearance;
  const checks = [
    { name: 'Text on page', ratio: contrast(a.text, a.page), min: 4.5 },
    { name: 'Secondary text on page', ratio: contrast(a.muted, a.page), min: 4.5 },
    { name: 'Secondary text on cards', ratio: contrast(a.muted, a.card), min: 4.5 },
    { name: 'Accent on page', ratio: contrast(a.accent, a.page), min: 3 },
  ];
  const failing = checks.filter((c) => c.ratio < c.min);
  return (
    <p className={failing.length ? s.warn : s.hint} role={failing.length ? 'status' : undefined}>
      {failing.length
        ? `Low contrast: ${failing.map((c) => `${c.name} ${c.ratio.toFixed(1)}:1 (needs ${c.min}:1)`).join('; ')}.`
        : 'Contrast passes WCAG AA for text and accent.'}
    </p>
  );
}

export function DesignControls({
  settings,
  update,
  preview,
  presetId,
  onPreset,
  onReset,
  onExport,
  onCopy,
  onImport,
  onClose,
  onReplay,
  customDraft,
  setCustomDraft,
  onApplyCss,
  cssResult,
  status,
}: {
  settings: Settings;
  update: Update;
  preview: PreviewId;
  presetId: PresetId | 'custom';
  onPreset: (id: PresetId) => void;
  onReset: () => void;
  onExport: () => void;
  onCopy: () => void;
  onImport: (text: string) => void;
  onClose: () => void;
  onReplay: () => void;
  customDraft: string;
  setCustomDraft: (v: string) => void;
  onApplyCss: () => void;
  cssResult: ScopedCss | null;
  status: { text: string; tone: 'ok' | 'error' | 'info' } | null;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [paste, setPaste] = useState('');
  const presetSelect = useId();

  return (
    <Ctx.Provider value={{ settings, update }}>
      <aside className={s.panel} aria-label="Design Controls">
        <div className={s.head}>
          <h2>Design Controls</h2>
          <button
            type="button"
            className={s.icon}
            onClick={onClose}
            aria-label="Close Design Controls"
          >
            <X aria-hidden size={16} />
          </button>
        </div>

        <div className={s.top}>
          <label htmlFor={presetSelect}>Preset</label>
          <select
            id={presetSelect}
            value={presetId}
            onChange={(e) => {
              if (e.target.value !== 'custom') onPreset(e.target.value as PresetId);
            }}
          >
            {presetId === 'custom' ? <option value="custom">Custom</option> : null}
            {(Object.keys(PRESETS) as PresetId[]).map((p) => (
              <option key={p} value={p}>
                {PRESETS[p].label}
              </option>
            ))}
          </select>
          <p className={s.hint}>
            {presetId === 'custom' ? 'Your own adjustments.' : PRESETS[presetId].note}
          </p>
          <div className={s.actions}>
            <button type="button" onClick={onReset}>
              <RotateCcw aria-hidden size={14} /> Reset
            </button>
            <button type="button" onClick={onExport}>
              <Download aria-hidden size={14} /> Export
            </button>
            <button type="button" onClick={onCopy}>
              <Copy aria-hidden size={14} /> Copy JSON
            </button>
            <button type="button" onClick={() => fileRef.current?.click()}>
              <Upload aria-hidden size={14} /> Import
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              className={s.srOnly}
              tabIndex={-1}
              aria-hidden="true"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (!file) return;
                if (file.size > 200_000) return onImport('');
                onImport(await file.text());
              }}
            />
          </div>
          <p className={s.status} role="status" aria-live="polite" data-tone={status?.tone}>
            {status?.text ?? 'Changes save in this browser automatically.'}
          </p>
        </div>

        <div className={s.scroll}>
          <Group title="Appearance" open>
            <p className={s.hint}>One light theme. Colours drive every preview.</p>
            <Field group="appearance" k="page">
              Page background
            </Field>
            <Field group="appearance" k="surface">
              Surface
            </Field>
            <Field group="appearance" k="sidebar">
              Sidebar
            </Field>
            <Field group="appearance" k="card">
              Cards
            </Field>
            <Field group="appearance" k="accent">
              Primary accent
            </Field>
            <Field group="appearance" k="text">
              Primary text
            </Field>
            <Field group="appearance" k="muted">
              Secondary text
            </Field>
            <Field group="appearance" k="border">
              Borders
            </Field>
            <ContrastNote settings={settings} />
          </Group>

          <Group title="Typography">
            <Field group="typography" k="family">
              Interface font
            </Field>
            <Field group="typography" k="display">
              Heading font
            </Field>
            <Field
              group="typography"
              k="voice"
              hint="The second line of each headline, as in the reference."
            >
              Headline second voice
            </Field>
            <Field group="typography" k="baseSize">
              Base size
            </Field>
            <Field group="typography" k="headingScale">
              Heading scale
            </Field>
            <Field group="typography" k="bodySize">
              Body text size
            </Field>
            <Field group="typography" k="headingWeight">
              Heading weight
            </Field>
            <Field group="typography" k="bodyWeight">
              Body weight
            </Field>
            <Field group="typography" k="lineHeight">
              Line height
            </Field>
            <Field group="typography" k="tracking">
              Heading tracking
            </Field>
          </Group>

          <Group title="Layout">
            <Field group="layout" k="contentWidth">
              Content width
            </Field>
            <Field group="layout" k="sidebarWidth">
              Sidebar width
            </Field>
            <Field group="layout" k="rightWidth">
              Right panel width
            </Field>
            <Field group="layout" k="pagePadding">
              Page padding
            </Field>
            <Field group="layout" k="sectionSpacing">
              Section spacing
            </Field>
            <Field group="layout" k="gap">
              Component spacing
            </Field>
            <Field group="layout" k="density">
              Density
            </Field>
            <Field group="layout" k="showSidebar">
              Show sidebar
            </Field>
            <Field group="layout" k="showRight">
              Show right panel
            </Field>
          </Group>

          <Group title="Components">
            <Field group="components" k="radius">
              Corner radius
            </Field>
            <Field group="components" k="borderWidth">
              Border thickness
            </Field>
            <Field group="components" k="shadow">
              Shadow
            </Field>
            <Field group="components" k="cardStyle">
              Cards
            </Field>
            <Field group="components" k="buttonSize">
              Buttons
            </Field>
            <Field group="components" k="inputStyle">
              Inputs
            </Field>
            <Field group="components" k="tableDensity">
              Table rows
            </Field>
          </Group>

          <Group title="Branding and motion">
            <Field group="brand" k="logoVariant">
              Logo
            </Field>
            <Field group="brand" k="logoSize">
              Logo size
            </Field>
            <Field
              group="brand"
              k="logoAnimation"
              hint="Plays on the landing and login previews. Reduced motion shows the still logo."
            >
              Logo reveal
            </Field>
            <Field group="brand" k="logoLoop" hint="Repeats a short signature after the reveal.">
              Repeat logo animation
            </Field>
            <Field group="brand" k="logoEvery">
              Repeat every
            </Field>
            <button type="button" className={s.small} onClick={onReplay}>
              <Play aria-hidden size={13} /> Replay reveal
            </button>
            <Field group="brand" k="motionSpeed">
              Animation speed
            </Field>
            <Field group="brand" k="intensity" hint="How far the dot figure reacts to the cursor.">
              Animation intensity
            </Field>
            <Field group="brand" k="dotDensity" hint="How many dots form the figure.">
              Dot density
            </Field>
            <Field group="brand" k="transition">
              Transition duration
            </Field>
            <Field group="brand" k="hover">
              Hover effects
            </Field>
          </Group>

          <Group
            title="Quick tweaks"
            open
            note={`Fine-tuning for the ${preview === 'landing' ? 'landing page' : preview === 'login' ? 'login page' : 'dashboard'} preview.`}
          >
            {preview === 'landing' ? (
              <>
                <Field group="tweaks" k="heroMeasure">
                  Hero headline width
                </Field>
                <Field group="tweaks" k="heroAlign">
                  Hero alignment
                </Field>
                <Field group="tweaks" k="ctaPlacement">
                  Calls to action
                </Field>
                <Field group="tweaks" k="showFigures">
                  “What it catches” section
                </Field>
                <Field group="tweaks" k="showFlow">
                  “How a review runs” section
                </Field>
                <Field group="tweaks" k="showSpecs">
                  “Specs” section
                </Field>
                <Field group="tweaks" k="showClosing">
                  Closing section
                </Field>
                <Field group="tweaks" k="cardGap">
                  Figure grid spacing
                </Field>
                <Field group="tweaks" k="navGap">
                  Navigation spacing
                </Field>
                <Field group="tweaks" k="particles">
                  Dot figure
                </Field>
                <Field group="tweaks" k="terminal">
                  Review log card
                </Field>
                <Field group="tweaks" k="gridLines">
                  Grid on the review board
                </Field>
                <Field
                  group="tweaks"
                  k="sectionLabels"
                  hint="The reference’s bracketed labels. Off by default: the headings carry the sections."
                >
                  Bracketed section labels
                </Field>
                <Field group="tweaks" k="dotWordmark">
                  Dot-matrix footer wordmark
                </Field>
              </>
            ) : null}
            {preview === 'login' ? (
              <>
                <Field
                  group="tweaks"
                  k="loginState"
                  hint="Shows a state in the preview only. It never submits."
                >
                  Preview state
                </Field>
                <Field group="tweaks" k="artPanel">
                  Brand panel
                </Field>
                <Field group="tweaks" k="particles">
                  Dot figure
                </Field>
              </>
            ) : null}
            {preview === 'dashboard' ? (
              <>
                <Field group="tweaks" k="panelAlign">
                  Right panel alignment
                </Field>
                <Field group="tweaks" k="iconSize">
                  Icon size
                </Field>
                <Field
                  group="tweaks"
                  k="navGap"
                  hint="Space between sidebar items, scaled down for the app."
                >
                  Navigation spacing
                </Field>
                <Field group="tweaks" k="cardGap">
                  Card spacing
                </Field>
              </>
            ) : null}
            <Field group="tweaks" k="buttonPadX">
              Button side padding
            </Field>
            <Field group="tweaks" k="buttonMinWidth">
              Button minimum width
            </Field>
          </Group>

          <Group title="Advanced custom CSS">
            <p className={s.hint}>
              Optional. Rules apply only inside the preview, never to the app or these controls. Use{' '}
              <code>:root</code> for the preview root. To override a control&rsquo;s{' '}
              <code>--pg-*</code> variable, add <code>!important</code>. No scripts run.
            </p>
            <label className={s.toggle}>
              <span>Apply custom CSS</span>
              <input
                type="checkbox"
                role="switch"
                checked={settings.custom.enabled}
                onChange={(e) => update('custom', 'enabled', e.target.checked)}
              />
              <i aria-hidden="true" />
            </label>
            <textarea
              className={s.css}
              aria-label="Custom CSS"
              spellCheck={false}
              rows={8}
              value={customDraft}
              placeholder={
                ':root { --pg-radius: 12px !important; }\nh1 { letter-spacing: -0.04em; }'
              }
              onChange={(e) => setCustomDraft(e.target.value)}
              onKeyDown={(e) => {
                if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') onApplyCss();
              }}
            />
            <div className={s.row}>
              <button type="button" className={s.small} onClick={onApplyCss}>
                Apply CSS
              </button>
              <span className={s.hint}>Ctrl+Enter applies</span>
            </div>
            {cssResult ? (
              <p className={cssResult.dropped ? s.warn : s.hint} role="status">
                {cssResult.applied} {cssResult.applied === 1 ? 'rule' : 'rules'} applied
                {cssResult.dropped
                  ? ` · ${cssResult.dropped} ignored (invalid, or not allowed here: @import, @font-face)`
                  : ''}
                {!settings.custom.enabled && cssResult.applied ? ' · switched off' : ''}
              </p>
            ) : null}
          </Group>

          <Group title="Import from text">
            <textarea
              className={s.css}
              aria-label="Paste exported settings JSON"
              rows={4}
              value={paste}
              onChange={(e) => setPaste(e.target.value)}
              placeholder="Paste exported settings JSON"
            />
            <button
              type="button"
              className={s.small}
              disabled={!paste.trim()}
              onClick={() => {
                onImport(paste);
                setPaste('');
              }}
            >
              Import pasted settings
            </button>
          </Group>
        </div>
      </aside>
    </Ctx.Provider>
  );
}
