import { FileSurface, type FileSurfaceProps } from './project/FileSurface';

export type AddedFileSurfaceProps = Omit<FileSurfaceProps, 'added'>;

/** A complete newly added file needs one editor, with no empty comparison pane. */
export function AddedFileSurface(props: AddedFileSurfaceProps) {
  return <FileSurface {...props} added />;
}
