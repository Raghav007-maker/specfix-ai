'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { Monitor, Smartphone, SlidersHorizontal, Tablet } from 'lucide-react';
import {
  DEFAULTS,
  PRESETS,
  STORAGE_KEY,
  applyPreset,
  cssVars,
  dataAttrs,
  parseExport,
  sanitize,
  toExport,
  type Group,
  type PresetId,
  type Settings,
} from './settings';
import { scopeCss, type ScopedCss } from './scope-css';
import { DesignControls, type PreviewId } from './controls';
import { LandingPreview } from './landing-preview';
import { LoginPreview, type AuthMode } from './login-preview';
import { DashboardPreview } from './dashboard-preview';
import type { DashboardData } from './dashboard-data';
import { SfMark } from './logo';
import s from './controls.module.css';
import p from './playground.module.css';

const PREVIEWS: { id: PreviewId; label: string }[] = [
  { id: 'landing', label: 'Landing' },
  { id: 'login', label: 'Login' },
  { id: 'dashboard', label: 'Dashboard' },
];

const FRAMES = [
  { id: 'full', label: 'Full width', width: null, icon: Monitor },
  { id: 'tablet', label: 'Tablet, 768px', width: 768, icon: Tablet },
  { id: 'mobile', label: 'Mobile, 375px', width: 375, icon: Smartphone },
] as const;
type FrameId = (typeof FRAMES)[number]['id'];

type Status = { text: string; tone: 'ok' | 'error' | 'info' } | null;

function readStored(): { settings: Settings; preview?: PreviewId; rejected: string[] } | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as { settings?: unknown; preview?: unknown };
    const { settings, rejected } = sanitize(data.settings);
    const preview = PREVIEWS.some((x) => x.id === data.preview)
      ? (data.preview as PreviewId)
      : undefined;
    return { settings, preview, rejected };
  } catch {
    return null;
  }
}

function sameAs(a: Settings, b: Settings): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The design playground: three live previews (landing, login, dashboard) under one set of Design
 * Controls. Every control writes a CSS custom property or data attribute on the preview root, so
 * changes show at once without a reload. Settings persist in this browser, export as JSON and
 * import back with validation. Nothing here changes production pages.
 */
