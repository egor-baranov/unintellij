import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommitPanel } from './CommitPanel';

beforeEach(() => vi.stubGlobal('localStorage', { getItem: () => null }));
afterEach(() => vi.unstubAllGlobals());

describe('initial unversioned file discovery', () => {
  it('does not report a clean working tree while the first scan is incomplete', () => {
    const markup = renderToStaticMarkup(createElement(CommitPanel, {
      files: [], onSelect: () => {}, untrackedPending: true, emptyMessage: 'Working tree clean',
    }));
    expect(markup).toContain('Loading unversioned files…');
    expect(markup).toContain('aria-busy="true"');
    expect(markup).not.toContain('Working tree clean');
  });

  it('keeps tracked changes selectable while discovering unversioned files', () => {
    const markup = renderToStaticMarkup(createElement(CommitPanel, {
      files: [{ id: 'tracked', path: 'known.ts', status: 'M', group: 'working' }],
      onSelect: () => {}, untrackedPending: true,
    }));
    expect(markup).toContain('aria-label="known.ts (working)"');
    expect(markup).toContain('Loading unversioned files…');
  });

  it('does not report a clean working tree when initial discovery fails', () => {
    const markup = renderToStaticMarkup(createElement(CommitPanel, {
      files: [], onSelect: () => {}, untrackedError: 'The Git scan failed.', emptyMessage: 'Working tree clean',
    }));
    expect(markup).toContain('Unversioned files could not be loaded. Refresh to retry.');
    expect(markup).not.toContain('Loading unversioned files…');
    expect(markup).not.toContain('Working tree clean');
  });
});

describe('Go test scope in the changes tree', () => {
  const files = [
    { id: 'test', path: 'runtime_test.go', status: 'M', group: 'working' as const },
    { id: 'source', path: 'runtime.go', status: 'M', group: 'working' as const },
    { id: 'untracked', path: 'new_test.go', status: '?', group: 'untracked' as const },
    { id: 'link', path: 'link_test.go', status: 'A', group: 'working' as const, unsupported: 'Symbolic links are not followed.' },
  ];
  const row = (markup: string, id: string) => markup.match(new RegExp(`<div[^>]*data-file-id="${id}"[^>]*>`))?.[0] ?? '';
  it('marks test file rows while preserving selected state and Git name coloring', () => {
    const markup = renderToStaticMarkup(createElement(CommitPanel, { files, selectedId: 'test', onSelect: () => {} }));
    expect(row(markup, 'test')).toContain('data-scope="test"');
    expect(row(markup, 'test')).toContain('is-current');
    expect(row(markup, 'test')).toContain('commit-status-modified');
    expect(row(markup, 'untracked')).toContain('data-scope="test"');
    expect(row(markup, 'untracked')).toContain('commit-status-untracked');
    expect(row(markup, 'source')).not.toContain('data-scope');
    expect(row(markup, 'link')).not.toContain('data-scope');
  });
  it('honors the existing scope-background preference without altering Git coloring', () => {
    const markup = renderToStaticMarkup(createElement(CommitPanel, { files, scopeBackgrounds: false, onSelect: () => {} }));
    expect(markup).not.toContain('data-scope="test"');
    expect(row(markup, 'test')).toContain('commit-status-modified');
  });
});
