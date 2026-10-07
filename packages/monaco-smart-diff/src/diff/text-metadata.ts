import type { TextMetadata } from './model';

export function textMetadata(text: string): TextMetadata {
  const endings = new Set(text.match(/\r\n|\r|\n/g) ?? []);
  return {
    lineEndings: endings.size > 1 ? 'mixed' : endings.has('\r\n') ? 'crlf' : endings.has('\r') ? 'cr' : endings.has('\n') ? 'lf' : 'none',
    hasFinalNewline: /[\r\n]$/.test(text),
  };
}
