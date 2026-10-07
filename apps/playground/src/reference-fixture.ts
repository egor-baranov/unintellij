import type { Fixture } from './fixtures';

const sections = [
  ['appearance', 'Appearance', 'Choose how code and comparisons are displayed.'],
  ['navigation', 'Navigation', 'Move between files and changed regions.'],
  ['scrolling', 'Scrolling', 'Keep related code within reach.'],
  ['context', 'Context lines', 'Choose how much unchanged code remains visible.'],
  ['whitespace', 'Whitespace', 'Control which spacing changes are emphasized.'],
  ['typography', 'Typography', 'Select a comfortable code reading size.'],
  ['wrapping', 'Line wrapping', 'Fit long source lines to the available width.'],
  ['selection', 'Selection', 'Keep text selection clear on changed lines.'],
  ['search', 'Search', 'Find text within the current comparison.'],
  ['keyboard', 'Keyboard', 'Navigate without leaving the editor.'],
  ['accessibility', 'Accessibility', 'Choose motion and contrast preferences.'],
  ['files', 'Changed files', 'Choose which file groups are shown first.'],
  ['refresh', 'Repository refresh', 'Refresh the view when files change.'],
  ['history', 'Session history', 'Restore the last comparison and reading position.'],
  ['formats', 'File formats', 'Show encoding and line ending information.'],
  ['limits', 'File limits', 'Keep large comparisons responsive.'],
  ['notifications', 'Notifications', 'Keep recoverable loading errors visible.'],
  ['privacy', 'Local data', 'Store preferences only on this computer.'],
  ['advanced', 'Advanced', 'Additional options for experienced reviewers.'],
  ['reset', 'Reset preferences', 'Return to the default review experience.'],
].map(([id, title, description]) => `  {
    id: '${id}',
    title: '${title}',
    description: '${description}',
  },`).join('\n');

