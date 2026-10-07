import type { Fixture } from './fixtures';

const lines = (prefix: string, count: number) => Array.from({ length: count }, (_, index) => `const ${prefix}${index + 1} = ${index + 1};`);
const context = lines('anchor', 32);
const inserted = ['const enabled = true;', 'const label = "New section";', 'const retries = 3;'];
const text = (value: string[]) => value.join('\n');
const middle = [...context.slice(0, 9), ...inserted, ...context.slice(9)];
const large = [...context.slice(0, 9), ...lines('inserted', 60), ...context.slice(9)];
const edges = ['const startMarker = "start";', ...context, 'const endMarker = "end";'];
const distant = lines('stable', 240);
const nearby = [...context.slice(0, 4), ...inserted.slice(0, 1), ...context.slice(4, 12), ...context.slice(14, 22), 'const replacement = "changed";', ...context.slice(23)];
const wrapped = ['const before = "unchanged";', `const wrappedAnchor = "${'content that wraps across the viewport · '.repeat(18)}";`, ...lines('after', 28)];
function fixture(id: string, name: string, original: string[], modified: string[], description: string): Fixture {
  return { id: `boundary-${id}`, name: `Boundary · ${name}`, path: `src/boundary-${id}.ts`, original: text(original), modified: text(modified), description };
}

/** One-sided changes keep the empty endpoint between rows, including virtual EOF. */
export const oneSidedFixtures: Fixture[] = [
  fixture('single-insert', 'One-line insertion', context, [...context.slice(0, 9), inserted[0], ...context.slice(9)], 'One inserted line meets an exact empty boundary after original line 9.'),
  fixture('single-delete', 'One-line deletion', [...context.slice(0, 9), inserted[0], ...context.slice(9)], context, 'One deleted line meets an exact empty boundary after modified line 9.'),
  fixture('insert', 'Insertion between lines', context, middle, 'Three inserted lines taper to a horizontal boundary after original line 9.'),
  fixture('delete', 'Deletion between lines', middle, context, 'Three deleted lines taper to a horizontal boundary after modified line 9.'),
  fixture('large-insert', 'Large insertion', context, large, 'Sixty inserted lines meet one exact original boundary without filling an unchanged line.'),
  fixture('large-delete', 'Large deletion', large, context, 'Sixty removed lines meet one exact modified boundary; the connector may extend beyond the viewport.'),
  fixture('edges-insert', 'Start and EOF insertions', context, edges, 'Insertions at file start and virtual EOF; neither side has a terminating newline.'),
  fixture('edges-delete', 'Start and EOF deletions', edges, context, 'Deletions at file start and virtual EOF, with a real empty boundary on the modified side.'),
  fixture('empty-original', 'Empty original document', [], inserted, 'The original document is empty. The boundary belongs at the top of its single Monaco placeholder row.'),
  fixture('empty-modified', 'Empty modified document', inserted, [], 'The modified document is empty. The deletion meets its file-start boundary.'),
  fixture('blank-insert', 'Inserted blank line', context, [...context.slice(0, 9), '', ...context.slice(9)], 'The inserted blank line is a real one-row block; only the original endpoint is empty.'),
  fixture('blank-delete', 'Deleted blank line', [...context.slice(0, 9), '', ...context.slice(9)], context, 'The deleted blank line is a real one-row block; only the modified endpoint is empty.'),
  fixture('nearby', 'Mixed nearby changes', context, nearby, 'An insertion, deletion, and ordinary replacement retain distinct geometry and colors.'),
  fixture('folds', 'Collapsed context', distant, [...distant.slice(0, 12), ...inserted, ...distant.slice(12, 112), ...distant.slice(115, 224), ...inserted, ...distant.slice(224)], 'Distant insertions and a deletion with unchanged regions that collapse and expand together.'),
  fixture('wrap', 'Wrapped boundary anchor', wrapped, [...wrapped.slice(0, 2), ...inserted, ...wrapped.slice(2)], 'The insertion follows a long wrapped row; horizontal scrolling must not move the boundary overlay.'),
];
