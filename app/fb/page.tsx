'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabaseClient';
import { authedFetch } from '@/lib/authedFetch';
import { pluralUnit } from '@/lib/fb/calculator';
import { formatEventTime } from '@/lib/formatEventDate';

type Line = {
  key: string; label: string; units: number; packs: number; packUnit: string;
  packSize: number; packedUnits: number; perPlayer: number; basePerPlayer: number; weatherFactor: number;
};
type PrepStep = { offsetMinutes: number; at: string | null; label: string; detail: string };
type Plan = {
  inputs: { playerCount: number; volunteerCount: number; guestCount: number; holes: number; temperatureF: number; precipChance: number | null };
  heat: number; rain: number; lines: Line[];
  lunch: { attendees: number; portions: number; vegetarianPortions: number; standardPortions: number; menu: string[] };
  prep: PrepStep[]; warnings: string[];
};
type FbRecord = {
  tournamentId: string; tournamentName: string | null; eventDate: string | null;
  shotgunTime: string | null; livePlayerCount: number; lockedPlayerCount: number | null;
  headcountLockedAt: string | null; handedOffAt: string | null;
  volunteerCount: number; guestCount: number; holes: number;
  weather: { temperatureF: number | null; precipChance: number | null; source: string | null; summary: string | null; fetchedAt: string | null };
  baselines: Record<string, number>; menu: string[]; plan: Plan | null; hasCoordinates: boolean;
  weatherError?: string;
};
type Prospect = {
  id: string; company: string | null; contactName: string | null; email: string | null;
  category: string | null; categoryLabel: string | null; status: string; askSummary: string | null;
  draftSubject: string | null; draftBody: string | null; sentAt: string | null; followUpCount: number;
  openedAt: string | null; emailOpens: number; respondedAt: string | null; replySnippet: string | null;
  committedValueCents: number | null; nextFollowUpAt: string | null;
};
type Donations = {
  prospects: Prospect[];
  summary: {
    total: number; sent: number; opened: number; responded: number; committed: number; declined: number;
    committedValueCents: number;
    uncovered: { key: string; label: string; covers: string; suggestedProspects: number }[];
  };
  asks: { key: string; label: string; short: string; emoji: string; covers: string; ask: string | null; suggestedProspects: number }[];
  hasFbPlan: boolean;
  scripts: {
    category: string; label: string; emoji: string; whoToAsk: string; whenToCall: string;
    lines: { step: string; say: string; note?: string }[];
    objections: { objection: string; response: string }[];
  }[];
  donorWall: {
    groups: { key: string; label: string; emoji: string; donors: { name: string; detail: string | null }[] }[];
    total: number; inline: string; plainText: string; uncategorised: string[];
  };
  charity: { legalName: string | null; ein: string | null; address: string | null; benefits: string | null; complete: boolean };
  sendError?: string;
};

// The outreach funnel, in order. Colour carries the same meaning as the
// volunteer roster: green is resolved-good, red is resolved-bad, amber is
// waiting on someone else.
const PILL: Record<string, { label: string; fg: string; bg: string }> = {
  prospect:  { label: 'Not contacted', fg: '#5C6B62', bg: '#EFEAE0' },
  sent:      { label: 'Sent',          fg: '#8A6D1F', bg: '#FBF0DC' },
  opened:    { label: 'Opened',        fg: '#8A6D1F', bg: '#FBF0DC' },
  responded: { label: 'Responded',     fg: '#1B6B3A', bg: '#E7F1EA' },
  committed: { label: 'Committed',     fg: '#1B6B3A', bg: '#E7F1EA' },
  declined:  { label: 'Declined',      fg: '#B8442C', bg: '#FBE9E7' },
};

const CONSUMABLES = ['beer', 'water', 'soft_drinks', 'sports_drinks', 'snacks'];
const CONSUMABLE_LABEL: Record<string, string> = {
  beer: 'Beer', water: 'Water', soft_drinks: 'Soft drinks', sports_drinks: 'Sports drinks', snacks: 'Snacks',
};

// Schedule instants are wall-clock at the course — always formatted in UTC.
// See lib/formatEventDate.ts.
const time = formatEventTime;
const day = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—';

