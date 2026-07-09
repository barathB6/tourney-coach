import type { ReactNode } from 'react';

// Lightweight markdown-lite: **bold**, *italic*, "- " bullet lists, and
// blank-line-separated paragraphs. Deliberately not full markdown and never
// uses dangerouslySetInnerHTML — output is plain React elements built from
// the input text, so there's no HTML-injection surface even though organizers
// can type freely into the story fields.
// Exported for single-line contexts (headings, labels) where wrapping output
// in block elements (<p>/<ul>) would be invalid HTML — bold/italic only, no
// paragraphs or lists.
export function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const tokens = text.split(/(\*\*[^*]+\*\*|\*[^*]+\*)/g).filter(Boolean);
  return tokens.map((tok, i) => {
    if (tok.startsWith('**') && tok.endsWith('**')) {
      return <strong key={`${keyPrefix}-${i}`}>{tok.slice(2, -2)}</strong>;
    }
    if (tok.startsWith('*') && tok.endsWith('*')) {
      return <em key={`${keyPrefix}-${i}`}>{tok.slice(1, -1)}</em>;
    }
    return tok;
  });
}

export function renderRichText(text: string): ReactNode[] {
  const blocks = text.trim().split(/\n\s*\n/);

  return blocks.map((block, bi) => {
    const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
    const isList = lines.length > 0 && lines.every(l => l.startsWith('- '));

    if (isList) {
      return (
        <ul key={bi} style={{ margin: '0 0 1em', paddingLeft: 22 }}>
          {lines.map((line, li) => (
            <li key={li} style={{ marginBottom: 6 }}>{renderInline(line.slice(2), `${bi}-${li}`)}</li>
          ))}
        </ul>
      );
    }

    return (
      <p key={bi} style={{ margin: bi < blocks.length - 1 ? '0 0 1em' : 0 }}>
        {renderInline(block, `${bi}`)}
      </p>
    );
  });
}
