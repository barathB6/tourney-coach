'use client';

import React, { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { useRouter } from 'next/navigation';

type Tier = {
  id: string;
  name: string;
  label: string | null;
  price_cents: number;
  benefits: string[];
  quantity: number | null;
  highlight: boolean;
  sort_order: number;
};

type Sponsor = {
  id: string;
  tier_id: string | null;
  company: string;
  contact_name: string | null;
  contact_title: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
  logo_url: string | null;
  notes: string | null;
  status: string;
  amount_cents: number | null;
  source: string;
  logo_received: boolean;
  signage_created: boolean;
  placement_confirmed: boolean;
  last_touch: string | null;
};

const STATUS_META: Record<string, { label: string; fg: string; bg: string }> = {
  not_contacted: { label: 'Not yet contacted', fg: '#6B7775', bg: '#F0EDE6' },
  contacted:     { label: 'Contacted',          fg: '#1a5fa8', bg: '#E3EEFA' },
  no_reply:      { label: 'No reply',           fg: '#C0392B', bg: '#FBE9E7' },
  verbal:        { label: 'Verbal yes · awaiting check', fg: '#1a5fa8', bg: '#E3EEFA' },
  invoiced:      { label: 'Confirmed · invoiced', fg: '#1B6B3A', bg: '#EAF2ED' },
  pending:       { label: 'Payment pending',    fg: '#B8860B', bg: '#FBF3DC' },
  paid:          { label: 'Confirmed · paid',   fg: '#1B6B3A', bg: '#EAF2ED' },
  declined:      { label: 'Declined',           fg: '#6B7775', bg: '#F0EDE6' },
};

const STARTER_TIERS = [
  { name: 'Title Sponsor', label: 'Title', price_cents: 500000, quantity: 1, highlight: true,
    benefits: ['Event named: "Presented by [Name]"', 'Logo on all materials', 'Premier banner placement', 'Foursome included'] },
  { name: 'Eagle Sponsor', label: 'Eagle', price_cents: 250000, quantity: 4, highlight: false,
    benefits: ['Logo on banners', 'Tee box signage', 'Foursome included', 'Awards mention'] },
  { name: 'Birdie Sponsor', label: 'Birdie', price_cents: 100000, quantity: 8, highlight: false,
    benefits: ['Hole sign', 'Program listing', 'Two players included'] },
  { name: 'Hole Sponsor', label: 'Hole', price_cents: 25000, quantity: 18, highlight: false,
    benefits: ['One hole sign', 'Program listing'] },
];

const TIER_PRESETS = [
  { name: 'Dinner Sponsor', label: 'Dinner', price_cents: 150000, quantity: 1,
    benefits: ['Named dinner sponsor', 'Signage at dinner', 'Program listing'] },
  { name: 'Beverage Cart Sponsor', label: 'Bev Cart', price_cents: 75000, quantity: 2,
    benefits: ['Logo on beverage carts', 'Program listing'] },
  { name: 'Putting Contest Sponsor', label: 'Putting', price_cents: 50000, quantity: 1,
    benefits: ['Named putting contest', 'Signage at putting green', 'Program listing'] },
  { name: 'Contest Sponsor', label: 'Contest', price_cents: 50000, quantity: 2,
    benefits: ['Named on-course contest', 'Hole signage', 'Program listing'] },
  { name: 'Custom Package', label: null, price_cents: 100000, quantity: null,
    benefits: ['Program listing'] },
];

function money(cents: number) {
  return '$' + (cents / 100).toLocaleString('en-US', { maximumFractionDigits: 0 });
}

function daysSince(dateStr: string) {
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000);
}

