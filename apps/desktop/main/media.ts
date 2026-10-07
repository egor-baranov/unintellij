import type { MediaContent } from '../../shared/media/types';

export const DEFAULT_MAX_PREVIEW_BYTES = 32 * 1024 * 1024;
export const ABSOLUTE_MAX_PREVIEW_BYTES = 100 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 64_000_000;
type MediaFormat = Pick<MediaContent, 'kind' | 'mimeType'>;
export type MediaProbe = { format: MediaFormat } | { unsupported: string } | undefined;
const starts = (bytes: Buffer, signature: number[]) => signature.every((value, index) => bytes[index] === value);
const ascii = (bytes: Buffer, start: number, end: number) => bytes.toString('ascii', start, end);
const format = (kind: MediaContent['kind'], mimeType: string): MediaProbe => ({ format: { kind, mimeType } });

function raster(bytes: Buffer, mimeType: string): MediaProbe {
  const dimensions: Array<[number, number]> = [];
  if (mimeType === 'image/png') dimensions.push([bytes.readUInt32BE(16), bytes.readUInt32BE(20)]);
  if (mimeType === 'image/gif') dimensions.push([bytes.readUInt16LE(6), bytes.readUInt16LE(8)]);
  if (mimeType === 'image/bmp') dimensions.push(bytes.readUInt32LE(14) === 12 ? [bytes.readUInt16LE(18), bytes.readUInt16LE(20)] : [bytes.readInt32LE(18), Math.abs(bytes.readInt32LE(22))]);
  if (mimeType === 'image/webp' && bytes.length >= 30) {
    const encoding = ascii(bytes, 12, 16);
    if (encoding === 'VP8X') dimensions.push([bytes.readUIntLE(24, 3) + 1, bytes.readUIntLE(27, 3) + 1]);
    if (encoding === 'VP8 ' && bytes[23] === 0x9d && bytes[24] === 1 && bytes[25] === 0x2a) dimensions.push([bytes.readUInt16LE(26) & 0x3fff, bytes.readUInt16LE(28) & 0x3fff]);
    if (encoding === 'VP8L' && bytes[20] === 0x2f) {
      const packed = bytes.readUInt32LE(21);
      dimensions.push([(packed & 0x3fff) + 1, ((packed >>> 14) & 0x3fff) + 1]);
    }
  }
  if (mimeType === 'image/x-icon') {
    const count = bytes.readUInt16LE(4);
    if (count > 256 || 6 + count * 16 > bytes.length) return { unsupported: 'The icon directory is malformed or exceeds the preview limit.' };
    for (let index = 0; index < count; index++) {
      const offset = 6 + index * 16;
      dimensions.push([bytes[offset] || 256, bytes[offset + 1] || 256]);
      const dataOffset = bytes.readUInt32LE(offset + 12);
      if (dataOffset + 24 <= bytes.length && starts(bytes.subarray(dataOffset), [137, 80, 78, 71, 13, 10, 26, 10])) dimensions.push([bytes.readUInt32BE(dataOffset + 16), bytes.readUInt32BE(dataOffset + 20)]);
    }
  }
  if (mimeType === 'image/jpeg') {
    // JPEG dimensions precede scan data in a SOF marker. Inspect bounded
    // metadata only, never entropy-decode image pixels in the main process.
    let offset = 2;
    while (offset + 4 <= bytes.length && offset < 1024 * 1024) {
      if (bytes[offset++] !== 0xff) break;
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xda || marker === 0xd9 || offset + 2 > bytes.length) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 8) {
        dimensions.push([bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3)]);
        break;
      }
      offset += length;
    }
  }
  if (dimensions.some(([width, height]) => width <= 0 || height <= 0 || width > 32768 || height > 32768 || width * height > MAX_IMAGE_PIXELS)) {
    return { unsupported: 'The image dimensions exceed the preview limit (32,768 pixels per side and 64 megapixels total), or are invalid.' };
  }
  return format('image', mimeType);
}

