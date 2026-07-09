'use client';

import { useRef } from 'react';

// A plain textarea with a tiny Bold / Italic / Bullet toolbar that wraps the
// current selection in markdown-lite syntax (**bold**, *italic*, "- " lines).
// Pairs with lib/richtext/render.tsx, which renders that same syntax back
// out on the microsite — no WYSIWYG, no new dependency, just enough
// formatting for a cause story to not read as a wall of plain text.
export default function FormattableTextarea({
  value,
  onChange,
  placeholder,
  rows = 3,
  className,
  style,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  rows?: number;
  className?: string;
  style?: React.CSSProperties;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);

  function wrapSelection(marker: string) {
    const el = ref.current;
    if (!el) return;
    const { selectionStart: start, selectionEnd: end } = el;
    const selected = value.slice(start, end) || 'text';
    const next = value.slice(0, start) + marker + selected + marker + value.slice(end);
    onChange(next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + marker.length, start + marker.length + selected.length);
    });
  }

  function toggleBullets() {
    const el = ref.current;
    if (!el) return;
    const { selectionStart: start, selectionEnd: end } = el;
    const before = value.slice(0, start);
    const selected = value.slice(start, end) || 'list item';
    const after = value.slice(end);
    const bulleted = selected.split('\n').map(l => l.startsWith('- ') ? l : `- ${l}`).join('\n');

    // A bullet block must sit on its own line(s) — the renderer only treats
    // a paragraph as a list when every line in it starts with "- ". Pad with
    // newlines so it doesn't merge into the surrounding sentence.
    const needsLeadingBreak = before.length > 0 && !before.endsWith('\n');
    const needsTrailingBreak = after.length > 0 && !after.startsWith('\n');
    const insert = (needsLeadingBreak ? '\n\n' : '') + bulleted + (needsTrailingBreak ? '\n\n' : '');

    const next = before + insert + after;
    onChange(next);
    requestAnimationFrame(() => {
      el.focus();
      const selStart = start + (needsLeadingBreak ? 2 : 0);
      el.setSelectionRange(selStart, selStart + bulleted.length);
    });
  }

  const btnStyle: React.CSSProperties = {
    border: '1px solid var(--line)', background: '#fff', borderRadius: 6,
    padding: '3px 9px', fontSize: 12.5, cursor: 'pointer', color: 'var(--ink)',
    fontFamily: "'DM Sans', sans-serif",
  };

  return (
    <div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
        <button type="button" onClick={() => wrapSelection('**')} style={{ ...btnStyle, fontWeight: 700 }} title="Bold">B</button>
        <button type="button" onClick={() => wrapSelection('*')} style={{ ...btnStyle, fontStyle: 'italic' }} title="Italic">i</button>
        <button type="button" onClick={toggleBullets} style={btnStyle} title="Bullet list">• List</button>
      </div>
      <textarea
        ref={ref}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        rows={rows}
        className={className}
        style={style}
      />
    </div>
  );
}
