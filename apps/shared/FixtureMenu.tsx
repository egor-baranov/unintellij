import { MenuButton, UiIcon } from './ui';

export interface FixtureOption { id: string; name: string; description: string }
export function FixtureMenu({ fixtures, selectedId, onSelect }: { fixtures: readonly FixtureOption[]; selectedId: string; onSelect: (id: string) => void }) {
  const selected = fixtures.find(item => item.id === selectedId);
  return <MenuButton label="Choose fixture" className="fixture-menu" align="start" title={selected?.description}
    items={[{ id: 'heading', kind: 'label', label: 'Diff fixtures' }, ...fixtures.map(fixture => ({ id: fixture.id, kind: 'radio' as const, label: fixture.name, checked: fixture.id === selectedId, onSelect: () => onSelect(fixture.id) }))]}>
    <UiIcon name="file" /><span>{selected?.name ?? 'Choose fixture'}</span>
  </MenuButton>;
}