export default function FbPage() {
  const router = useRouter();
  const [tid, setTid] = useState<string | null>(null);
  const [fb, setFb] = useState<FbRecord | null>(null);
  const [don, setDon] = useState<Donations | null>(null);
  const [tab, setTab] = useState<'plan' | 'kitchen' | 'donations'>('plan');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [showAssumptions, setShowAssumptions] = useState(false);
  const [manualTemp, setManualTemp] = useState('');
  const [menuText, setMenuText] = useState('');
  const [openProspect, setOpenProspect] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<{ subject: string; body: string }>({ subject: '', body: '' });
  const [newProspect, setNewProspect] = useState({ company: '', contactName: '', email: '', category: '' });
  // Module 09's three chips, plus the prospect roster they act on.
  const [tool, setTool] = useState<'prospects' | 'scripts' | 'letters' | 'wall'>('prospects');
  const [taxLetter, setTaxLetter] = useState<{ letter: { subject: string; body: string; missing: string[] }; disclaimer: string } | null>(null);
  const [charity, setCharity] = useState({ charityLegalName: '', charityEin: '', charityAddress: '', donorBenefits: '' });
  // The URL-sync effect must not run before the deep link has been read, or it
  // races the async read and strips ?tab= off the address on first paint.
  const [linkRead, setLinkRead] = useState(false);

  const load = useCallback(async (id: string) => {
    const [f, d] = await Promise.all([
      authedFetch(`/api/tournament/${id}/fb`),
      authedFetch(`/api/tournament/${id}/donations`),
    ]);
    const fj = await f.json().catch(() => ({}));
    const dj = await d.json().catch(() => ({}));
    if (f.ok) { setFb(fj as FbRecord); setMenuText(((fj as FbRecord).menu ?? []).join('\n')); setError(''); }
    else setError(fj.error || 'Could not load the F&B plan');
    if (d.ok) {
      const snap = dj as Donations;
      setDon(snap);
      setCharity({
        charityLegalName: snap.charity?.legalName ?? '',
        charityEin: snap.charity?.ein ?? '',
        charityAddress: snap.charity?.address ?? '',
        donorBenefits: snap.charity?.benefits ?? '',
      });
    }
  }, []);

  // Keep the URL in step with the tab so a view can be linked to or reloaded.
  useEffect(() => {
    if (!linkRead) return;
    const url = new URL(window.location.href);
    if (tab === 'plan') url.searchParams.delete('tab'); else url.searchParams.set('tab', tab);
    if (tab === 'donations' && tool !== 'prospects') url.searchParams.set('tool', tool);
    else url.searchParams.delete('tool');
    window.history.replaceState(null, '', url.toString());
  }, [tab, tool, linkRead]);

  useEffect(() => {
    // Deep link: /fb opens the calculator, /fb?tab=donations opens Module 09.
    // Read off window.location rather than useSearchParams, which would push
    // this client component behind a Suspense boundary for no benefit — and
    // done inside this async callback rather than its own effect, so it isn't
    // a synchronous setState during an effect.
    supabase.auth.getUser().then(async ({ data: { user } }) => {
      const params = new URLSearchParams(window.location.search);
      const q = params.get('tab');
      if (q === 'donations' || q === 'kitchen' || q === 'plan') setTab(q);
      const toolParam = params.get('tool');
      if (toolParam === 'scripts' || toolParam === 'letters' || toolParam === 'wall' || toolParam === 'prospects') setTool(toolParam);
      setLinkRead(true);

      if (!user) { router.replace('/sign-in?next=/fb'); return; }
      let selected: string | null = null;
      try { selected = localStorage.getItem(`tourney_selected_tournament_${user.id}`); } catch { /* ignore */ }
      const { data: all } = await supabase.from('tournaments').select('id, name')
        .eq('organizer_id', user.id).order('created_at', { ascending: false });
      const list = all ?? [];
      const t = list.find((x) => x.id === selected) ?? list[0] ?? null;
      if (!t) { setLoading(false); return; }
      setTid(t.id);
      await load(t.id);
      setLoading(false);
    });
  }, [router, load]);

  async function patchFb(body: Record<string, unknown>) {
    if (!tid || busy) return;
    setBusy(true); setError(''); setNote('');
    const res = await authedFetch(`/api/tournament/${tid}/fb`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const d = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) { setError(d.error || 'Could not save that'); return; }
    setFb(d as FbRecord);
  }

  async function postFb(action: string) {
    if (!tid || busy) return;
    setBusy(true); setError(''); setNote('');
    const res = await authedFetch(`/api/tournament/${tid}/fb`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }),
    });
    const d = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) { setError(d.error || 'That did not work'); return; }
    setFb(d as FbRecord);
    if (d.weatherError) setError(d.weatherError);
    else if (action === 'weather') setNote('Weather updated.');
    else if (action === 'handoff') setNote(`Kitchen sheet sent to ${d.handoff?.to ?? 'the course'}.`);
    if (action === 'lock' || action === 'handoff') await load(tid);
  }

  async function patchDon(body: Record<string, unknown>) {
    if (!tid || busy) return;
    setBusy(true); setError(''); setNote('');
    const res = await authedFetch(`/api/tournament/${tid}/donations`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const d = await res.json().catch(() => ({}));
    setBusy(false);
    if (d.prospects) setDon(d as Donations);
    if (!res.ok) { setError(d.error || d.sendError || 'That did not work'); return; }
    if (d.draft) { setEditDraft({ subject: d.draft.subject, body: d.draft.body }); setNote('Draft ready — read it before sending.'); }
    if (d.sent) { setNote('Sent.'); setOpenProspect(null); }
    if (d.taxLetter) setTaxLetter(d.taxLetter);
  }

  async function saveCharity() {
    if (!tid || busy) return;
    setBusy(true); setError(''); setNote('');
    const res = await authedFetch(`/api/tournament/${tid}/donations`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(charity),
    });
    const d = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) { setError(d.error || 'Could not save the charity details'); return; }
    setDon(d as Donations);
    setNote('Charity details saved.');
  }

  async function addProspect() {
    if (!tid || busy) return;
    setBusy(true); setError(''); setNote('');
    const res = await authedFetch(`/api/tournament/${tid}/donations`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(newProspect),
    });
    const d = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) { setError(d.error || 'Could not add that prospect'); return; }
    setDon(d as Donations);
    setNewProspect({ company: '', contactName: '', email: '', category: '' });
  }

  if (loading) return <main style={S.wrap}><p style={{ color: '#8A9089' }}>Loading…</p></main>;
  if (!tid) return <main style={S.wrap}><p>Create a tournament first.</p></main>;

  const plan = fb?.plan ?? null;
  const locked = !!fb?.headcountLockedAt;
  const drift = locked && fb ? fb.livePlayerCount - (fb.lockedPlayerCount ?? 0) : 0;

  return (
    <main style={S.wrap}>
      <button onClick={() => router.push('/dashboard')} style={S.back}>← Dashboard</button>

      <header style={{ margin: '14px 0 18px' }}>
        <p style={S.kick}>Module 07</p>
        <h1 style={{ fontSize: 30, margin: '4px 0 6px', fontFamily: "'Fraunces', serif" }}>F&amp;B Planner</h1>
        <p style={{ color: '#5C6B62', fontSize: 15, lineHeight: 1.6, margin: 0, maxWidth: 640 }}>
          Weather-adjusted quantity calculator. {plan ? `${plan.inputs.playerCount} players × ${Math.round(plan.inputs.temperatureF)}°F` : '96 players × hot day'} = more cold drinks.
          Kitchen prep timing built in.
        </p>
        <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
          <span style={S.chip}>Weather data</span>
          <span style={S.chip}>Headcount lock</span>
          <span style={S.chip}>Kitchen handoff</span>
        </div>
      </header>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        {([['plan', 'Quantities'], ['kitchen', 'Kitchen timing'], ['donations', 'Vendor donations']] as const).map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)} style={{ ...S.mini, ...(tab === k ? S.miniOn : {}) }}>{label}</button>
        ))}
      </div>

      {error && <p style={S.error}>{error}</p>}
      {note && <p style={S.note}>{note}</p>}

      {/* ── Quantities ─────────────────────────────────────────────────── */}
      {tab === 'plan' && fb && (
        <>
          <section style={{ ...S.card, marginBottom: 14 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
              <div>
                <p style={S.kick}>Headcount</p>
                <p style={{ fontSize: 26, fontWeight: 700, margin: '4px 0 0', fontFamily: "'Fraunces', serif" }}>
                  {locked ? fb.lockedPlayerCount : fb.livePlayerCount} players
                </p>
                <p style={{ fontSize: 13, color: '#5C6B62', margin: '4px 0 0' }}>
                  {locked
                    ? <>Locked {day(fb.headcountLockedAt)}. {drift === 0 ? 'Registrations match.' : <strong style={{ color: '#B8442C' }}>{drift > 0 ? `${drift} more` : `${-drift} fewer`} since — unlock to re-plan.</strong>}</>
                    : 'Tracking registrations live. Lock it before you order.'}
                </p>
              </div>
              <button onClick={() => postFb(locked ? 'unlock' : 'lock')} disabled={busy} style={locked ? S.mini : S.btn}>
                {locked ? 'Unlock headcount' : 'Lock headcount'}
              </button>
            </div>

            <div style={{ display: 'flex', gap: 14, marginTop: 16, flexWrap: 'wrap' }}>
              <label style={S.field}><span style={S.label}>Volunteers</span>
                <input type="number" min={0} defaultValue={fb.volunteerCount} disabled={locked} style={S.input}
                  onBlur={(e) => patchFb({ volunteerCount: Number(e.target.value) })} /></label>
              <label style={S.field}><span style={S.label}>Non-playing guests</span>
                <input type="number" min={0} defaultValue={fb.guestCount} disabled={locked} style={S.input}
                  onBlur={(e) => patchFb({ guestCount: Number(e.target.value) })} /></label>
              <label style={S.field}><span style={S.label}>Holes</span>
                <select value={fb.holes} disabled={locked} style={S.input}
                  onChange={(e) => patchFb({ holes: Number(e.target.value) })}>
                  <option value={18}>18</option><option value={9}>9</option>
                </select></label>
            </div>
          </section>

          <section style={{ ...S.card, marginBottom: 14 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 240 }}>
                <p style={S.kick}>Weather</p>
                {fb.weather.temperatureF != null ? (
                  <>
                    <p style={{ fontSize: 22, fontWeight: 700, margin: '4px 0 0', fontFamily: "'Fraunces', serif" }}>
                      {Math.round(fb.weather.temperatureF)}°F
                      {fb.weather.precipChance != null && <span style={{ fontSize: 15, color: '#5C6B62', fontWeight: 500 }}> · {fb.weather.precipChance}% rain</span>}
                    </p>
                    <p style={{ fontSize: 13, color: fb.weather.source === 'normals' ? '#8A6D1F' : '#5C6B62', margin: '4px 0 0', lineHeight: 1.55 }}>
                      {fb.weather.summary}
                    </p>
                  </>
                ) : (
                  <p style={{ fontSize: 14, color: '#5C6B62', margin: '4px 0 0' }}>
                    No temperature yet — the calculator needs one before it can plan anything.
                  </p>
                )}
              </div>
              <button onClick={() => postFb('weather')} disabled={busy || locked} style={S.mini}>Fetch forecast</button>
            </div>
            {!locked && (
              <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', marginTop: 14, flexWrap: 'wrap' }}>
                <label style={{ ...S.field, maxWidth: 160 }}><span style={S.label}>Or set it by hand (°F)</span>
                  <input type="number" value={manualTemp} onChange={(e) => setManualTemp(e.target.value)} style={S.input} /></label>
                <button disabled={busy || manualTemp === ''} style={S.mini}
                  onClick={() => { patchFb({ temperatureF: Number(manualTemp) }); setManualTemp(''); }}>Use this</button>
              </div>
            )}
          </section>

          {plan ? (
            <section style={{ ...S.card, marginBottom: 14 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
                <p style={S.kick}>Order</p>
                <button onClick={() => setShowAssumptions((v) => !v)} style={S.link}>
                  {showAssumptions ? 'Hide assumptions' : 'Show assumptions'}
                </button>
              </div>
              {plan.lines.map((l) => (
                <div key={l.key} style={S.line}>
                  <div style={{ flex: 1, minWidth: 130 }}>
                    <strong style={{ fontSize: 15 }}>{l.label}</strong>
                    <span style={{ color: '#8A9089', fontSize: 12.5, marginLeft: 8 }}>
                      {l.perPlayer.toFixed(1)}/player
                      {Math.abs(l.weatherFactor - 1) >= 0.005 && (
                        <span style={{ color: l.weatherFactor > 1 ? '#B8442C' : '#5C6B62' }}>
                          {' '}· {l.weatherFactor > 1 ? '+' : ''}{Math.round((l.weatherFactor - 1) * 100)}% for weather
                        </span>
                      )}
                    </span>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <strong style={{ fontSize: 16 }}>{l.packs} {pluralUnit(l.packUnit, l.packs)}</strong>
                    <span style={{ color: '#8A9089', fontSize: 12.5, marginLeft: 8 }}>{l.packedUnits} servings</span>
                  </div>
                </div>
              ))}
              <div style={{ ...S.line, borderBottom: 'none' }}>
                <div style={{ flex: 1 }}>
                  <strong style={{ fontSize: 15 }}>Awards lunch</strong>
                  <span style={{ color: '#8A9089', fontSize: 12.5, marginLeft: 8 }}>
                    {plan.lunch.attendees} attending · {plan.lunch.vegetarianPortions} vegetarian
                  </span>
                </div>
                <strong style={{ fontSize: 16 }}>{plan.lunch.portions} portions</strong>
              </div>

              {showAssumptions && (
                <div style={S.assume}>
                  <p style={{ fontSize: 13, color: '#5C6B62', margin: '0 0 10px', lineHeight: 1.6 }}>
                    Servings per player at 75°F, before weather. Edit any of these and the order recalculates.
                  </p>
                  {CONSUMABLES.map((k) => (
                    <label key={k} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
                      <span style={{ flex: 1, fontSize: 13.5 }}>{CONSUMABLE_LABEL[k]}</span>
                      <input type="number" step="0.25" min={0} disabled={locked} defaultValue={fb.baselines[k]}
                        style={{ ...S.input, width: 90 }}
                        onBlur={(e) => patchFb({ baselines: { ...fb.baselines, [k]: Number(e.target.value) } })} />
                    </label>
                  ))}
                </div>
              )}

              {plan.warnings.map((w, i) => <p key={i} style={S.warn}>{w}</p>)}
            </section>
          ) : (
            <section style={{ ...S.card, marginBottom: 14 }}>
              <p style={{ margin: 0, color: '#5C6B62', fontSize: 14.5, lineHeight: 1.6 }}>
                Fetch a forecast or enter a temperature to see quantities. We don&apos;t guess a
                default and label the result &ldquo;weather-adjusted&rdquo; — that would be worse than showing nothing.
              </p>
            </section>
          )}
        </>
      )}

      {/* ── Kitchen timing ─────────────────────────────────────────────── */}
      {tab === 'kitchen' && fb && (
        <section style={S.card}>
          <p style={S.kick}>Day-of timeline</p>
          {plan ? (
            <>
              {plan.prep.map((s, i) => (
                <div key={i} style={{ display: 'flex', gap: 14, padding: '11px 0', borderBottom: i === plan.prep.length - 1 ? 'none' : '1px solid var(--line)' }}>
                  <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 700, fontSize: 14, minWidth: 66, color: s.offsetMinutes === 0 ? 'var(--primary)' : '#1A1F1C' }}>
                    {time(s.at)}
                  </span>
                  <span style={{ flex: 1 }}>
                    <strong style={{ fontSize: 14.5, display: 'block' }}>{s.label}</strong>
                    <span style={{ fontSize: 13, color: '#8A9089', lineHeight: 1.55 }}>{s.detail}</span>
                  </span>
                </div>
              ))}
              <div style={{ marginTop: 18, paddingTop: 16, borderTop: '1px solid var(--line)' }}>
                <label style={{ display: 'block', marginBottom: 10 }}>
                  <span style={S.label}>Awards lunch menu — one dish per line</span>
                  <textarea value={menuText} disabled={locked} rows={3} style={{ ...S.input, resize: 'vertical' }}
                    onChange={(e) => setMenuText(e.target.value)}
                    onBlur={() => patchFb({ menu: menuText.split('\n').map((m) => m.trim()).filter(Boolean) })} />
                </label>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                  <button onClick={() => postFb('handoff')} disabled={busy || !locked} style={S.btn}>
                    Send the kitchen sheet
                  </button>
                  <span style={{ fontSize: 13, color: '#8A9089' }}>
                    {fb.handedOffAt ? `Last sent ${day(fb.handedOffAt)}.`
                      : locked ? 'Goes to the course’s contact email.'
                      : 'Lock the headcount first.'}
                  </span>
                </div>
              </div>
            </>
          ) : <p style={{ color: '#5C6B62', fontSize: 14.5, margin: 0 }}>Set a headcount and a temperature first.</p>}
        </section>
      )}

      {/* ── Vendor donations ───────────────────────────────────────────── */}
      {tab === 'donations' && don && (
        <>
          {/* The donations half is its own module — give it its own identity
              rather than leaving it looking like a subsection of the calculator. */}
          <header style={{ margin: '0 0 16px' }}>
            <p style={S.kick}>Module 09</p>
            <h2 style={{ fontSize: 24, margin: '4px 0 6px', fontFamily: "'Fraunces', serif" }}>Donation Solicitation</h2>
            <p style={{ color: '#5C6B62', fontSize: 14.5, lineHeight: 1.6, margin: 0, maxWidth: 620 }}>
              Pre-written outreach scripts for beverage distributors and food vendors.
              The three calls every charity tournament needs to make.
            </p>
          </header>

          <section style={{ ...S.card, marginBottom: 14 }}>
            <p style={S.kick}>Outreach</p>
            <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', marginTop: 8 }}>
              {([['Prospects', don.summary.total], ['Sent', don.summary.sent], ['Opened', don.summary.opened],
                 ['Responded', don.summary.responded], ['Committed', don.summary.committed], ['Declined', don.summary.declined]] as const).map(([l, v]) => (
                <div key={l}><p style={{ fontSize: 22, fontWeight: 700, margin: 0, fontFamily: "'Fraunces', serif" }}>{v}</p>
                  <p style={{ fontSize: 12.5, color: '#8A9089', margin: 0 }}>{l}</p></div>
              ))}
            </div>
            {!don.hasFbPlan && (
              <p style={S.warn}>No F&amp;B plan yet, so asks will be vague. Set a headcount and temperature and every email gets a real quantity in it.</p>
            )}
          </section>

          <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
            {([['prospects', 'Prospects'], ['scripts', 'Distributor scripts'],
               ['letters', 'Tax letters'], ['wall', 'Donor wall']] as const).map(([k, label]) => (
              <button key={k} onClick={() => setTool(k)} style={{ ...S.mini, ...(tool === k ? S.miniOn : {}) }}>{label}</button>
            ))}
          </div>

          {tool === 'prospects' && (
          <section style={{ ...S.card, marginBottom: 14 }}>
            <p style={S.kick}>What to ask for</p>
            {don.asks.map((a) => (
              <div key={a.key} style={{ padding: '10px 0', borderBottom: '1px solid var(--line)' }}>
                <strong style={{ fontSize: 14.5 }}>{a.emoji} {a.label}</strong>
                <span style={{ color: '#8A9089', fontSize: 12.5, marginLeft: 8 }}>line up {a.suggestedProspects}</span>
                <p style={{ margin: '3px 0 0', fontSize: 13.5, color: a.ask ? '#1B6B3A' : '#8A9089', lineHeight: 1.55 }}>
                  {a.ask ?? `No quantity yet — ${a.covers.toLowerCase()}`}
                </p>
              </div>
            ))}
          </section>
          )}

          {/* ── Distributor scripts ─────────────────────────────────────── */}
          {tool === 'scripts' && (
            <>
              <p style={{ fontSize: 14, color: '#5C6B62', lineHeight: 1.6, margin: '0 0 14px' }}>
                The first three are the calls every charity tournament needs to make — the biggest
                line items and the ones most likely to say yes. Quantities come from your F&amp;B plan,
                so the number you say on the phone matches the number in the email.
              </p>
              {don.scripts.map((s, i) => (
                <section key={s.category} style={{ ...S.card, marginBottom: 10, borderColor: i < 3 ? 'var(--primary)' : 'var(--line)' }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
                    {i < 3 && <span style={{ ...S.pill, color: '#1B6B3A', background: '#E7F1EA' }}>Call {i + 1}</span>}
                    <strong style={{ fontSize: 16 }}>{s.emoji} {s.label}</strong>
                  </div>
                  <p style={{ fontSize: 13, color: '#5C6B62', margin: '0 0 4px', lineHeight: 1.55 }}>{s.whoToAsk}</p>
                  <p style={{ fontSize: 13, color: '#5C6B62', margin: '0 0 12px', lineHeight: 1.55 }}>{s.whenToCall}</p>
                  {s.lines.map((l, j) => (
                    <div key={j} style={{ padding: '9px 0', borderTop: '1px solid var(--line)' }}>
                      <span style={{ ...S.kick, display: 'block', marginBottom: 3 }}>{l.step}</span>
                      <p style={{ margin: 0, fontSize: 14.5, lineHeight: 1.6 }}>{l.say}</p>
                      {l.note && <p style={{ margin: '4px 0 0', fontSize: 12.5, color: '#8A6D1F', lineHeight: 1.55 }}>{l.note}</p>}
                    </div>
                  ))}
                  {s.objections.length > 0 && (
                    <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--line)' }}>
                      <span style={{ ...S.kick, display: 'block', marginBottom: 6 }}>If they say…</span>
                      {s.objections.map((o, j) => (
                        <div key={j} style={{ marginBottom: 8 }}>
                          <p style={{ margin: 0, fontSize: 13.5, color: '#5C6B62' }}>{o.objection}</p>
                          <p style={{ margin: '2px 0 0', fontSize: 13.5, lineHeight: 1.6 }}>{o.response}</p>
                        </div>
                      ))}
                    </div>
                  )}
                </section>
              ))}
            </>
          )}

          {/* ── Tax letters ─────────────────────────────────────────────── */}
          {tool === 'letters' && (
            <>
              <section style={{ ...S.card, marginBottom: 14 }}>
                <p style={S.kick}>Charity details</p>
                <p style={{ fontSize: 13.5, color: '#5C6B62', lineHeight: 1.6, margin: '6px 0 12px' }}>
                  The letter needs the 501(c)(3)&apos;s <em>legal</em> name and EIN — not the tournament&apos;s name.
                </p>
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                  <input placeholder="Charity legal name" style={{ ...S.input, flex: '1 1 220px' }}
                    value={charity.charityLegalName} onChange={(e) => setCharity({ ...charity, charityLegalName: e.target.value })} />
                  <input placeholder="EIN (12-3456789)" style={{ ...S.input, flex: '1 1 140px' }}
                    value={charity.charityEin} onChange={(e) => setCharity({ ...charity, charityEin: e.target.value })} />
                  <input placeholder="Charity mailing address" style={{ ...S.input, flex: '1 1 100%' }}
                    value={charity.charityAddress} onChange={(e) => setCharity({ ...charity, charityAddress: e.target.value })} />
                  <input placeholder="What donors get in return (signage, podium mention…)" style={{ ...S.input, flex: '1 1 100%' }}
                    value={charity.donorBenefits} onChange={(e) => setCharity({ ...charity, donorBenefits: e.target.value })} />
                  <button onClick={saveCharity} disabled={busy} style={S.btn}>Save</button>
                </div>
              </section>

              <p style={S.warn}>
                This produces a formatted acknowledgement, not tax advice. It deliberately states no
                dollar value for donated goods — valuing them is the donor&apos;s job, not the charity&apos;s.
                Have your treasurer approve the template once before the first one goes out.
              </p>

              {don.summary.committed === 0 ? (
                <p style={{ color: '#8A9089', fontSize: 14, marginTop: 14 }}>
                  No committed donations yet. Letters become available once a vendor is marked committed.
                </p>
              ) : (
                <div style={{ marginTop: 14 }}>
                  {don.prospects.filter((p) => p.status === 'committed').map((p) => (
                    <div key={p.id} style={{ marginBottom: 8 }}>
                      <button style={{ ...S.row, borderRadius: 12 }} disabled={busy}
                        onClick={() => patchDon({ prospectId: p.id, action: 'tax_letter' })}>
                        <span style={{ flex: 1 }}>
                          <strong style={{ fontSize: 15 }}>{p.company}</strong>
                          <span style={{ color: '#8A9089', fontSize: 13 }}> · {p.askSummary ?? 'donation'}</span>
                        </span>
                        <span style={{ ...S.pill, color: '#1B6B3A', background: '#E7F1EA' }}>Write letter</span>
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {taxLetter && (
                <section style={{ ...S.card, marginTop: 14 }}>
                  <p style={S.kick}>{taxLetter.letter.subject}</p>
                  {taxLetter.letter.missing.length > 0 && (
                    <p style={S.warn}>Fill in {taxLetter.letter.missing.join(', ')} — the placeholders below are not usable as-is.</p>
                  )}
                  <textarea readOnly value={taxLetter.letter.body} rows={26}
                    style={{ ...S.input, marginTop: 10, resize: 'vertical', fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12.5, lineHeight: 1.6 }} />
                  <button style={{ ...S.mini, marginTop: 8 }}
                    onClick={() => { navigator.clipboard?.writeText(taxLetter.letter.body); setNote('Letter copied.'); }}>
                    Copy letter
                  </button>
                </section>
              )}
            </>
          )}

          {/* ── Donor wall ──────────────────────────────────────────────── */}
          {tool === 'wall' && (
            <section style={S.card}>
              <p style={S.kick}>Donor wall</p>
              {don.donorWall.total === 0 ? (
                <p style={{ color: '#8A9089', fontSize: 14, margin: '8px 0 0', lineHeight: 1.6 }}>
                  Nobody has committed yet. Only committed donors go on the wall — a vendor still
                  marked pending on a sign that has gone to print is awkward in both directions.
                </p>
              ) : (
                <>
                  <p style={{ fontSize: 13.5, color: '#5C6B62', margin: '6px 0 14px', lineHeight: 1.6 }}>
                    {don.donorWall.total} donor{don.donorWall.total === 1 ? '' : 's'}, grouped by what they
                    covered and ordered by contribution. No dollar figures — a thank-you is not a price list.
                  </p>
                  {don.donorWall.groups.map((g) => (
                    <div key={g.key} style={{ padding: '10px 0', borderTop: '1px solid var(--line)' }}>
                      <span style={{ ...S.kick, display: 'block', marginBottom: 5 }}>{g.emoji} {g.label}</span>
                      {g.donors.map((d) => (
                        <p key={d.name} style={{ margin: '0 0 3px', fontSize: 14.5 }}>
                          {d.name}
                          {d.detail && <span style={{ color: '#8A9089', fontSize: 12.5 }}> — {d.detail}</span>}
                        </p>
                      ))}
                    </div>
                  ))}
                  <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--line)' }}>
                    <span style={{ ...S.kick, display: 'block', marginBottom: 6 }}>One-line credit</span>
                    <p style={{ margin: '0 0 12px', fontSize: 14, lineHeight: 1.6, fontStyle: 'italic' }}>{don.donorWall.inline}</p>
                    <button style={S.mini}
                      onClick={() => { navigator.clipboard?.writeText(don.donorWall.plainText); setNote('Donor wall copied.'); }}>
                      Copy for the program
                    </button>
                  </div>
                </>
              )}
            </section>
          )}

          {tool === 'prospects' && (
          <section style={{ ...S.card, marginBottom: 14 }}>
            <p style={S.kick}>Add a prospect</p>
            <div style={{ display: 'flex', gap: 10, marginTop: 10, flexWrap: 'wrap' }}>
              <input placeholder="Business name" value={newProspect.company} style={{ ...S.input, flex: '1 1 180px' }}
                onChange={(e) => setNewProspect({ ...newProspect, company: e.target.value })} />
              <input placeholder="Contact name" value={newProspect.contactName} style={{ ...S.input, flex: '1 1 140px' }}
                onChange={(e) => setNewProspect({ ...newProspect, contactName: e.target.value })} />
              <input placeholder="Email" value={newProspect.email} style={{ ...S.input, flex: '1 1 180px' }}
                onChange={(e) => setNewProspect({ ...newProspect, email: e.target.value })} />
              <select value={newProspect.category} style={{ ...S.input, flex: '1 1 180px' }}
                onChange={(e) => setNewProspect({ ...newProspect, category: e.target.value })}>
                <option value="">Category…</option>
                {don.asks.map((a) => <option key={a.key} value={a.key}>{a.label}</option>)}
              </select>
              <button onClick={addProspect} disabled={busy} style={S.btn}>Add</button>
            </div>
          </section>
          )}

          {tool === 'prospects' && don.prospects.length === 0 && (
            <p style={{ color: '#8A9089', fontSize: 14 }}>No prospects yet. Six categories, roughly eighteen businesses — that&apos;s a normal donation list.</p>
          )}

          {tool === 'prospects' && don.prospects.map((p) => {
            const pill = PILL[p.status] ?? PILL.prospect;
            const cat = don.asks.find((a) => a.key === p.category);
            const open = openProspect === p.id;
            return (
              <div key={p.id} style={{ marginBottom: 8 }}>
                <button onClick={() => { setOpenProspect(open ? null : p.id); setEditDraft({ subject: p.draftSubject ?? '', body: p.draftBody ?? '' }); }}
                  style={{ ...S.row, borderRadius: open ? '12px 12px 0 0' : 12 }}>
                  <span style={{ flex: 1 }}>
                    <span style={{ fontSize: 15 }}>{cat?.emoji ?? '\u{1F91D}'} {cat?.short ?? 'Other'}</span>
                    <span style={{ color: '#8A9089', fontSize: 15 }}> · </span>
                    <strong style={{ fontSize: 15 }}>{p.company}</strong>
                    {p.nextFollowUpAt && (
                      <span style={{ color: '#8A6D1F', fontSize: 12.5, display: 'block', marginTop: 2 }}>
                        Follow-up {p.followUpCount + 1} of 2 due {day(p.nextFollowUpAt)}
                      </span>
                    )}
                    {p.replySnippet && (
                      <span style={{ color: '#1B6B3A', fontSize: 12.5, display: 'block', marginTop: 2 }}>
                        Replied: “{p.replySnippet.slice(0, 90)}{p.replySnippet.length > 90 ? '…' : ''}”
                      </span>
                    )}
                  </span>
                  {p.emailOpens > 0 && <span style={{ fontSize: 12, color: '#8A9089' }}>{p.emailOpens}×</span>}
                  <span style={{ ...S.pill, color: pill.fg, background: pill.bg }}>{pill.label}</span>
                </button>

                {open && (
                  <div style={S.panel}>
                    {p.askSummary && <p style={{ fontSize: 13.5, margin: '0 0 12px', color: '#1B6B3A' }}>Asking for: {p.askSummary}</p>}
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
                      <button style={S.mini} disabled={busy}
                        onClick={() => patchDon({ prospectId: p.id, action: 'draft', mode: p.status === 'prospect' ? 'first' : 'followup' })}>
                        {p.draftBody ? 'Redraft' : 'Draft with AI'}
                      </button>
                      {(['responded', 'committed', 'declined'] as const).map((s) => (
                        <button key={s} style={S.mini} disabled={busy}
                          onClick={() => patchDon({ prospectId: p.id, action: 'status', status: s })}>
                          Mark {s}
                        </button>
                      ))}
                      <button style={{ ...S.mini, color: '#B8442C' }} disabled={busy}
                        onClick={() => patchDon({ prospectId: p.id, action: 'delete' })}>Remove</button>
                    </div>

                    {(editDraft.body || p.draftBody) && (
                      <>
                        <label style={{ display: 'block', marginBottom: 8 }}>
                          <span style={S.label}>Subject</span>
                          <input value={editDraft.subject} style={S.input}
                            onChange={(e) => setEditDraft({ ...editDraft, subject: e.target.value })} />
                        </label>
                        <label style={{ display: 'block', marginBottom: 10 }}>
                          <span style={S.label}>Body</span>
                          <textarea value={editDraft.body} rows={12} style={{ ...S.input, resize: 'vertical', lineHeight: 1.6 }}
                            onChange={(e) => setEditDraft({ ...editDraft, body: e.target.value })} />
                        </label>
                        <button style={S.btn} disabled={busy || !p.email}
                          onClick={() => patchDon({ prospectId: p.id, action: 'send', subject: editDraft.subject, body: editDraft.body })}>
                          {p.status === 'prospect' ? 'Send it' : `Send follow-up ${p.followUpCount + 1}`}
                        </button>
                        {!p.email && <span style={{ fontSize: 13, color: '#B8442C', marginLeft: 10 }}>No email address on this prospect.</span>}
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </>
      )}
    </main>
  );
}

const S: Record<string, React.CSSProperties> = {
  wrap: { maxWidth: 760, margin: '0 auto', padding: '28px 20px 70px' },
  back: { background: 'none', border: 'none', color: 'var(--primary)', fontWeight: 600, fontSize: 13, cursor: 'pointer', padding: 0 },
  card: { background: '#fff', border: '1px solid var(--line)', borderRadius: 14, padding: 18 },
  chip: { fontSize: 12.5, fontWeight: 600, color: '#5C6B62', background: '#EFEAE0', borderRadius: 8, padding: '6px 12px' },
  kick: { fontSize: 11, fontWeight: 700, letterSpacing: 0.8, textTransform: 'uppercase', color: '#8A9089', margin: 0 },
  row: {
    display: 'flex', alignItems: 'center', gap: 12, width: '100%',
    background: '#fff', border: '1px solid var(--line)',
    padding: '15px 18px', cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left',
  },
  panel: { background: '#FAF8F3', border: '1px solid var(--line)', borderTop: 'none', borderRadius: '0 0 12px 12px', padding: 18 },
  pill: { fontSize: 12, fontWeight: 700, borderRadius: 999, padding: '4px 11px', whiteSpace: 'nowrap' },
  line: { display: 'flex', alignItems: 'center', gap: 12, padding: '11px 0', borderBottom: '1px solid var(--line)', flexWrap: 'wrap' },
  assume: { background: '#FAF8F3', border: '1px solid var(--line)', borderRadius: 10, padding: 14, marginTop: 14 },
  btn: { background: 'var(--primary)', color: '#fff', border: 'none', borderRadius: 9, padding: '9px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: "'DM Sans', sans-serif", whiteSpace: 'nowrap' },
  mini: { background: '#fff', border: '1px solid var(--line)', borderRadius: 8, padding: '6px 12px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', color: 'var(--ink)' },
  // Full `border` shorthand, not `borderColor` — overriding one longhand on top
  // of S.mini's shorthand makes React warn about conflicting style properties.
  miniOn: { background: 'var(--primary)', color: '#fff', border: '1px solid var(--primary)' },
  link: { background: 'none', border: 'none', color: 'var(--primary)', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', padding: 0 },
  input: { width: '100%', border: '1px solid var(--line)', borderRadius: 8, padding: '9px 11px', fontSize: 14, fontFamily: 'inherit', boxSizing: 'border-box', background: '#fff' },
  field: { flex: '1 1 130px', display: 'block' },
  label: { fontSize: 12, fontWeight: 600, color: '#5C6B62', display: 'block', marginBottom: 5 },
  warn: { background: '#FBF0DC', color: '#7A5F16', borderRadius: 9, padding: '10px 13px', fontSize: 13.5, lineHeight: 1.55, margin: '10px 0 0' },
  error: { background: '#FBE9E7', color: '#B8442C', borderRadius: 9, padding: '10px 13px', fontSize: 13.5, margin: '0 0 12px' },
  note: { background: '#E7F1EA', color: '#1B6B3A', borderRadius: 9, padding: '10px 13px', fontSize: 13.5, margin: '0 0 12px' },
};
