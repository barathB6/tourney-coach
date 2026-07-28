import React from 'react';

// The origin story, on the front-facing page. Server-rendered (no 'use client')
// — the whole reveal is CSS scroll-driven animation, so this ships as static
// HTML: nothing to hydrate, and search engines read the full text.
//
// Every fact here is the founder's own; nothing is embellished. Keep it that
// way — this section's whole value is that it is true.
const PARAGRAPHS = [
  "Our founder co-organized the founding charity golf tournament for St. Michael's Catholic School in Mandeville, Louisiana. His son was one of 36 founding students.",
  "He isn't building for a market he studied from a distance. He's building for the job he actually did — every feature in this platform comes from that lived experience.",
];

// Stagger geometry, in percent of the container's trip through the viewport.
// Each word's fade begins slightly after the previous one and lasts WINDOW,
// so the sweep finishes before the block scrolls away.
const START = 12;
const SPREAD = 46;
const WINDOW = 16;

export default function OurStory() {
  const words = PARAGRAPHS.map((p) => p.split(' '));
  const total = words.reduce((n, p) => n + p.length, 0);
  let i = -1;

  return (
    <section
      aria-labelledby="our-story-heading"
      style={{ background: 'var(--cream)', padding: '96px 24px 120px', borderTop: '1px solid var(--line)' }}
    >
      <div className="tc-story" style={{ maxWidth: 720, margin: '0 auto' }}>
        <p style={{ fontSize: 12, fontWeight: 700, letterSpacing: 1.4, textTransform: 'uppercase', color: 'var(--primary)', margin: '0 0 10px', fontFamily: "'DM Sans', sans-serif" }}>
          The origin story
        </p>
        <h2
          id="our-story-heading"
          style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, fontSize: 'clamp(32px, 5vw, 46px)', lineHeight: 1.08, color: 'var(--deep-green)', margin: '0 0 28px' }}
        >
          Our Story
        </h2>

        {words.map((paragraph, pi) => (
          <p
            key={pi}
            style={{ fontFamily: "'DM Sans', sans-serif", fontSize: 'clamp(18px, 2.4vw, 23px)', lineHeight: 1.62, color: 'var(--ink)', margin: pi === 0 ? '0 0 22px' : 0 }}
          >
            {paragraph.map((word) => {
              i += 1;
              const s = START + (i / total) * SPREAD;
              return (
                <span
                  key={i}
                  className="tc-story-word"
                  style={{ '--s': `${s.toFixed(2)}%`, '--e': `${(s + WINDOW).toFixed(2)}%` } as React.CSSProperties}
                >
                  {word}{' '}
                </span>
              );
            })}
          </p>
        ))}

        <p style={{ fontFamily: "'DM Sans', sans-serif", fontSize: 14, lineHeight: 1.6, color: 'var(--ink)', opacity: 0.6, margin: '30px 0 0' }}>
          St. Michael&rsquo;s Catholic School &middot; Mandeville, Louisiana
        </p>
      </div>
    </section>
  );
}
