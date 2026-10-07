import type { ComponentProps, CSSProperties } from 'react';
import { JetBrainsIcon } from '../icons';

export type UiIconName = ComponentProps<typeof JetBrainsIcon>['name'];
export function UiIcon({ name, size = 16, className, style }: { name: UiIconName; size?: number; className?: string; style?: CSSProperties }) {
  return <JetBrainsIcon name={name} size={size} className={className} style={style} />;
}