export default function SponsorsPage() {
  const router = useRouter();
  const [tournamentId, setTournamentId] = useState<string | null>(null);
  const [tournamentName, setTournamentName] = useState('');
  const [tiers, setTiers] = useState<Tier[]>([]);
  const [sponsors, setSponsors] = useState<Sponsor[]>([]);
  const [loading, setLoading] = useState(true);
  const [presetOpen, setPresetOpen] = useState(false);
  const [addingProspect, setAddingProspect] = useState(false);
  const [prospectDraft, setProspectDraft] = useState({ company: '', contact_name: '', contact_title: '', email: '', tier_id: '' });
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [emailModal, setEmailModal] = useState<{ sponsor: Sponsor; subject: string; body: string; loading: boolean; error: string } | null>(null);
  const [sending, setSending] = useState(false);
  const [sendResult, setSendResult] = useState<'sent' | 'error' | null>(null);
  const [markingPaidId, setMarkingPaidId] = useState<string | null>(null);
  const [showRecognition, setShowRecognition] = useState(false);
  const [copied, setCopied] = useState(false);
  const [uploadingId, setUploadingId] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      const user = session?.user ?? null;
      if (!user) { router.replace('/sign-in'); return; }

      let selectedId: string | null = null;
      try { selectedId = localStorage.getItem(`tourney_selected_tournament_${user.id}`); } catch { /* */ }

      const { data: all } = await supabase
        .from('tournaments')
        .select('id, name')
        .eq('organizer_id', user.id)
        .order('created_at', { ascending: false });
      const picked = (all ?? []).find(t => t.id === selectedId) ?? (all ?? [])[0] ?? null;
      if (!picked) { setLoading(false); return; }

      setTournamentId(picked.id);
      setTournamentName(picked.name);
      await Promise.all([loadTiers(picked.id), loadSponsors(picked.id)]);
      setLoading(false);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router]);

  async function loadTiers(tid: string) {
    const { data } = await supabase
      .from('sponsorship_tiers')
      .select('*')
      .eq('tournament_id', tid)
      .order('sort_order', { ascending: true });
    setTiers((data ?? []).map(t => ({ ...t, benefits: (t.benefits as string[]) ?? [] })));
  }

  // Prospects marked "contacted" with no reply after this many days are
  // auto-flagged "no reply" so follow-up surfaces without manual bookkeeping.
  const NO_REPLY_THRESHOLD_DAYS = 5;

  async function loadSponsors(tid: string) {
    const { data } = await supabase
      .from('sponsors')
      .select('*')
      .eq('tournament_id', tid)
      .order('created_at', { ascending: false });
    let rows = data ?? [];

    const staleIds = rows
      .filter(s => s.status === 'contacted' && s.last_touch && daysSince(s.last_touch) >= NO_REPLY_THRESHOLD_DAYS)
      .map(s => s.id);
    if (staleIds.length > 0) {
      await supabase.from('sponsors').update({ status: 'no_reply' }).in('id', staleIds);
      rows = rows.map(s => staleIds.includes(s.id) ? { ...s, status: 'no_reply' } : s);
    }

    setSponsors(rows);
  }

  // ── Tier operations ──────────────────────────────────────────────────────
  async function seedStarterTiers() {
    if (!tournamentId) return;
    const rows = STARTER_TIERS.map((t, i) => ({ ...t, tournament_id: tournamentId, sort_order: i }));
    const { error } = await supabase.from('sponsorship_tiers').insert(rows);
    if (error) { alert(error.message); return; }
    loadTiers(tournamentId);
  }

  async function addTierFromPreset(preset: typeof TIER_PRESETS[number]) {
    if (!tournamentId) return;
    setPresetOpen(false);
    const { error } = await supabase.from('sponsorship_tiers').insert({
      tournament_id: tournamentId,
      name: preset.name,
      label: preset.label,
      price_cents: preset.price_cents,
      quantity: preset.quantity,
      benefits: preset.benefits,
      highlight: false,
      sort_order: tiers.length,
    });
    if (error) { alert(error.message); return; }
    loadTiers(tournamentId);
  }

  async function deleteTier(id: string) {
    if (!tournamentId) return;
    if (!confirm('Delete this package? Sponsors on it keep their records.')) return;
    await supabase.from('sponsorship_tiers').delete().eq('id', id);
    loadTiers(tournamentId);
  }

  // ── Sponsor operations ───────────────────────────────────────────────────
  async function addProspect() {
    if (!tournamentId || !prospectDraft.company.trim()) return;
    const tier = tiers.find(t => t.id === prospectDraft.tier_id);
    const { error } = await supabase.from('sponsors').insert({
      tournament_id: tournamentId,
      tier_id: prospectDraft.tier_id || null,
      company: prospectDraft.company.trim(),
      contact_name: prospectDraft.contact_name.trim() || null,
      contact_title: prospectDraft.contact_title.trim() || null,
      email: prospectDraft.email.trim() || null,
      amount_cents: tier?.price_cents ?? null,
      status: 'not_contacted',
    });
    if (error) { alert(error.message); return; }
    setProspectDraft({ company: '', contact_name: '', contact_title: '', email: '', tier_id: '' });
    setAddingProspect(false);
    loadSponsors(tournamentId);
  }

  async function updateSponsor(id: string, patch: Partial<Sponsor> & Record<string, unknown>) {
    if (!tournamentId) return;
    const { error } = await supabase.from('sponsors').update(patch).eq('id', id);
    if (error) { alert(error.message); return; }
    loadSponsors(tournamentId);
  }

  async function deleteSponsor(id: string) {
    if (!tournamentId) return;
    if (!confirm('Remove this sponsor/prospect?')) return;
    await supabase.from('sponsors').delete().eq('id', id);
    loadSponsors(tournamentId);
  }

  // ── Logo upload ──────────────────────────────────────────────────────────
  async function uploadLogo(sponsorId: string, file: File) {
    if (!tournamentId) return;
    if (!file.type.startsWith('image/')) { setUploadError('Please choose an image file.'); return; }
    if (file.size > 5 * 1024 * 1024) { setUploadError('Logo must be under 5MB.'); return; }

    setUploadingId(sponsorId);
    setUploadError(null);
    try {
      const ext = file.name.split('.').pop() || 'png';
      const path = `${tournamentId}/${sponsorId}-${Date.now()}.${ext}`;
      const { error: upErr } = await supabase.storage.from('sponsor-logos').upload(path, file, { upsert: true });
      if (upErr) throw upErr;
      const { data: pub } = supabase.storage.from('sponsor-logos').getPublicUrl(path);
      await updateSponsor(sponsorId, { logo_url: pub.publicUrl, logo_received: true });
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploadingId(null);
    }
  }

  // ── AI outreach ──────────────────────────────────────────────────────────
  async function draftEmail(sp: Sponsor, mode: 'intro' | 'follow_up') {
    setEmailModal({ sponsor: sp, subject: '', body: '', loading: true, error: '' });
    const { data: { session } } = await supabase.auth.getSession();
    const res = await fetch('/api/sponsors/outreach', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token ?? ''}` },
      body: JSON.stringify({ sponsor_id: sp.id, mode }),
    });
    const data = await res.json();
    if (!res.ok) {
      setEmailModal(m => m ? { ...m, loading: false, error: data.error || 'Drafting failed' } : m);
      return;
    }
    setEmailModal(m => m ? { ...m, loading: false, subject: data.subject, body: data.body } : m);
  }

  async function sendEmailNow() {
    if (!emailModal || !activeEmailSponsor) return;
    setSending(true);
    setSendResult(null);
    const { data: { session } } = await supabase.auth.getSession();
    const res = await fetch('/api/sponsors/outreach/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token ?? ''}` },
      body: JSON.stringify({ sponsor_id: activeEmailSponsor.id, subject: emailModal.subject, body: emailModal.body }),
    });
    setSending(false);
    if (!res.ok) {
      setSendResult('error');
      return;
    }
    setSendResult('sent');
    if (tournamentId) loadSponsors(tournamentId);
    setTimeout(() => { setEmailModal(null); setSendResult(null); }, 1200);
  }

  async function markSponsorPaid(sponsorId: string) {
    if (!tournamentId) return;
    setMarkingPaidId(sponsorId);
    const { data: { session } } = await supabase.auth.getSession();
    const res = await fetch(`/api/sponsors/${sponsorId}/mark-paid`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${session?.access_token ?? ''}` },
    });
    setMarkingPaidId(null);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      alert(data.error || 'Could not mark as paid');
      return;
    }
    loadSponsors(tournamentId);
  }

  function tierOf(sp: Sponsor) {
    return tiers.find(t => t.id === sp.tier_id) ?? null;
  }

  // Awards-ceremony recognition list: every committed (paid) sponsor,
  // grouped by tier in the same order as the tier cards (highest first),
  // ready to read aloud or hand to an emcee.
  function recognitionGroups() {
    const paid = sponsors.filter(sp => sp.status === 'paid');
    const sorted = [...tiers].sort((a, b) => a.sort_order - b.sort_order);
    const groups: { tier: Tier | null; sponsors: Sponsor[] }[] = sorted
      .map(t => ({ tier: t, sponsors: paid.filter(sp => sp.tier_id === t.id) }))
      .filter(g => g.sponsors.length > 0);
    const untiered = paid.filter(sp => !sp.tier_id);
    if (untiered.length > 0) groups.push({ tier: null, sponsors: untiered });
    return groups;
  }

  function soldCount(tier: Tier) {
    // "pending" is an in-progress checkout, not a real commitment — an
    // abandoned or declined attempt shouldn't count as sold.
    return sponsors.filter(s => s.tier_id === tier.id && ['verbal', 'invoiced', 'paid'].includes(s.status)).length;
  }

  // ── Styles ───────────────────────────────────────────────────────────────
  const s: Record<string, React.CSSProperties> = {
    page: { fontFamily: "'DM Sans', sans-serif", background: '#FAF8F3', minHeight: '100vh', padding: '32px 24px', color: '#1A1F1C' },
    card: { background: '#fff', border: '1px solid #E5E0D5', borderRadius: 12, overflow: 'hidden' },
    input: { width: '100%', padding: '8px 10px', border: '1px solid #E5E0D5', borderRadius: 6, fontSize: 13, fontFamily: "'DM Sans', sans-serif", background: '#fff', boxSizing: 'border-box' },
    btn: { background: '#1B6B3A', color: '#fff', border: 'none', borderRadius: 8, padding: '8px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" },
    btnGhost: { background: 'none', color: '#1B6B3A', border: '1px solid #E5E0D5', borderRadius: 8, padding: '8px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" },
    chip: { borderRadius: 999, padding: '3px 10px', fontWeight: 600, fontSize: 12, display: 'inline-block' },
  };

  if (loading) return (
    <div style={{ ...s.page, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <p style={{ color: '#6B7775' }}>Loading…</p>
    </div>
  );

  const activeEmailSponsor = emailModal?.sponsor;

  return (
    <div style={s.page}>
      <div style={{ maxWidth: 1200, margin: '0 auto' }}>

        {/* Header */}
        <div style={{ marginBottom: 28 }}>
          <button onClick={() => router.push('/dashboard')} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#1B6B3A', fontSize: 14, padding: 0, marginBottom: 8 }}>
            ← Back to dashboard
          </button>
          <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
            <div>
              <h1 style={{ fontFamily: "'Fraunces', serif", fontSize: 28, fontWeight: 700, margin: 0 }}>Sponsorships</h1>
              <p style={{ color: '#6B7775', margin: '4px 0 0', fontSize: 14 }}>
                {tournamentName} · {tiers.length} packages · {sponsors.filter(sp => ['paid', 'invoiced'].includes(sp.status)).length} confirmed sponsors
              </p>
            </div>
            {tournamentId && (
              <div style={{ display: 'flex', gap: 8, position: 'relative' }}>
                <button style={s.btnGhost} onClick={() => setShowRecognition(true)}>🏆 Recognition list</button>
                <button style={s.btn} onClick={() => setPresetOpen(o => !o)}>+ Add package</button>
                {presetOpen && (
                  <>
                    <div onClick={() => setPresetOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 10 }} />
                    <div style={{ position: 'absolute', right: 0, top: 'calc(100% + 6px)', background: '#fff', border: '1px solid #E5E0D5', borderRadius: 10, boxShadow: '0 4px 20px rgba(15,74,38,.12)', minWidth: 230, zIndex: 20, overflow: 'hidden' }}>
                      {TIER_PRESETS.map(p => (
                        <button key={p.name} onClick={() => addTierFromPreset(p)} style={{ width: '100%', padding: '10px 14px', background: 'none', border: 'none', textAlign: 'left', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif", fontSize: 13.5, color: '#1A1F1C', display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                          <span style={{ fontWeight: 600 }}>{p.name}</span>
                          <span style={{ color: '#6B7775' }}>{money(p.price_cents)}</span>
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        </div>

        {!tournamentId ? (
          <div style={{ ...s.card, padding: '48px 32px', textAlign: 'center' }}>
            <p style={{ color: '#6B7775' }}>Create a tournament first to build sponsorship packages.</p>
          </div>
        ) : (
          <>
            {/* ── Tier builder ── */}
            {tiers.length === 0 ? (
              <div style={{ ...s.card, padding: '48px 32px', textAlign: 'center', marginBottom: 32 }}>
                <p style={{ fontSize: 32, marginBottom: 12 }}>🏷️</p>
                <p style={{ fontFamily: "'Fraunces', serif", fontSize: 20, marginBottom: 8 }}>No sponsorship packages yet</p>
                <p style={{ color: '#6B7775', fontSize: 14, marginBottom: 20 }}>Start with the proven four-tier structure — Title, Eagle, Birdie, and Hole — then customize.</p>
                <button style={s.btn} onClick={seedStarterTiers}>Load starter packages</button>
              </div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))', gap: 16, marginBottom: 36 }}>
                {tiers.map((t) => {
                  const sold = soldCount(t);
                  return (
                    <div key={t.id} style={{
                      background: '#fff', borderRadius: 12, padding: '20px 20px 16px', position: 'relative',
                      border: t.highlight ? '2px solid #C8A04A' : '1px solid #E5E0D5',
                    }}>
                      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: t.highlight ? '#C8A04A' : '#6B7775', marginBottom: 8 }}>
                        {t.highlight ? '★ ' : ''}{t.label ?? t.name}
                      </div>
                      <div style={{ fontFamily: "'Fraunces', serif", fontSize: 20, fontWeight: 700, marginBottom: 2 }}>{t.name}</div>
                      <div style={{ fontFamily: "'Fraunces', serif", fontSize: 26, fontWeight: 700, color: '#1B6B3A', marginBottom: 14 }}>{money(t.price_cents)}</div>
                      <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 14px' }}>
                        {t.benefits.map((b, i) => (
                          <li key={i} style={{ fontSize: 13, color: '#3A3F3C', padding: '3px 0', display: 'flex', gap: 7 }}>
                            <span style={{ color: '#1B6B3A', fontWeight: 700 }}>✓</span>{b}
                          </li>
                        ))}
                      </ul>
                      <div style={{ borderTop: '1px solid #E5E0D5', paddingTop: 10, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span style={{ fontSize: 13, color: '#6B7775' }}>Sold</span>
                        <span style={{ fontFamily: "'Fraunces', serif", fontWeight: 700, fontSize: 15 }}>
                          {sold}{t.quantity != null ? ` / ${t.quantity}` : ''}
                        </span>
                      </div>
                      <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
                        <button onClick={() => deleteTier(t.id)} style={{ ...s.btnGhost, padding: '4px 10px', fontSize: 12, color: '#C0392B', marginLeft: 'auto' }}>Delete</button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* ── Prospect tracker ── */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
              <h2 style={{ fontFamily: "'Fraunces', serif", fontSize: 20, fontWeight: 700, margin: 0 }}>Sponsor pipeline</h2>
              <button style={s.btnGhost} onClick={() => setAddingProspect(o => !o)}>{addingProspect ? 'Close' : '+ Add prospect'}</button>
            </div>

            {addingProspect && (
              <div style={{ ...s.card, padding: 16, marginBottom: 14, display: 'grid', gridTemplateColumns: '1.2fr 1fr 1fr 1.2fr 0.9fr auto', gap: 10, alignItems: 'center' }}>
                <input style={s.input} placeholder="Company *" value={prospectDraft.company} onChange={e => setProspectDraft(d => ({ ...d, company: e.target.value }))} />
                <input style={s.input} placeholder="Contact name" value={prospectDraft.contact_name} onChange={e => setProspectDraft(d => ({ ...d, contact_name: e.target.value }))} />
                <input style={s.input} placeholder="Title (e.g. owner)" value={prospectDraft.contact_title} onChange={e => setProspectDraft(d => ({ ...d, contact_title: e.target.value }))} />
                <input style={s.input} placeholder="Email" value={prospectDraft.email} onChange={e => setProspectDraft(d => ({ ...d, email: e.target.value }))} />
                <select style={s.input} value={prospectDraft.tier_id} onChange={e => setProspectDraft(d => ({ ...d, tier_id: e.target.value }))}>
                  <option value="">No tier yet</option>
                  {tiers.map(t => <option key={t.id} value={t.id}>{t.label ?? t.name}</option>)}
                </select>
                <button style={s.btn} onClick={addProspect}>Add</button>
              </div>
            )}

            {sponsors.length === 0 ? (
              <div style={{ ...s.card, padding: '40px 32px', textAlign: 'center' }}>
                <p style={{ color: '#6B7775', fontSize: 14 }}>No prospects yet. Add local businesses you want to pursue — medical practices, law firms, financial advisors, and restaurants convert best.</p>
              </div>
            ) : (
              <div style={s.card}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid #E5E0D5', background: '#FAF8F3' }}>
                      {['Prospect', 'Tier', 'Status', 'Last touch', 'Action', ''].map((h, i) => (
                        <th key={i} style={{ padding: '12px 16px', textAlign: 'left', fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#6B7775' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {sponsors.map((sp) => {
                      const tier = tierOf(sp);
                      const meta = STATUS_META[sp.status] ?? STATUS_META.not_contacted;
                      const isExpanded = expandedId === sp.id;
                      const noReplyDays = sp.status === 'no_reply' && sp.last_touch ? daysSince(sp.last_touch) : null;
                      return (
                        <React.Fragment key={sp.id}>
                        <tr style={{ borderBottom: '1px solid #E5E0D5' }}>
                          <td style={{ padding: '14px 16px' }}>
                            <div style={{ fontWeight: 600, fontSize: 14 }}>{sp.company}</div>
                            <div style={{ fontSize: 12.5, color: '#6B7775', marginTop: 2 }}>
                              {[sp.contact_name, sp.contact_title].filter(Boolean).join(' · ') || sp.email || '—'}
                            </div>
                          </td>
                          <td style={{ padding: '14px 16px' }}>
                            {tier ? (
                              <span style={{ ...s.chip, background: tier.highlight ? '#FBF3DC' : '#F0EDE6', color: tier.highlight ? '#B8860B' : '#3A3F3C' }}>
                                {tier.label ?? tier.name}
                              </span>
                            ) : <span style={{ color: '#9BA8A4' }}>—</span>}
                          </td>
                          <td style={{ padding: '14px 16px' }}>
                            <span style={{ ...s.chip, background: meta.bg, color: meta.fg }}>
                              {meta.label}{noReplyDays != null ? ` · ${noReplyDays} days` : ''}
                            </span>
                          </td>
                          <td style={{ padding: '14px 16px', fontSize: 13, color: '#6B7775' }}>
                            {sp.last_touch ? new Date(sp.last_touch).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—'}
                          </td>
                          <td style={{ padding: '14px 16px', whiteSpace: 'nowrap' }}>
                            {sp.status === 'not_contacted' && (
                              <button style={{ ...s.btn, padding: '6px 14px', fontSize: 12.5 }} onClick={() => draftEmail(sp, 'intro')}>Draft email</button>
                            )}
                            {(sp.status === 'contacted' || sp.status === 'no_reply') && (
                              <button style={{ ...s.btn, padding: '6px 14px', fontSize: 12.5 }} onClick={() => draftEmail(sp, 'follow_up')}>Follow up</button>
                            )}
                            {sp.status === 'verbal' && (
                              <button style={{ ...s.btn, padding: '6px 14px', fontSize: 12.5 }} onClick={() => updateSponsor(sp.id, { status: 'invoiced', last_touch: new Date().toISOString() })}>Send invoice</button>
                            )}
                            {(sp.status === 'invoiced' || sp.status === 'pending') && (
                              <button style={{ ...s.btn, padding: '6px 14px', fontSize: 12.5 }} disabled={markingPaidId === sp.id} onClick={() => markSponsorPaid(sp.id)}>
                                {markingPaidId === sp.id ? 'Marking…' : 'Mark paid'}
                              </button>
                            )}
                            {sp.status === 'paid' && (
                              <button style={{ ...s.btnGhost, padding: '6px 14px', fontSize: 12.5 }} onClick={() => setExpandedId(isExpanded ? null : sp.id)}>{isExpanded ? 'Close' : 'View'}</button>
                            )}
                          </td>
                          <td style={{ padding: '14px 16px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                            <select
                              value={sp.status}
                              onChange={e => updateSponsor(sp.id, { status: e.target.value, last_touch: new Date().toISOString() })}
                              style={{ ...s.input, width: 'auto', fontSize: 12, padding: '5px 6px', color: '#6B7775' }}
                            >
                              {Object.entries(STATUS_META).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                            </select>
                            <button onClick={() => deleteSponsor(sp.id)} title="Remove" style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 6, color: '#9BA8A4', marginLeft: 4 }}>✕</button>
                          </td>
                        </tr>
                        {isExpanded && (
                          <tr style={{ borderBottom: '1px solid #E5E0D5', background: '#FAF8F3' }}>
                            <td colSpan={6} style={{ padding: '16px 20px' }}>
                              <div style={{ display: 'flex', gap: 28, flexWrap: 'wrap', alignItems: 'center' }}>
                                <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: '#6B7775' }}>Fulfillment</span>
                                {([['logo_received', 'Logo received'], ['signage_created', 'Signage created'], ['placement_confirmed', 'Placement confirmed']] as const).map(([key, label]) => (
                                  <label key={key} style={{ fontSize: 13.5, display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer' }}>
                                    <input
                                      type="checkbox"
                                      checked={Boolean(sp[key])}
                                      onChange={e => updateSponsor(sp.id, { [key]: e.target.checked })}
                                    />
                                    {label}
                                  </label>
                                ))}
                                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1, minWidth: 320 }}>
                                  <span style={{ fontSize: 13, color: '#6B7775', whiteSpace: 'nowrap' }}>Logo</span>
                                  {sp.logo_url && (
                                    <img src={sp.logo_url} alt={`${sp.company} logo`} style={{ height: 32, maxWidth: 90, objectFit: 'contain', background: '#fff', border: '1px solid #E5E0D5', borderRadius: 6, padding: 3 }} />
                                  )}
                                  <label style={{ ...s.btnGhost, display: 'inline-flex', alignItems: 'center', cursor: uploadingId === sp.id ? 'default' : 'pointer', opacity: uploadingId === sp.id ? 0.6 : 1 }}>
                                    {uploadingId === sp.id ? 'Uploading…' : sp.logo_url ? 'Replace logo' : 'Upload logo'}
                                    <input
                                      type="file"
                                      accept="image/*"
                                      disabled={uploadingId === sp.id}
                                      onChange={e => { const f = e.target.files?.[0]; if (f) uploadLogo(sp.id, f); e.target.value = ''; }}
                                      style={{ position: 'absolute', width: 1, height: 1, opacity: 0, pointerEvents: 'none' }}
                                    />
                                  </label>
                                  {uploadError && uploadingId === null && <span style={{ fontSize: 12, color: '#C0392B' }}>{uploadError}</span>}
                                </div>
                              </div>
                            </td>
                          </tr>
                        )}
                        </React.Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>

      {/* ── AI email modal ── */}
      {showRecognition && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }} onClick={() => setShowRecognition(false)}>
          <div className="recognition-print" style={{ background: '#fff', borderRadius: 14, padding: 32, width: '100%', maxWidth: 560, maxHeight: '85vh', overflowY: 'auto' }} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
              <h3 style={{ fontFamily: "'Fraunces', serif", fontSize: 22, fontWeight: 700, margin: 0 }}>🏆 Sponsor Recognition</h3>
              <div className="no-print" style={{ display: 'flex', gap: 8 }}>
                <button style={s.btnGhost} onClick={() => window.print()}>Print</button>
                <button style={s.btnGhost} onClick={() => setShowRecognition(false)}>Close</button>
              </div>
            </div>
            <p style={{ color: '#6B7775', fontSize: 13, margin: '0 0 20px' }}>{tournamentName} — for the awards ceremony script or program</p>

            {recognitionGroups().length === 0 ? (
              <p style={{ color: '#9BA8A4', padding: '24px 0', textAlign: 'center' }}>No confirmed sponsors yet — this fills in as sponsors pay.</p>
            ) : (
              recognitionGroups().map((group, gi) => (
                <div key={gi} style={{ marginBottom: 22 }}>
                  <p style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: group.tier?.highlight ? '#C8A04A' : '#1B6B3A', margin: '0 0 8px' }}>
                    {group.tier ? (group.tier.label ?? group.tier.name) : 'Other sponsors'}
                  </p>
                  <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                    {group.sponsors.map(sp => (
                      <li key={sp.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: '1px solid #F0EDE6' }}>
                        {sp.logo_url && <img src={sp.logo_url} alt="" style={{ height: 24, maxWidth: 70, objectFit: 'contain' }} />}
                        <span style={{ fontWeight: 700, fontSize: 15 }}>{sp.company}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      <style>{`
        @media print {
          body * { visibility: hidden; }
          .recognition-print, .recognition-print * { visibility: visible; }
          .recognition-print { position: fixed; inset: 0; max-height: none !important; box-shadow: none; }
          .no-print { display: none !important; }
        }
      `}</style>

      {emailModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }} onClick={() => setEmailModal(null)}>
          <div style={{ background: '#fff', borderRadius: 14, padding: 24, width: '100%', maxWidth: 640, maxHeight: '85vh', overflowY: 'auto' }} onClick={e => e.stopPropagation()}>
            <h3 style={{ fontFamily: "'Fraunces', serif", fontSize: 20, fontWeight: 700, margin: '0 0 4px' }}>
              Outreach email — {activeEmailSponsor?.company}
            </h3>
            <p style={{ color: '#6B7775', fontSize: 13, margin: '0 0 16px' }}>Drafted by your AI coach. Edit before sending.</p>

            {emailModal.loading ? (
              <p style={{ color: '#6B7775', padding: '30px 0', textAlign: 'center' }}>Drafting a personalized email…</p>
            ) : emailModal.error ? (
              <p style={{ color: '#C0392B', padding: '20px 0' }}>{emailModal.error}</p>
            ) : (
              <>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: '#6B7775', marginBottom: 5 }}>Subject</label>
                <input
                  style={{ ...s.input, marginBottom: 14, fontSize: 14 }}
                  value={emailModal.subject}
                  onChange={e => setEmailModal(m => m ? { ...m, subject: e.target.value } : m)}
                />
                <label style={{ display: 'block', fontSize: 12, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: '#6B7775', marginBottom: 5 }}>Body</label>
                <textarea
                  style={{ ...s.input, minHeight: 220, resize: 'vertical', fontSize: 14, lineHeight: 1.6, marginBottom: 16 }}
                  value={emailModal.body}
                  onChange={e => setEmailModal(m => m ? { ...m, body: e.target.value } : m)}
                />
                {sendResult === 'error' && (
                  <p style={{ color: '#C0392B', fontSize: 13, marginBottom: 10 }}>Couldn&rsquo;t send — check that SendGrid is configured, or use the fallback options below.</p>
                )}
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                  <button style={{ ...s.btn }} disabled={sending || sendResult === 'sent'} onClick={sendEmailNow}>
                    {sendResult === 'sent' ? 'Sent ✓' : sending ? 'Sending…' : 'Send email'}
                  </button>
                  <a
                    href={`mailto:${activeEmailSponsor?.email ?? ''}?subject=${encodeURIComponent(emailModal.subject)}&body=${encodeURIComponent(emailModal.body)}`}
                    style={{ ...s.btnGhost, textDecoration: 'none', display: 'inline-block' }}
                    onClick={() => {
                      if (activeEmailSponsor) updateSponsor(activeEmailSponsor.id, { status: activeEmailSponsor.status === 'not_contacted' ? 'contacted' : activeEmailSponsor.status, last_touch: new Date().toISOString() });
                    }}
                  >
                    Open in email app instead
                  </a>
                  <button
                    style={s.btnGhost}
                    onClick={async () => {
                      await navigator.clipboard.writeText(`Subject: ${emailModal.subject}\n\n${emailModal.body}`);
                      setCopied(true);
                      setTimeout(() => setCopied(false), 1500);
                      if (activeEmailSponsor) updateSponsor(activeEmailSponsor.id, { status: activeEmailSponsor.status === 'not_contacted' ? 'contacted' : activeEmailSponsor.status, last_touch: new Date().toISOString() });
                    }}
                  >
                    {copied ? 'Copied ✓' : 'Copy'}
                  </button>
                  <button style={{ ...s.btnGhost, marginLeft: 'auto' }} onClick={() => setEmailModal(null)}>Close</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
