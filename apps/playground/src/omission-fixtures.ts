import type { Fixture } from './fixtures';

const unchanged = (name: string, count: number, wrap = false) => Array.from({ length: count }, (_, index) =>
  `const ${name}${index + 1} = ${wrap && index % 5 === 0 ? `"${'shared wrapping context · '.repeat(16)}"` : index + 1};`);
const changed = (name: string, count: number) => Array.from({ length: count }, (_, index) => `const ${name}${index + 1} = "changed ${index + 1}";`);

/** Unique unchanged lines yield exact canonical correspondences. With three
 * context lines at each edge, 62/90/18 lines become 56/84/12 hidden lines. */
function fixture(id: string, name: string, insert: number, remove: number, lengths = [62, 90, 18], wrap = false): Fixture {
  const sections = lengths.map((count, index) => unchanged(`section${index + 1}_`, count, wrap));
  const original = ['const version = "original";', ...sections[0], ...sections[1], ...changed('removed', remove), ...sections[2], 'const ending = "original";'];
  const modified = ['const version = "modified";', ...sections[0], ...changed('inserted', insert), ...sections[1], ...sections[2], 'const ending = "modified";'];
  // A same-height edit separates otherwise adjacent unchanged regions.
  if (!insert) { original.splice(1 + lengths[0], 0, 'const middleA = "original";'); modified.splice(1 + lengths[0], 0, 'const middleA = "modified";'); }
  if (!remove) { original.splice(1 + lengths[0] + Number(!insert) + lengths[1], 0, 'const middleB = "original";'); modified.splice(1 + lengths[0] + Number(!insert) + lengths[1], 0, 'const middleB = "modified";'); }
  // Real changed source below the final fold allows screenshots to scroll each
  // endpoint independently, without artificial view zones or EOF padding.
  if (id === 'large') { original.push(...changed('originalTail', 60)); modified.push(...changed('modifiedTail', 60)); }
  return {
    id: `omission-${id}`, name: `Omission · ${name}`, path: `src/omission-${id}.ts`, original: original.join('\n'), modified: modified.join('\n'),
    description: `${lengths.map(length => length - 6).join(', ')} hidden lines derived from unchanged ranges; ${insert} additions and ${remove} deletions between them.`,
  };
}

export const omissionFixtures: Fixture[] = [
  fixture('counts', '56 / 84 / 12 lines', 0, 0),
  fixture('unequal', 'Unequal omission heights', 10, 22),
  fixture('large', 'Large changes between folds', 24, 48),
  fixture('repeated', 'Repeated equal hidden counts', 8, 18, [62, 62, 62]),
  fixture('wrapped', 'Wrapped omission anchors', 5, 10, [62, 90, 18], true),
];
