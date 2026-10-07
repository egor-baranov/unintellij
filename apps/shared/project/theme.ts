import type { AppSettings } from '../settings/types';

/** Reference-preset tree colors; intentionally independent of Git classification. */
export const referenceTreeTheme = {
  background: '#191a1c', foreground: '#d1d3d9', annotation: '#74767b', selectedAnnotation: '#c3c7d1',
  folderStroke: '#c3c5ca', folderFill: '#43454a', warmFolderStroke: '#bd805c', warmFolderFill: '#42332c',
  sourceStroke: '#74a3df', sourceFill: '#293e57', testStroke: '#80b579', testFill: '#2d4232', rootMarker: '#6b9bfa',
  modified: '#91b8e3', added: '#72bc79', renamed: '#c5a5e8', copied: '#c5a5e8', deleted: '#74767b',
  untracked: '#ea8d8a', ignored: '#cd9d72', conflicted: '#ff7777', unavailable: '#8b8d93',
  dependencyBackground: '#271f1c', testBackground: '#1d2922', selection: '#293c63', unfocusedSelection: '#303236', hover: '#27292d',
  diagnosticError: '#e66565', diagnosticWarning: '#d6b267',
};
export type TreeTheme = typeof referenceTreeTheme;
export function getTreeTheme(settings: AppSettings): TreeTheme { return settings.colors.tree; }

/** Non-reference presets retain readable tree colors on their own surfaces. */
export function treeThemeForSurface(background: string, foreground: string, annotation: string, selection: string): TreeTheme {
  const rgb = background.slice(1, 7).match(/../g)!.map(part => parseInt(part, 16));
  const light = rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722 > 145;
  return { ...referenceTreeTheme, background, foreground, annotation, selection, deleted: annotation,
    ...(light ? {
      selectedAnnotation: '#465365', folderStroke: '#62656b', folderFill: '#d5d7dc', warmFolderStroke: '#9a623d', warmFolderFill: '#eadace',
      sourceStroke: '#346aac', sourceFill: '#d3e1f0', testStroke: '#387038', testFill: '#d8e8d5',
      modified: '#235f98', added: '#287537', renamed: '#76429e', copied: '#76429e', untracked: '#a93a39', ignored: '#8d572c', conflicted: '#b71c31', unavailable: '#676b73',
      dependencyBackground: '#eee6e0', testBackground: '#e7efe8', unfocusedSelection: '#dcdfe5', hover: '#e8eaee', diagnosticError: '#bc3030', diagnosticWarning: '#8b6500',
    } : {}),
  };
}
