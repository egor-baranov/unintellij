import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { UiIcon } from '../ui/UiIcon';
import { Select } from '../ui/Select';
import { defaultSettings, isColor, isFontFamily, isSchemeName, normalizeSettings, presets, syntaxKeys } from './model';
import { exportIntelliJScheme, exportIntelliJTheme, exportNativeScheme, importScheme } from './schemes';
import { cancelSettingsPreview, getSettings, previewSettings, saveSettings } from './store';
import { defaultFileSavingSettings, getFileSavingSettings, saveFileSavingSettings } from './fileSaving';
import { ProfilerPanel } from '../profiler/ProfilerPanel';
import type { AppSettings, DiffColors, EditorColors, SurfaceColors, SurfaceKey, SyntaxKey } from './types';
import './settings.css';

const categories = [
  { id: 'appearance', label: 'Appearance', keywords: 'theme preset user interface ui font family size scale zoom' },
  { id: 'files', label: 'Files', keywords: 'save saving automatically automatic autosave file changes working tree' },
  { id: 'profiler', label: 'Profiler', keywords: 'performance live graphs resources ram memory disk storage cpu gpu processes heap utilization' },
  { id: 'font', label: 'Editor Font', keywords: 'code family size line height ligatures typography' },
  { id: 'syntax', label: 'Syntax Colors', keywords: 'highlighting tokens keywords strings numbers comments types operators tags attributes bold italic' },
  { id: 'components', label: 'Component Themes', keywords: 'window sidebar tabs popups menus dialogs editor diff background foreground selection caret addition deletion modification accent border' },
  { id: 'schemes', label: 'Schemes', keywords: 'name save import export json intellij icls xml' },
] as const;
const normalizedPresets = presets.map(preset => ({ ...preset, settings: normalizeSettings(preset.settings) }));
type Category = typeof categories[number]['id'];
type ComponentKey = SurfaceKey | 'editor' | 'diff' | 'tree';
const componentNames: Record<ComponentKey, string> = { window: 'Window', sidebar: 'Sidebar', tabs: 'Tabs', popups: 'Menus & dialogs', editor: 'Editor', diff: 'Diff highlights', tree: 'Project tree' };
const syntaxNames: Record<SyntaxKey, string> = { text: 'Default text', identifier: 'Identifiers', keyword: 'Keywords', string: 'Strings', number: 'Numbers', comment: 'Comments', type: 'Types', operator: 'Operators', tag: 'JSX tags', attribute: 'Attributes' };
const surfaceFields: Array<[keyof SurfaceColors, string]> = [['background', 'Background'], ['foreground', 'Text'], ['muted', 'Secondary text'], ['border', 'Border'], ['selection', 'Selection'], ['accent', 'Accent']];
const editorFields: Array<[keyof EditorColors, string]> = [['background', 'Background'], ['foreground', 'Text'], ['lineNumber', 'Line numbers'], ['selection', 'Selection'], ['caret', 'Caret']];
const diffFields: Array<[keyof DiffColors, string]> = [['added', 'Added lines'], ['removed', 'Deleted lines'], ['modified', 'Modified lines'], ['addedInner', 'Added text'], ['removedInner', 'Deleted text'], ['modifiedInner', 'Modified text']];

function NumberField({ label, value, min, max, step = 1, suffix, onChange }: { label: string; value: number; min: number; max: number; step?: number; suffix?: string; onChange: (value: number) => void }) {
  const id = useId();
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const valid = text.trim() !== '' && Number.isFinite(Number(text)) && Number(text) >= min && Number(text) <= max && (step !== 1 || Number.isInteger(Number(text)));
  return <label className="settings-number-field" htmlFor={id}><span>{label}</span><span className="settings-number-input"><input id={id} type="number" required min={min} max={max} step={step} value={text}
    aria-label={label} aria-invalid={!valid || undefined} title={`${min}–${max}${suffix ? ` ${suffix}` : ''}`} onChange={event => {
      const next = event.target.value; setText(next);
      const number = Number(next);
      if (next.trim() && Number.isFinite(number) && number >= min && number <= max && (step !== 1 || Number.isInteger(number))) onChange(number);
    }} onBlur={() => { if (!valid) setText(String(value)); }} />{suffix && <span>{suffix}</span>}</span></label>;
}

