import React from 'react';

// The origin story, on the front-facing page. Server-rendered (no 'use client')
// — the whole reveal is CSS scroll-driven animation, so this ships as static
// HTML: nothing to hydrate, and search engines read the full text.
//
// Every fact here is the founder's own; nothing is embellished. Keep it that
// way — this section's whole value is that it is true.
const PARAGRAPHS = [
  "Our founder co-organized the founding charity golf tournament for St. Michael's Catholic School in Mandeville, Louisiana. His son was one of 36 founding students.",
  "Every feature in this platform comes from that lived experience.",
];

// Stagger geometry, in percent of the wrapper's trip through the viewport
// ("cover": from the wrapper first entering the viewport to it fully
// exiting). Because .tc-story-wrap is the last thing on the page, that 100%
// endpoint is never actually reachable by scrolling — there's no more page
// below it to scroll into, so the browser runs out of room first. With the
// wrapper's height set in vh (240vh) against a 100vh sticky viewport, the
// reachable ceiling is a fixed wrapperVh / (wrapperVh + 100) ≈ 70.6% of the
// cover range, on any screen (both numbers scale with vh identically). Every
// word's end point (START + SPREAD + WINDOW, for the last word) must stay
// safely under that ceiling or its fade can never finish — keep meaningful
// headroom below 70% here.
const START = 6;
const SPREAD = 48;
const WINDOW = 10;

export default function OurStory() {
  const words = PARAGRAPHS.map((p) => p.split(' '));
  const total = words.reduce((n, p) => n + p.length, 0);
  // Each paragraph's starting position in the flat word sequence, computed
  // up front in one pass — a lookup instead of a counter mutated inside the
  // list-rendering callback below (React flags mutating render-scoped state
  // from within a .map() that returns elements as unsafe under concurrent
  // rendering).
  const paragraphOffsets: number[] = [];
  words.reduce((runningTotal, paragraph) => {
    paragraphOffsets.push(runningTotal);
    return runningTotal + paragraph.length;
  }, 0);

  return (
    <section aria-labelledby="our-story-heading" className="tc-story-wrap" style={{ background: 'var(--cream)', borderTop: '1px solid var(--line)' }}>
      {/*
        Pinned scroll-reveal ("scrollytelling"): .tc-story-wrap reserves a
        generous, EXPLICIT scroll distance (set in CSS, not derived from
        content height) so the reveal always has real scroll room to play
        out, on any screen. .tc-story-sticky pins the actual text in place —
        it visually holds still on screen — while the wrapper scrolls behind
        it and the words light up in step with the wheel. Without a tall,
        deliberate wrapper the block would transit the viewport in a moment
        and the animation would blow through its own range almost instantly,
        reading as frozen/broken rather than something you scroll through.
      */}
      <div className="tc-story-sticky">
        <div className="tc-story" style={{ maxWidth: 720, margin: '0 auto', width: '100%', padding: '0 24px' }}>
          <p style={{ fontSize: 12, fontWeight: 700, letterSpacing: 1.4, textTransform: 'uppercase', color: 'var(--primary)', margin: '0 0 10px', fontFamily: "'DM Sans', sans-serif" }}>
            The origin story
          </p>
          <h2
            id="our-story-heading"
            style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, fontSize: 'clamp(32px, 5vw, 46px)', lineHeight: 1.08, color: 'var(--deep-green)', margin: '0 0 28px' }}
          >
            Origin Story
          </h2>

          {words.map((paragraph, pi) => (
            <p
              key={pi}
              style={{ fontFamily: "'DM Sans', sans-serif", fontSize: 'clamp(18px, 2.4vw, 23px)', lineHeight: 1.62, color: 'var(--ink)', margin: pi === 0 ? '0 0 22px' : 0 }}
            >
              {paragraph.map((word, wi) => {
                const i = paragraphOffsets[pi] + wi;
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
        </div>
      </div>
    </section>
  );
}