// This is intentionally a small static SVG language, not a general XML/CSS
// sanitizer. Rejected documents are never sent to the renderer as an image.
// No entities, processing instructions, CSS, animation, foreign namespaces,
// embedded documents or resource-bearing elements are accepted. The renderer
// must additionally use an <img> Blob URL, never inline SVG/HTML/object/embed.
const svgElements = new Set(['svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'defs', 'linearGradient', 'radialGradient', 'stop', 'clipPath', 'mask', 'title', 'desc', 'text', 'tspan', 'use']);
const svgAttributes = new Set(['id', 'xmlns', 'xmlns:xlink', 'version', 'width', 'height', 'viewBox', 'preserveAspectRatio', 'x', 'y', 'x1', 'x2', 'y1', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'd', 'points', 'transform', 'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset', 'opacity', 'clip-path', 'clip-rule', 'mask', 'maskUnits', 'maskContentUnits', 'clipPathUnits', 'gradientUnits', 'gradientTransform', 'spreadMethod', 'offset', 'stop-color', 'stop-opacity', 'href', 'xlink:href', 'font-family', 'font-size', 'font-weight', 'font-style', 'text-anchor', 'dominant-baseline', 'dx', 'dy', 'rotate', 'textLength', 'lengthAdjust', 'visibility', 'display', 'color', 'vector-effect', 'shape-rendering']);
const localReference = /^#[a-zA-Z_][\w.:-]*$/;

function staticSvg(source: string): boolean {
  // Reject encoded syntax rather than trying to normalize untrusted entity
  // expansion, including numeric entities in URLs and namespace values.
  if (/[&\\\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(source)) return false;
  let cursor = 0;
  const stack: string[] = [];
  let rootSeen = false;
  let elements = 0;
  while (cursor < source.length) {
    if (source[cursor] !== '<') {
      const next = source.indexOf('<', cursor);
      const text = source.slice(cursor, next < 0 ? source.length : next);
      if (!stack.length && text.trim()) return false;
      cursor = next < 0 ? source.length : next;
      continue;
    }
    if (source.startsWith('<!--', cursor)) {
      const end = source.indexOf('-->', cursor + 4);
      if (end < 0 || source.slice(cursor + 4, end).includes('--')) return false;
      cursor = end + 3;
      continue;
    }
    if (source.startsWith('<?xml ', cursor) && !rootSeen && !source.slice(0, cursor).trim()) {
      const end = source.indexOf('?>', cursor + 6);
      if (end < 0 || !/^<\?xml\s+version\s*=\s*(['"])1\.[01]\1(?:\s+encoding\s*=\s*(['"])utf-8\2)?(?:\s+standalone\s*=\s*(['"])(?:yes|no)\3)?\s*\?>$/i.test(source.slice(cursor, end + 2))) return false;
      cursor = end + 2;
      continue;
    }
    const end = source.indexOf('>', cursor + 1);
    if (end < 0) return false;
    const tag = source.slice(cursor + 1, end);
    if (tag.startsWith('/')) {
      if (!/^\/[a-zA-Z][\w-]*\s*$/.test(tag) || stack.pop() !== tag.slice(1).trim()) return false;
    } else {
      const name = /^[a-zA-Z][\w-]*/.exec(tag)?.[0];
      if (!name || !svgElements.has(name) || (!stack.length && (rootSeen || name !== 'svg'))) return false;
      if (++elements > 20000 || stack.length > 128) return false;
      rootSeen = true;
      const selfClosing = tag.endsWith('/');
      let attributes = tag.slice(name.length, selfClosing ? -1 : undefined);
      const seen = new Set<string>();
      while (attributes.trim()) {
        const attribute = /^\s+([a-zA-Z][\w:-]*)\s*=\s*(['"])([^'"<>]*)\2/.exec(attributes);
        if (!attribute || !svgAttributes.has(attribute[1]) || seen.has(attribute[1])) return false;
        const [, key, , value] = attribute;
        seen.add(key);
        if (key === 'xmlns' && value !== 'http://www.w3.org/2000/svg') return false;
        if (key === 'xmlns:xlink' && value !== 'http://www.w3.org/1999/xlink') return false;
        if ((key === 'href' || key === 'xlink:href') && !localReference.test(value)) return false;
        if (key !== 'xmlns' && key !== 'xmlns:xlink' && key !== 'href' && key !== 'xlink:href') {
          // Values may contain local gradient/clip references, but no generic
          // functions, schemes or URL-bearing CSS tokens.
          const checked = value.replace(/url\(#[a-zA-Z_][\w.:-]*\)/g, '').replace(/(?:matrix|translate|scale|rotate|skewX|skewY)\([\d+\-.,eE\s]*\)/g, '');
          if (/[():@]/.test(checked) || /(?:url|javascript|https?|data)\s*:/i.test(value)) return false;
        }
        attributes = attributes.slice(attribute[0].length);
      }
      if (!selfClosing) stack.push(name);
    }
    cursor = end + 1;
  }
  return rootSeen && stack.length === 0;
}

/** Classifies actual bytes, never extensions. Containers still need browser codec support. */
export function sniffMedia(bytes: Buffer): MediaProbe {
  // UTF-16 BOM bytes can resemble an MPEG frame sync. Preserve the explicit
  // encoding state instead of labeling an unsupported text encoding as audio.
  if (starts(bytes, [0xff, 0xfe]) || starts(bytes, [0xfe, 0xff]) || starts(bytes, [0, 0, 0xfe, 0xff])) return undefined;
  if (bytes.length >= 24 && starts(bytes, [137, 80, 78, 71, 13, 10, 26, 10]) && ascii(bytes, 12, 16) === 'IHDR') return raster(bytes, 'image/png');
  if (bytes.length >= 4 && starts(bytes, [0xff, 0xd8, 0xff]) && bytes[3] !== 0 && bytes[3] !== 0xff) return raster(bytes, 'image/jpeg');
  if (bytes.length >= 13 && ['GIF87a', 'GIF89a'].includes(ascii(bytes, 0, 6))) return raster(bytes, 'image/gif');
  if (bytes.length >= 16 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP' && ['VP8 ', 'VP8L', 'VP8X'].includes(ascii(bytes, 12, 16))) return raster(bytes, 'image/webp');
  if (bytes.length >= 26 && ascii(bytes, 0, 2) === 'BM' && bytes.readUInt32LE(10) >= 26) return raster(bytes, 'image/bmp');
  if (bytes.length >= 22 && starts(bytes, [0, 0, 1, 0]) && bytes.readUInt16LE(4) > 0) return raster(bytes, 'image/x-icon');
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WAVE') return format('audio', 'audio/wav');
  if (bytes.length >= 8 && ascii(bytes, 0, 4) === 'fLaC') return format('audio', 'audio/flac');
  if (bytes.length >= 10 && ascii(bytes, 0, 3) === 'ID3' && bytes[3] >= 2 && bytes[3] <= 4 && bytes.subarray(6, 10).every(value => value < 128)) return format('audio', 'audio/mpeg');
  if (bytes.length >= 4 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0 && (bytes[1] & 0x18) !== 0x08 && (bytes[1] & 6) !== 0 && (bytes[2] & 0xf0) !== 0xf0 && (bytes[2] & 0xf0) !== 0 && (bytes[2] & 0x0c) !== 0x0c) return format('audio', 'audio/mpeg');
  if (bytes.length >= 28 && ascii(bytes, 0, 4) === 'OggS' && bytes[4] === 0) {
    const packet = 27 + bytes[26];
    if (bytes.length >= packet + 8) {
      if (ascii(bytes, packet, packet + 8) === 'OpusHead' || ascii(bytes, packet, packet + 8) === 'Speex   ' || ascii(bytes, packet + 1, packet + 7) === 'vorbis') return format('audio', 'audio/ogg');
      if (bytes[packet] === 0x80 && ascii(bytes, packet + 1, packet + 7) === 'theora') return format('video', 'video/ogg');
    }
  }
  if (bytes.length >= 16 && ascii(bytes, 4, 8) === 'ftyp') {
    const size = bytes.readUInt32BE(0);
    if (size >= 16 && size <= Math.min(bytes.length, 4096) && size % 4 === 0) {
      const brands = [ascii(bytes, 8, 12)];
      for (let offset = 16; offset < size; offset += 4) brands.push(ascii(bytes, offset, offset + 4));
      if (brands.some(brand => brand === 'avif' || brand === 'avis')) return format('image', 'image/avif');
      if (brands[0] === 'M4A ' || brands[0] === 'M4B ') return format('audio', 'audio/mp4');
      if (brands.some(brand => ['isom', 'iso2', 'iso3', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'M4V ', 'dash'].includes(brand))) return format('video', 'video/mp4');
    }
  }
  if (starts(bytes, [0x1a, 0x45, 0xdf, 0xa3])) {
    // EBML DocType element (0x4282), 4-byte string "webm". Matroska is
    // deliberately not accepted merely because it shares the EBML header.
    if (bytes.subarray(0, 4096).includes(Buffer.from([0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d]))) return format('video', 'video/webm');
  }
  const prefix = bytes.subarray(0, 4096).toString('utf8').replace(/^\ufeff/, '').trimStart();
  if (/^(?:<\?xml\s|<!--|<!DOCTYPE\s|<svg(?:\s|\/?>))/i.test(prefix)) {
    // Only SVG candidates become unsupported; ordinary XML remains text.
    if (/<svg(?:\s|\/?>)/i.test(prefix)) {
      let source: string;
      try { source = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch { return { unsupported: 'SVG previews require valid UTF-8.' }; }
      if (staticSvg(source)) return format('image', 'image/svg+xml');
      return { unsupported: 'This SVG uses unsupported markup, entities, styling, scripts, or external resources. Only static SVG shapes, text, gradients, and local references can be previewed.' };
    }
  }
  return undefined;
}

export function mediaContent(bytes: Buffer, mediaFormat: MediaFormat): MediaContent {
  return { ...mediaFormat, bytes: bytes.length, base64: bytes.toString('base64') };
}