function TextField({ label, value, onChange, validate, maxLength, suggestions }: { label: string; value: string; onChange: (value: string) => void; validate: (value: string) => boolean; maxLength: number; suggestions?: string[] }) {
  const id = useId();
  const [text, setText] = useState(value);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => setText(value), [value]);
  const valid = validate(text);
  useEffect(() => { input.current?.setCustomValidity(valid ? '' : `Enter a valid ${label.toLowerCase()}.`); }, [valid, label]);
  return <div className="settings-text-field"><label htmlFor={id}>{label}</label><div className="settings-text-input"><input ref={input} id={id} type="text" value={text} maxLength={maxLength} required spellCheck={false}
    aria-invalid={!valid || undefined} onChange={event => { const next = event.target.value; setText(next); if (validate(next)) onChange(next); }}
    onBlur={() => { if (!valid) setText(value); }} />
    {suggestions && <Select compact label={label.replace('family', 'suggestions')} value={value} options={suggestions.map(family => ({ value: family, label: family }))}
      onChange={next => { setText(next); onChange(next); }} />}
  </div></div>;
}

function ColorField({ label, value, onChange, compact = false }: { label: string; value: string; onChange: (value: string) => void; compact?: boolean }) {
  const id = useId();
  const [text, setText] = useState(value);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => setText(value), [value]);
  const valid = isColor(text);
  useEffect(() => { input.current?.setCustomValidity(valid ? '' : 'Use #RRGGBB or #RRGGBBAA.'); }, [valid]);
  return <div className={`settings-color-field${compact ? ' is-compact' : ''}`}>
    <label className={compact ? 'sr-only' : ''} htmlFor={id}>{label}</label>
    <div className="settings-color-inputs"><input type="color" value={value.slice(0, 7)} aria-label={`${label} picker`} title={`${label} picker`}
      onChange={event => onChange(`${event.target.value}${value.length === 9 ? value.slice(7) : ''}`)} />
    <input ref={input} id={id} type="text" value={text} maxLength={9} spellCheck={false} required aria-invalid={!valid || undefined} title="#RRGGBB or #RRGGBBAA"
      onChange={event => { const next = event.target.value; setText(next); if (isColor(next)) onChange(next.toLowerCase()); }} onBlur={() => { if (!valid) setText(value); }} />
    </div>
  </div>;
}