export function Playground({ data, agent }: { data: DashboardData; agent: ReactNode }) {
  const [settings, setSettings] = useState<Settings>(DEFAULTS);
  const [preview, setPreview] = useState<PreviewId>('landing');
  const [mode, setMode] = useState<AuthMode>('sign-in');
  const [frame, setFrame] = useState<FrameId>('full');
  const [open, setOpen] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [status, setStatus] = useState<Status>(null);
  const [replay, setReplay] = useState(0);
  const [customDraft, setCustomDraft] = useState('');
  const [cssResult, setCssResult] = useState<ScopedCss | null>(null);
  const previewRef = useRef<HTMLDivElement>(null);

  // Restore once on mount: storage is browser-only, so the server render uses the defaults.
  useEffect(() => {
    const stored = readStored();
    if (stored) {
      setSettings(stored.settings);
      if (stored.preview) setPreview(stored.preview);
      setCustomDraft(stored.settings.custom.css);
      if (stored.rejected.length) {
        setStatus({
          text: `Restored saved settings; ${stored.rejected.length} invalid value(s) reset to defaults.`,
          tone: 'info',
        });
      }
    }
    if (window.matchMedia('(max-width: 900px)').matches) setOpen(false);
    setLoaded(true);
  }, []);

  // Save after each change once restored, so the defaults never overwrite a saved session.
  useEffect(() => {
    if (!loaded) return;
    const t = setTimeout(() => {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ settings, preview }));
      } catch {
        setStatus({
          text: 'This browser blocked saving; changes last until you reload.',
          tone: 'error',
        });
      }
    }, 250);
    return () => clearTimeout(t);
  }, [settings, preview, loaded]);

  // Status messages clear themselves.
  useEffect(() => {
    if (!status) return;
    const t = setTimeout(() => setStatus(null), 4500);
    return () => clearTimeout(t);
  }, [status]);

  const update = useCallback(
    <G extends Group, K extends keyof Settings[G]>(group: G, key: K, value: Settings[G][K]) => {
      setSettings((prev) => ({ ...prev, [group]: { ...prev[group], [key]: value } }));
    },
    []
  );

  // The custom CSS is re-scoped whenever the applied text changes.
  const scoped = useMemo(() => {
    if (!loaded || !settings.custom.css) return null;
    try {
      return scopeCss(settings.custom.css);
    } catch {
      return { css: '', applied: 0, dropped: 1 };
    }
  }, [settings.custom.css, loaded]);
  useEffect(() => setCssResult(scoped), [scoped]);

  const presetId: PresetId | 'custom' = useMemo(() => {
    const plain = { ...settings, custom: DEFAULTS.custom };
    return (
      (Object.keys(PRESETS) as PresetId[]).find((id) => sameAs(applyPreset(id), plain)) ?? 'custom'
    );
  }, [settings]);

  const applyCss = () => {
    let result: ScopedCss;
    try {
      result = scopeCss(customDraft);
    } catch {
      setStatus({ text: 'That CSS could not be parsed. Nothing was applied.', tone: 'error' });
      return;
    }
    setSettings((prev) => ({
      ...prev,
      custom: { enabled: customDraft.trim() ? true : prev.custom.enabled, css: customDraft },
    }));
    setStatus({
      text: customDraft.trim()
        ? `Custom CSS applied: ${result.applied} rule(s).`
        : 'Custom CSS cleared.',
      tone: result.dropped ? 'info' : 'ok',
    });
  };

  const exportFile = () => {
    const blob = new Blob([toExport(settings)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'specfix-design-settings.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setStatus({ text: 'Exported specfix-design-settings.json.', tone: 'ok' });
  };

  const copyJson = () => {
    navigator.clipboard.writeText(toExport(settings)).then(
      () => setStatus({ text: 'Settings JSON copied to the clipboard.', tone: 'ok' }),
      () =>
        setStatus({ text: 'The browser blocked the clipboard. Use Export instead.', tone: 'error' })
    );
  };

  const importText = (text: string) => {
    if (!text.trim()) {
      setStatus({ text: 'That file is empty or larger than 200 KB.', tone: 'error' });
      return;
    }
    try {
      const { settings: next, rejected } = parseExport(text);
      setSettings(next);
      setCustomDraft(next.custom.css);
      setStatus({
        text: rejected.length
          ? `Imported. ${rejected.length} invalid value(s) kept their defaults: ${rejected.slice(0, 4).join(', ')}${rejected.length > 4 ? '…' : ''}.`
          : 'Settings imported.',
        tone: rejected.length ? 'info' : 'ok',
      });
    } catch (err) {
      setStatus({
        text: err instanceof Error ? err.message : 'Could not import those settings.',
        tone: 'error',
      });
    }
  };

  const reset = () => {
    setSettings(DEFAULTS);
    setCustomDraft('');
    setStatus({ text: 'Reset to the default settings.', tone: 'ok' });
  };

  const choosePreset = (id: PresetId) => {
    setSettings((prev) => ({ ...applyPreset(id), custom: prev.custom }));
    setStatus({ text: `${PRESETS[id].label} preset applied.`, tone: 'ok' });
  };

  const go = (to: PreviewId) => {
    setPreview(to);
    previewRef.current?.scrollTo({ top: 0 });
  };

  const width = FRAMES.find((f) => f.id === frame)!.width;
  const style = { ...cssVars(settings), ...(width ? { maxWidth: width } : null) } as CSSProperties;

  return (
    <div className={s.app} data-open={open ? 'true' : 'false'}>
      <header className={s.bar}>
        <p className={s.brand}>
          <SfMark size={16} />
          <span>
            SpecFix <span className={s.dim}>· Design playground</span>
          </span>
        </p>
        <div className={s.tabs} role="tablist" aria-label="Preview">
          {PREVIEWS.map((x) => (
            <button
              key={x.id}
              role="tab"
              type="button"
              aria-selected={preview === x.id}
              aria-controls="pg-preview"
              onClick={() => go(x.id)}
            >
              {x.label}
            </button>
          ))}
        </div>
        <div className={s.barEnd}>
          <div className={s.frames} role="radiogroup" aria-label="Preview width">
            {FRAMES.map((f) => (
              <button
                key={f.id}
                type="button"
                role="radio"
                aria-checked={frame === f.id}
                aria-label={f.label}
                title={f.label}
                onClick={() => setFrame(f.id)}
              >
                <f.icon aria-hidden size={15} />
              </button>
            ))}
          </div>
          <span
            className={s.source}
            data-source={data.source}
            title={
              data.source === 'live'
                ? 'The dashboard shows your workspace'
                : 'The dashboard shows labelled sample data'
            }
          >
            {data.source === 'live' ? 'Live data' : 'Sample data'}
          </span>
          <button
            type="button"
            className={s.toggleBtn}
            aria-expanded={open}
            aria-controls="pg-controls"
            onClick={() => setOpen((v) => !v)}
          >
            <SlidersHorizontal aria-hidden size={15} /> Design Controls
          </button>
        </div>
      </header>

      <div className={s.body}>
        <div className={s.stageWrap} ref={previewRef} data-pg-scroll="">
          <div
            id="pg-preview"
            role="tabpanel"
            aria-label={`${PREVIEWS.find((x) => x.id === preview)!.label} preview`}
            className={p.root}
            data-pg-preview=""
            data-view={preview}
            data-frame={frame}
            style={style}
            {...dataAttrs(settings)}
          >
            {settings.custom.enabled && scoped?.css ? <style>{scoped.css}</style> : null}
            <div key={`${preview}-${replay}`} className={p.view}>
              {preview === 'landing' ? (
                <LandingPreview
                  settings={settings}
                  go={(_, m) => {
                    setMode(m ?? 'sign-in');
                    go('login');
                  }}
                />
              ) : preview === 'login' ? (
                <LoginPreview
                  settings={settings}
                  mode={mode}
                  setMode={setMode}
                  goHome={() => go('landing')}
                />
              ) : (
                <DashboardPreview
                  settings={settings}
                  data={data}
                  agent={agent}
                  pricing
                  goLogin={() => {
                    setMode('sign-in');
                    go('login');
                  }}
                />
              )}
            </div>
          </div>
          {preview === 'login' ? (
            <p className={s.under}>
              The login preview posts to the real sign-in and sign-up actions. A successful sign-in
              leaves the playground for your queue.
            </p>
          ) : null}
        </div>

        {open ? (
          <div id="pg-controls" className={s.dock}>
            <DesignControls
              settings={settings}
              update={update}
              preview={preview}
              presetId={presetId}
              onPreset={choosePreset}
              onReset={reset}
              onExport={exportFile}
              onCopy={copyJson}
              onImport={importText}
              onClose={() => setOpen(false)}
              onReplay={() => setReplay((n) => n + 1)}
              customDraft={customDraft}
              setCustomDraft={setCustomDraft}
              onApplyCss={applyCss}
              cssResult={cssResult}
              status={status}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}
