'use client';

import React, { useEffect, useState } from 'react';
import {
  TEE_LABELS, HOLE_SHAPE_TAGS, HOLE_SHAPE_TAG_LABELS, describeShapeTags,
  AVG_PAR_YARDAGES, type CourseHole, type Tee,
} from '@/lib/course';

// Shared by the organizer's Course Builder and the head pro's delegated
// editor — both edit the same course_holes rows, just through different
// auth paths, so the editing UI itself must not diverge between them.

export const cs = {
  card: { background: '#fff', border: '1px solid #E5E0D5', borderRadius: 14, padding: 20 },
  label: { fontSize: 12, fontWeight: 700, letterSpacing: '0.04em', color: '#6B7775', textTransform: 'uppercase' as const, display: 'block', marginBottom: 6 },
  input: { width: '100%', border: '1px solid #E5E0D5', borderRadius: 8, padding: '9px 11px', fontSize: 14, fontFamily: 'inherit', color: '#1A1F1C', boxSizing: 'border-box' as const },
};

const TEE_DOT_COLOR: Record<Tee, string> = { black: '#1A1F1C', blue: '#2C6E3F', white: '#fff', gold: '#C08A1E', red: '#B33A2E' };

export function TeeDot({ tee }: { tee: Tee }) {
  return <span style={{ width: 11, height: 11, borderRadius: '50%', background: TEE_DOT_COLOR[tee], border: tee === 'white' ? '1px solid #D8D2C2' : 'none', display: 'inline-block', flexShrink: 0 }} />;
}

// Fills every still-blank tee in `hole.teeYardages` with the most common
// yardage for `hole.par`, per tee — never touches a tee that already has a
// value. Returns the same object (no-op) when there's no par yet or nothing
// is missing, so callers can cheaply check for a change with !==.
export function withPrefilledYardages(hole: CourseHole, tees: Tee[]): CourseHole {
  if (!hole.par) return hole;
  const teeYardages = { ...hole.teeYardages };
  let changed = false;
  for (const t of tees) {
    if (teeYardages[t] == null) { teeYardages[t] = AVG_PAR_YARDAGES[hole.par as 3 | 4 | 5][t]; changed = true; }
  }
  return changed ? { ...hole, teeYardages } : hole;
}

// Read-only tee list, for anyone who can see a course profile but not edit it.
export function TeeDistances({ hole, tees }: { hole: CourseHole; tees: Tee[] }) {
  // Can't write yardages here, but a hole with a par set and nothing entered
  // yet can still show the common distance for that par as a labeled
  // estimate, instead of a bare dash.
  const display = withPrefilledYardages(hole, tees);
  return (
    <div style={cs.card}>
      <h3 style={{ fontFamily: "'Fraunces', serif", fontSize: 18, margin: '0 0 14px' }}>Hole {hole.holeNumber} — tee distances</h3>
      {tees.map((tee) => {
        const real = hole.teeYardages[tee];
        const estimated = display.teeYardages[tee];
        return (
          <div key={tee} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '9px 0', borderBottom: '1px solid #F1ECDD' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10, fontSize: 14, fontWeight: 600, width: 120 }}><TeeDot tee={tee} />{tee[0].toUpperCase() + tee.slice(1)}</span>
            <span style={{ fontSize: 13, color: '#6B7775', flex: 1 }}>{TEE_LABELS[tee]}</span>
            {real != null ? (
              <span style={{ fontSize: 15, fontWeight: 700 }}>{real} yds</span>
            ) : estimated != null ? (
              <span style={{ fontSize: 15, fontWeight: 700, color: '#9AA39D', fontStyle: 'italic' }} title="Estimated from this hole's par — not yet entered by the course">~{estimated} yds</span>
            ) : (
              <span style={{ fontSize: 15, fontWeight: 700 }}>— yds</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function HoleEditor({ hole, tees, onSave }: { hole: CourseHole; tees: Tee[]; onSave: (h: CourseHole) => void }) {
  // A hole that already has a par saved (however it got one — a prior par
  // click, or data loaded from the course) but blank yardages opens
  // pre-filled immediately, not just after the pro re-clicks its par button.
  const [local, setLocal] = useState<CourseHole>(() => withPrefilledYardages(hole, tees));
  function commit(next: CourseHole) { setLocal(next); onSave(next); }

  useEffect(() => {
    if (local !== hole) onSave(local); // persist the auto-prefill from initial state, once
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div style={cs.card}>
      <h3 style={{ fontFamily: "'Fraunces', serif", fontSize: 18, margin: '0 0 14px' }}>Hole {hole.holeNumber} — tee distances</h3>
      <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', marginBottom: 16 }}>
        <div>
          <label style={cs.label}>Par</label>
          <div style={{ display: 'flex', gap: 6 }}>
            {[3, 4, 5].map((p) => (
              <button key={p} onClick={() => commit(withPrefilledYardages({ ...local, par: p }, tees))} style={{
                width: 40, height: 36, borderRadius: 8, cursor: 'pointer', fontWeight: 700, fontSize: 14, fontFamily: 'inherit',
                border: local.par === p ? '1px solid #1B6B3A' : '1px solid #E5E0D5',
                background: local.par === p ? '#1B6B3A' : '#fff', color: local.par === p ? '#fff' : '#1A1F1C',
              }}>{p}</button>
            ))}
          </div>
        </div>
        <div style={{ width: 120 }}>
          <label style={cs.label}>Handicap (1–18)</label>
          <input type="number" min={1} max={18} style={cs.input} value={local.handicap ?? ''}
            onChange={(e) => setLocal({ ...local, handicap: e.target.value ? Number(e.target.value) : null })} onBlur={() => commit(local)} />
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
        {tees.map((tee) => (
          <div key={tee} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid #F1ECDD' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 14, fontWeight: 600, width: 92 }}><TeeDot tee={tee} />{tee[0].toUpperCase() + tee.slice(1)}</span>
            <span style={{ fontSize: 12, color: '#6B7775', flex: 1 }}>{TEE_LABELS[tee]}</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input type="number" style={{ ...cs.input, width: 90, textAlign: 'right' }} value={local.teeYardages[tee] ?? ''}
                onChange={(e) => setLocal({ ...local, teeYardages: { ...local.teeYardages, [tee]: e.target.value ? Number(e.target.value) : undefined } })} onBlur={() => commit(local)} />
              <span style={{ fontSize: 12, color: '#6B7775' }}>yds</span>
            </div>
          </div>
        ))}
      </div>

      <label style={cs.label}>Hole layout &amp; shape (optional)</label>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {HOLE_SHAPE_TAGS.map((tag) => {
          const active = local.shapeTags.includes(tag);
          return (
            <button
              key={tag}
              type="button"
              onClick={() => {
                const shapeTags = active ? local.shapeTags.filter((t) => t !== tag) : [...local.shapeTags, tag];
                commit({ ...local, shapeTags, description: describeShapeTags(shapeTags) });
              }}
              style={{
                borderRadius: 20, padding: '7px 14px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
                border: active ? '1px solid #1B6B3A' : '1px solid #E5E0D5',
                background: active ? '#E7F1EA' : '#fff', color: active ? '#1B6B3A' : '#1A1F1C',
              }}
            >
              {HOLE_SHAPE_TAG_LABELS[tag]}
            </button>
          );
        })}
      </div>
    </div>
  );
}