const original = `import { useId, useMemo, useState } from 'react';
import type { ChangeEvent, ReactNode } from 'react';

// Synthetic playground fixture: this file is not read from a repository.
type SectionId = string;
type Density = 'comfortable' | 'compact';

interface ReviewPreferences {
  density: Density;
  contextLines: number;
  synchronizeScrolling: boolean;
  collapseUnchanged: boolean;
  ignoreWhitespace: boolean;
  wrapLongLines: boolean;
  showFileMetadata: boolean;
}

interface Section {
  id: SectionId;
  title: string;
  description: string;
}

interface PreferencesPanelProps {
  initialPreferences: ReviewPreferences;
  onApply: (preferences: ReviewPreferences) => void;
  onClose: () => void;
}

const DEFAULT_PREFERENCES: ReviewPreferences = {
  density: 'compact',
  contextLines: 3,
  synchronizeScrolling: true,
  collapseUnchanged: true,
  ignoreWhitespace: false,
  wrapLongLines: false,
  showFileMetadata: true,
};

const SECTIONS: Section[] = [
${sections}
];

function validateContextLines(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_PREFERENCES.contextLines;
  return Math.max(1, Math.min(20, parsed));
}

function preferenceSummary(preferences: ReviewPreferences): string {
  const description = preferences.collapseUnchanged
    ? 'Only changed fragments and their surrounding context are shown.'
    : 'The complete source documents remain visible.';
  return description;
}

function normalizeSearch(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function matchesSearch(section: Section, query: string): boolean {
  return normalizeSearch(section.title + ' ' + section.description).includes(query);
}

function getInitialSection(): SectionId {
  return SECTIONS[0].id;
}

function isDefaultConfiguration(preferences: ReviewPreferences): boolean {
  return Object.entries(DEFAULT_PREFERENCES).every(([key, value]) => (
    preferences[key as keyof ReviewPreferences] === value
  ));
}

function formatContextCount(contextLines: number): string {
  return contextLines === 1 ? '1 context line' : contextLines + ' context lines';
}

function FieldDescription({ id, children }: { id: string; children: ReactNode }) {
  return <p id={id} className="field-description">{children}</p>;
}

function SectionHeading({ section }: { section: Section }) {
  return (
    <header className="preference-section-heading">
      <h2>{section.title}</h2>
      <p>{section.description}</p>
    </header>
  );
}

function PreferenceDivider() {
  return <hr className="preference-divider" aria-hidden="true" />;
}

function EmptySearch({ onReset }: { onReset: () => void }) {
  return (
    <div className="empty-preference-search">
      <p>No preferences match your search.</p>
      <button type="button" onClick={onReset}>Clear search</button>
    </div>
  );
}

export function ReviewPreferencesPanel({ initialPreferences, onApply, onClose }: PreferencesPanelProps) {
  const formId = useId();
  const [preferences, setPreferences] = useState(initialPreferences);
  const [activeSection, setActiveSection] = useState(getInitialSection);
  const [search, setSearch] = useState('');
  const filteredSections = useMemo(() => SECTIONS.filter((section) => matchesSearch(section, normalizeSearch(search))), [search]);

  function updatePreference<Key extends keyof ReviewPreferences>(key: Key, value: ReviewPreferences[Key]) {
    setPreferences((previous) => ({ ...previous, [key]: value }));
  }

  function updateContextLines(event: ChangeEvent<HTMLInputElement>) {
    updatePreference('contextLines', validateContextLines(event.target.value));
  }

  function resetSearch() {
    setSearch('');
  }

  function resetPreferences() {
    setPreferences({ ...DEFAULT_PREFERENCES });
    setActiveSection(getInitialSection());
  }

  function applyPreferences() {
    onApply(preferences);
    onClose();
  }

  const selectedSection = SECTIONS.find((section) => section.id === activeSection) ?? SECTIONS[0];
  const contextDescriptionId = formId + '-context-description';
  const summary = preferenceSummary(preferences);

  return (
    <section className="review-preferences" aria-label="Review preferences">
      <header className="review-preferences-header">
        <h1>Review preferences</h1>
        <button type="button" aria-label="Close preferences" onClick={onClose}>×</button>
      </header>

      <div className="review-preferences-body">
        <nav className="preference-navigation" aria-label="Preference sections">
          <input
            type="search"
            aria-label="Search preferences"
            placeholder="Find a preference"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          {filteredSections.length === 0 && <EmptySearch onReset={resetSearch} />}
          <ul>
            {filteredSections.map((section) => (
              <li key={section.id}>
                <button
                  type="button"
                  aria-current={activeSection === section.id ? 'page' : undefined}
                  onClick={() => setActiveSection(section.id)}
                >
                  {section.title}
                </button>
              </li>
            ))}
          </ul>
        </nav>

        <main className="preference-content">
          <SectionHeading section={selectedSection} />

          <div className="preference-field">
            <label htmlFor={formId + '-context'}>Context lines</label>
            <input
              id={formId + '-context'}
              type="number"
              min={1}
              max={20}
              value={preferences.contextLines}
              aria-describedby={contextDescriptionId}
              onChange={updateContextLines}
            />
            <FieldDescription id={contextDescriptionId}>
              Keep {formatContextCount(preferences.contextLines)} around each changed region.
            </FieldDescription>
          </div>

          <PreferenceDivider />

          <label className="preference-checkbox">
            <input
              type="checkbox"
              checked={preferences.collapseUnchanged}
              onChange={(event) => updatePreference('collapseUnchanged', event.target.checked)}
            />
            Collapse unchanged sections
          </label>

          <p className="preference-summary">{summary}</p>

          <PreferenceDivider />

          <label className="preference-checkbox">
            <input
              type="checkbox"
              checked={preferences.wrapLongLines}
              onChange={(event) => updatePreference('wrapLongLines', event.target.checked)}
            />
            Wrap long source lines
          </label>
        </main>
      </div>

      <footer className="review-preferences-footer">
        <button type="button" disabled={isDefaultConfiguration(preferences)} onClick={resetPreferences}>Restore defaults</button>
        <div className="review-preferences-actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="button" className="primary-action" onClick={applyPreferences}>Apply</button>
        </div>
      </footer>
    </section>
  );
}
`;

const modified = original
  .replace('Math.max(1, Math.min(20, parsed))', 'Math.max(3, Math.min(40, parsed))')
  .replace("  const [search, setSearch] = useState('');", "  const [search, setSearch] = useState('');\n  const [showPreview, setShowPreview] = useState(true);")
  .replace('matchesSearch(section, normalizeSearch(search))', 'matchesSearch(section, normalizeSearch(search)) || section.id === activeSection')
  .replace(')), [search]);', ')), [search, activeSection]);');

export const referenceFixture: Fixture = {
  id: 'reference',
  name: 'Reference-style TSX fixture',
  path: 'fixtures/ReviewPreferencesPanel.tsx',
  description: 'Synthetic TSX fixture with distant edits, real folded ranges, and unequal fragment heights.',
  original,
  modified: modified.replace(
    '          <p className="preference-summary">{summary}</p>',
    `          <p className="preference-summary">{summary}</p>

          <label className="preference-checkbox">
            <input
              type="checkbox"
              checked={showPreview}
              onChange={(event) => setShowPreview(event.target.checked)}
            />
            Show a preview of hidden context
          </label>`,
  ).replace('>Apply</button>', '>Apply preferences</button>'),
};
