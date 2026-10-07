import { memo, useEffect, useMemo, useState } from 'react';
import { syntaxStyleForToken } from '../settings/syntax';
import type { AppSettings } from '../settings/types';
import { snippetParts, type SnippetToken } from './snippetParts';
import { tokenizeSnippet } from './snippetTokenization';
import type { FileSearchResult } from './types';

export const HighlightedSnippet = memo(function HighlightedSnippet({ result, settings }: { result: FileSearchResult; settings: AppSettings }) {
  const [tokenized, setTokenized] = useState<{ result: FileSearchResult; tokens: readonly SnippetToken[] } | null>(null);
  useEffect(() => {
    if (!settings.editor.syntaxHighlight) return;
    let canceled = false;
    void tokenizeSnippet(result).then(tokens => {
      if (!canceled) setTokenized({ result, tokens });
    }).catch(() => { /* Keep readable text and matches if a language cannot load. */ });
    return () => { canceled = true; };
  }, [result, settings.editor.syntaxHighlight]);
  const parts = useMemo(() => snippetParts(result, tokenized?.result === result ? tokenized.tokens : []), [result, tokenized]);
  return <>{parts.map((part, index) => {
    if (part.match) return <mark key={index}>{part.text}</mark>;
    const style = syntaxStyleForToken(part.token, settings);
    return <span key={index} className="find-snippet-token" data-token={part.token} style={{ color: style.foreground, fontWeight: style.bold ? 700 : 400, fontStyle: style.italic ? 'italic' : 'normal' }}>{part.text}</span>;
  })}</>;
});
