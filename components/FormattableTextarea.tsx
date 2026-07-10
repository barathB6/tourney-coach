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
    const before = value.slice(0, start);
    const after = value.slice(end);
    const selected = value.slice(start, end);

    // Toggle off: clicking again on a selection that's already wrapped by
    // this marker (the common case right after inserting it, since the new
    // text stays selected) removes the markers instead of nesting a second
    // pair — otherwise repeated clicks stack into "****text****".
    if (selected && before.endsWith(marker) && after.startsWith(marker)) {
      const newBefore = before.slice(0, -marker.length);
      onChange(newBefore + selected + after.slice(marker.length));
      requestAnimationFrame(() => {
        el.focus();
        el.setSelectionRange(newBefore.length, newBefore.length + selected.length);
      });
      return;
    }

    const text = selected || 'text';
    // Placeholder insertions (no selection) shouldn't glue onto an adjacent
    // word — "assistance**text**" reads as one run-on word.
    const needsLeadingSpace = !selected && before.length > 0 && !/\s$/.test(before);
    const needsTrailingSpace = !selected && after.length > 0 && !/^\s/.test(after);
    const insert = (needsLeadingSpace ? ' ' : '') + marker + text + marker + (needsTrailingSpace ? ' ' : '');

    onChange(before + insert + after);
    const selStart = start + (needsLeadingSpace ? 1 : 0) + marker.length;
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(selStart, selStart + text.length);
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
