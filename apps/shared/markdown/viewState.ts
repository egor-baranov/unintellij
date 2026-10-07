export type MarkdownMode = 'code' | 'split' | 'preview';
export interface MarkdownViewState {
  mode: MarkdownMode;
  ratio: number;
  scrollTop: number;
  sync: boolean;
}

export const defaultMarkdownView: MarkdownViewState = { mode: 'split', ratio: .5, scrollTop: 0, sync: true };

export function decodeMarkdownView(value: unknown): MarkdownViewState | undefined {
  if (!value || typeof value !== 'object') return;
  const input = value as Partial<MarkdownViewState>;
  if (input.mode !== 'code' && input.mode !== 'split' && input.mode !== 'preview') return;
  return {
    mode: input.mode,
    ratio: typeof input.ratio === 'number' && Number.isFinite(input.ratio) ? Math.max(.15, Math.min(.85, input.ratio)) : .5,
    scrollTop: typeof input.scrollTop === 'number' && Number.isFinite(input.scrollTop) ? Math.max(0, Math.min(1e9, input.scrollTop)) : 0,
    sync: typeof input.sync === 'boolean' ? input.sync : true,
  };
}
