/** Serializable, bounded bytes supplied by a host; never a filesystem URL. */
export interface MediaContent {
  kind: 'image' | 'audio' | 'video';
  mimeType: string;
  base64: string;
  bytes: number;
}
export interface MediaSide extends MediaContent { label: string }