function CheckField({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return <label className="settings-check"><input type="checkbox" checked={checked} onChange={event => onChange(event.target.checked)} />{label}</label>;
}

function SyntaxPreview({ settings }: { settings: AppSettings }) {
  const token = (kind: SyntaxKey, value: string): ReactNode => {
    const style = settings.colors.syntax[kind];
    return <span style={settings.editor.syntaxHighlight ? { color: style.foreground, fontWeight: style.bold ? 700 : 400, fontStyle: style.italic ? 'italic' : 'normal' } : undefined}>{value}</span>;
  };
  const codeStyle: CSSProperties = { fontFamily: settings.editor.fontFamily, fontSize: settings.editor.fontSize * settings.ui.scale, lineHeight: `${Math.max(settings.editor.lineHeight, settings.editor.fontSize) * settings.ui.scale}px`, fontVariantLigatures: settings.editor.ligatures ? 'normal' : 'none',
    background: settings.colors.editor.background, color: settings.colors.editor.foreground, '--preview-number': settings.colors.editor.lineNumber } as CSSProperties;
  return <section className="settings-preview" aria-label="Editor style preview"><div className="settings-preview-label">Preview <span>ReviewHeader.tsx</span></div>
    <div className="settings-preview-code" style={codeStyle}>
      <div data-line="1">{token('comment', '// Review changes in context')}</div>
      <div data-line="2">{token('keyword', 'export ')}{token('keyword', 'function ')}{token('identifier', 'ReviewHeader')}{token('operator', '(')}{token('identifier', 'title')}{token('operator', ': ')}{token('type', 'string')}{token('operator', ') {')}</div>
      <div data-line="3" style={{ background: settings.colors.diff.modified }}>{token('text', '  ')}{token('keyword', 'const ')}{token('identifier', 'count ')}{token('operator', '= ')}<span style={{ background: settings.colors.diff.modifiedInner }}>{token('number', '3')}</span>{token('operator', ';')}</div>
      <div data-line="4" style={{ background: settings.colors.diff.added }}>{token('text', '  ')}{token('keyword', 'return ')}{token('operator', '<')}{token('tag', 'header ')}{token('attribute', 'className')}{token('operator', '=')}{token('string', '"review"')}{token('operator', '>{')}{token('identifier', 'title')}{token('operator', '}</')}{token('tag', 'header')}{token('operator', '>;')}</div>
      <div data-line="5">{token('operator', '}')}</div>
    </div>
  </section>;
}

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const [draft, setDraft] = useState(() => normalizeSettings(getSettings()));
  const [fileSaving, setFileSaving] = useState(getFileSavingSettings);
  const [category, setCategory] = useState<Category>('appearance');
  const [query, setQuery] = useState('');
  const [component, setComponent] = useState<ComponentKey>('window');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [warnings, setWarnings] = useState<string[]>([]);
  const dialog = useRef<HTMLDialogElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const sequence = useRef(0);
  const finished = useRef(false);
  const headingId = useId();
  const matches = useMemo(() => categories.filter(item => `${item.label} ${item.keywords}`.toLowerCase().includes(query.trim().toLowerCase())), [query]);
  const active = matches.find(item => item.id === category) ?? matches[0];
  const presetId = normalizedPresets.find(preset => JSON.stringify(preset.settings.colors) === JSON.stringify(draft.colors) && JSON.stringify(preset.settings.ui) === JSON.stringify(draft.ui) && JSON.stringify(preset.settings.editor) === JSON.stringify(draft.editor))?.id ?? 'custom';
  const componentPresetId = normalizedPresets.find(preset => JSON.stringify(preset.settings.colors[component]) === JSON.stringify(draft.colors[component]) && (component !== 'editor' || JSON.stringify(preset.settings.colors.syntax) === JSON.stringify(draft.colors.syntax)))?.id ?? 'custom';

  useLayoutEffect(() => { if (form.current) form.current.scrollTop = 0; }, [active?.id]);

  useEffect(() => {
    const modal = dialog.current;
    modal?.showModal();
    search.current?.focus();
    return () => {
      sequence.current++;
      if (!finished.current) cancelSettingsPreview();
      modal?.close();
    };
  }, []);

  function change(update: (settings: AppSettings) => void) {
    sequence.current++;
    const next = structuredClone(draft);
    update(next);
    const normalized = normalizeSettings(next);
    try { previewSettings(normalized); setDraft(normalized); setError(''); setMessage(''); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to preview these settings.'); }
  }
  function replace(settings: AppSettings) {
    sequence.current++;
    const next = normalizeSettings(settings);
    try { previewSettings(next); setDraft(next); setError(''); setMessage(''); return true; }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to preview this scheme.'); return false; }
  }
  function cancel() {
    sequence.current++;
    cancelSettingsPreview();
    finished.current = true;
    dialog.current?.close();
    onClose();
  }
  function save(close: boolean) {
    if (!form.current?.reportValidity()) return;
    sequence.current++;
    try {
      saveSettings(draft);
      saveFileSavingSettings(fileSaving);
      setError(''); setMessage('Settings saved.');
      if (close) { finished.current = true; dialog.current?.close(); onClose(); }
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to save settings.'); }
  }
  async function importFile(file: File) {
    const request = ++sequence.current;
    setError(''); setMessage(''); setWarnings([]);
    try {
      if (!/\.(?:json|icls|xml)$/i.test(file.name)) throw new Error('Choose a .json, .icls or .xml scheme. Plugin and JAR files are unsupported.');
      if (file.size > 1024 * 1024) throw new Error('Scheme files must be no larger than 1 MiB.');
      const text = await file.text();
      if (request !== sequence.current) return;
      const imported = importScheme(text, file.name, draft);
      if (!replace(imported.settings)) return;
      setWarnings(imported.warnings);
      setMessage(`Imported ${file.name}.`);
    } catch (cause) { if (request === sequence.current) setError(cause instanceof Error ? cause.message : 'Unable to import this scheme.'); }
  }
  function exportFile(format: 'native' | 'editor' | 'theme') {
    if (!form.current?.reportValidity()) return;
    try {
      const text = format === 'native' ? exportNativeScheme(draft) : format === 'editor' ? exportIntelliJScheme(draft) : exportIntelliJTheme(draft);
      const extension = format === 'native' ? '.json' : format === 'editor' ? '.icls' : '.theme.json';
      const filename = (draft.name.replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^[.-]+|[.-]+$/g, '') || 'unintellij') + extension;
      const url = URL.createObjectURL(new Blob([text], { type: format === 'editor' ? 'application/xml' : 'application/json' }));
      const link = document.createElement('a'); link.href = url; link.download = filename; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setError(''); setMessage(`Exported ${filename}.`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to export this scheme.'); }
  }

  return createPortal(<dialog ref={dialog} className="settings-dialog" aria-labelledby={headingId} onKeyDown={event => {
    event.stopPropagation();
    if (event.key === 'Escape' && !event.nativeEvent.isComposing) { event.preventDefault(); cancel(); }
  }} onCancel={event => { event.preventDefault(); cancel(); }}>
    <header className="settings-header"><h2 id={headingId}>Settings</h2><button type="button" className="settings-icon-button" aria-label="Close settings" onClick={cancel}><UiIcon name="close" /></button></header>
    <div className="settings-body">
      <nav className="settings-navigation" aria-label="Settings categories">
        <input ref={search} className="settings-search" type="search" aria-label="Search settings" placeholder="Search settings" value={query} onChange={event => setQuery(event.target.value)} />
        <div className="settings-category-list">{matches.map(item => <button key={item.id} type="button" className={item.id === active?.id ? 'is-current' : ''} aria-current={item.id === active?.id ? 'page' : undefined} onClick={() => setCategory(item.id)}>{item.label}</button>)}</div>
        {!matches.length && <p className="settings-no-results">No matching settings.</p>}
      </nav>
      <div className="settings-main">
        <form ref={form} className="settings-form" onSubmit={event => { event.preventDefault(); save(false); }}>
          <h3>{active?.label ?? 'Settings'}</h3>
          {active?.id === 'profiler' && <ProfilerPanel client={typeof window.desktop?.readProfilerHistory === 'function' ? window.desktop : undefined} />}
          {active?.id === 'appearance' && <>
            <div className="settings-select-field"><span>Theme preset</span><Select label="Theme preset" value={presetId}
              options={[{ value: 'custom', label: 'Custom', disabled: true }, ...presets.map(preset => ({ value: preset.id, label: preset.name }))]}
              onChange={value => { const preset = presets.find(item => item.id === value); if (preset) { replace(preset.settings); setWarnings([]); } }} /></div>
            <fieldset><legend>Interface</legend>
              <TextField label="UI font family" value={draft.ui.fontFamily} maxLength={200} validate={isFontFamily} suggestions={['-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', 'Arial, sans-serif', 'Inter, sans-serif']} onChange={value => change(next => { next.ui.fontFamily = value; })} />
              <div className="settings-field-pair"><NumberField label="UI font size" value={draft.ui.fontSize} min={10} max={20} suffix="px" onChange={value => change(next => { next.ui.fontSize = value; })} />
                <NumberField label="UI scale" value={Math.round(draft.ui.scale * 100)} min={75} max={150} suffix="%" onChange={value => change(next => { next.ui.scale = value / 100; })} /></div>
            </fieldset>
          </>}
          {active?.id === 'files' && <>
            <CheckField label="Save changes automatically" checked={fileSaving.autoSave} onChange={autoSave => { setFileSaving({ autoSave }); setError(''); setMessage(''); }} />
            <p className="settings-hint">Save after 1 second without typing. Applies to files and the working-tree side of diffs.</p>
          </>}
          {active?.id === 'font' && <>
            <TextField label="Editor font family" value={draft.editor.fontFamily} maxLength={200} validate={isFontFamily} suggestions={['"JetBrains Mono", monospace', 'Menlo, monospace', 'Consolas, monospace', '"Cascadia Code", monospace', 'monospace']} onChange={value => change(next => { next.editor.fontFamily = value; })} />
            <div className="settings-field-pair"><NumberField label="Editor font size" value={draft.editor.fontSize} min={10} max={32} suffix="px" onChange={value => change(next => { next.editor.fontSize = value; next.editor.lineHeight = Math.max(next.editor.lineHeight, value); })} />
              <NumberField label="Line height" value={draft.editor.lineHeight} min={Math.max(14, draft.editor.fontSize)} max={56} suffix="px" onChange={value => change(next => { next.editor.lineHeight = value; })} /></div>
            <CheckField label="Font ligatures" checked={draft.editor.ligatures} onChange={value => change(next => { next.editor.ligatures = value; })} />
          </>}
          {active?.id === 'syntax' && <>
            <CheckField label="Syntax highlighting" checked={draft.editor.syntaxHighlight} onChange={value => change(next => { next.editor.syntaxHighlight = value; })} />
            <div className="settings-syntax-table">{syntaxKeys.map(key => <div className="settings-syntax-row" key={key}>
              <span>{syntaxNames[key]}</span><ColorField label={`${syntaxNames[key]} color`} value={draft.colors.syntax[key].foreground} compact onChange={value => change(next => { next.colors.syntax[key].foreground = value; })} />
              <button type="button" className="settings-style-toggle is-bold" aria-label={`${syntaxNames[key]} bold`} title="Bold" aria-pressed={draft.colors.syntax[key].bold} onClick={() => change(next => { next.colors.syntax[key].bold = !next.colors.syntax[key].bold; })}>B</button>
              <button type="button" className="settings-style-toggle is-italic" aria-label={`${syntaxNames[key]} italic`} title="Italic" aria-pressed={draft.colors.syntax[key].italic} onClick={() => change(next => { next.colors.syntax[key].italic = !next.colors.syntax[key].italic; })}>I</button>
            </div>)}</div>
          </>}
          {active?.id === 'components' && <>
            <div className="settings-field-pair"><div className="settings-select-field"><span>Component</span><Select label="Component" value={component} onChange={setComponent}
              options={Object.entries(componentNames).map(([key, label]) => ({ value: key as ComponentKey, label }))} /></div>
              <div className="settings-select-field"><span>Component preset</span><Select label="Component preset" value={componentPresetId}
                options={[{ value: 'custom', label: 'Custom', disabled: true }, ...presets.map(preset => ({ value: preset.id, label: preset.name }))]}
                onChange={value => { const preset = presets.find(item => item.id === value); if (preset) change(next => { Object.assign(next.colors[component], structuredClone(preset.settings.colors[component])); if (component === 'editor') next.colors.syntax = structuredClone(preset.settings.colors.syntax); }); }} /></div></div>
            <div className="settings-color-grid">
              {component === 'editor' ? editorFields.map(([key, label]) => <ColorField key={key} label={label} value={draft.colors.editor[key]} onChange={value => change(next => { next.colors.editor[key] = value; })} />)
                : component === 'diff' ? diffFields.map(([key, label]) => <ColorField key={key} label={label} value={draft.colors.diff[key]} onChange={value => change(next => { next.colors.diff[key] = value; })} />)
                  : component === 'tree' ? (Object.keys(draft.colors.tree) as Array<keyof typeof draft.colors.tree>).map(key => <ColorField key={key} label={key.replace(/([A-Z])/g, ' $1').replace(/^./, character => character.toUpperCase())} value={draft.colors.tree[key]} onChange={value => change(next => { next.colors.tree[key] = value; })} />)
                  : surfaceFields.map(([key, label]) => <ColorField key={key} label={label} value={draft.colors[component][key]} onChange={value => change(next => { next.colors[component][key] = value; })} />)}
            </div>
          </>}
          {active?.id === 'schemes' && <>
            <TextField label="Scheme name" value={draft.name} maxLength={100} validate={isSchemeName} onChange={value => change(next => { next.name = value; })} />
            <fieldset><legend>Import</legend><button type="button" onClick={() => fileInput.current?.click()}>Import scheme…</button>
              <input ref={fileInput} type="file" accept=".json,.icls,.xml" aria-label="Import scheme file" hidden onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void importFile(file); }} />
              <p className="settings-hint">JSON, ICLS or XML. Plugin and JAR files are unsupported.</p>
            </fieldset>
            <fieldset><legend>Export</legend><div className="settings-export-actions"><button type="button" onClick={() => exportFile('native')}>unintellij JSON</button><button type="button" onClick={() => exportFile('editor')}>IntelliJ .icls</button><button type="button" onClick={() => exportFile('theme')}>IntelliJ .theme.json</button></div></fieldset>
          </>}
          {!active && <p className="settings-hint">Try “font”, “syntax” or “sidebar”.</p>}
        </form>
        {active?.id !== 'files' && active?.id !== 'profiler' && <SyntaxPreview settings={draft} />}
      </div>
    </div>
    {(error || message || warnings.length > 0) && <div className="settings-feedback">
      {error ? <p role="alert" className="settings-error">{error}</p> : message && <p role="status">{message}</p>}
      {warnings.length > 0 && <details className="settings-warnings"><summary>{warnings.length} import {warnings.length === 1 ? 'warning' : 'warnings'}</summary><ul>{warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>}
    </div>}
    <footer className="settings-footer"><button type="button" className="settings-reset" onClick={() => { replace(defaultSettings); setFileSaving(defaultFileSavingSettings); setWarnings([]); }}>Restore defaults</button><div><button type="button" onClick={cancel}>Cancel</button><button type="button" onClick={() => save(false)}>Apply</button><button type="button" className="settings-primary" onClick={() => save(true)}>Save</button></div></footer>
  </dialog>, document.body);
}
