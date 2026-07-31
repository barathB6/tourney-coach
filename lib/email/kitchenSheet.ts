// Kitchen handoff — the sheet the course's F&B manager actually works from.
//
// This is the third chip on the module card, and it is where the calculator
// stops being a screen the organizer looks at and becomes something the
// kitchen can act on. It goes to the course contact, not the organizer.
//
// Module 9's kitchen notification (Twilio SMS, "the field is 40 minutes out")
// is the day-of nudge. This is the week-before order sheet. They share the
// same lead-time constant so the timeline in the email matches the text the
// kitchen gets on the day.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { FbPlanRecord } from '@/lib/fb/plan';
import { pluralUnit } from '@/lib/fb/calculator';
import { formatEventDate } from '@/lib/formatEventDate';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DB = SupabaseClient<any, 'public', any>;

const timeOf = (iso: string | null) =>
  iso ? new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '—';

export function buildKitchenSheet(plan: FbPlanRecord): { subject: string; text: string; html: string } {
  const p = plan.plan!;
  const date = plan.eventDate
    ? formatEventDate(plan.eventDate, { weekday: 'long', month: 'long', day: 'numeric' })
    : 'the event date';

  const lines = p.lines.map((l) => `  ${l.label}: ${l.packs} × ${pluralUnit(l.packUnit, l.packs)} (${l.packedUnits} servings)`);
  const prep = p.prep.map((s) => `  ${timeOf(s.at).padStart(8)}  ${s.label}`);

  const text = [
    `${plan.tournamentName ?? 'Golf tournament'} — F&B order sheet`,
    `${date}${plan.shotgunTime ? `, ${plan.shotgunTime} shotgun` : ''}`,
    '',
    `Headcount: ${p.inputs.playerCount} players, ${p.inputs.volunteerCount} volunteers, ${p.inputs.guestCount} guests`,
    `Locked ${plan.headcountLockedAt ? new Date(plan.headcountLockedAt).toLocaleDateString('en-US') : ''} — this number will not change.`,
    `Weather assumed: ${Math.round(p.inputs.temperatureF)}°F${p.inputs.precipChance != null ? `, ${p.inputs.precipChance}% chance of rain` : ''}.`,
    '',
    'BEVERAGE & SNACK ORDER',
    ...lines,
    '',
    'AWARDS LUNCH',
    `  ${p.lunch.portions} portions for ${p.lunch.attendees} attendees (5% over)`,
    `  ${p.lunch.vegetarianPortions} vegetarian, ${p.lunch.standardPortions} standard`,
    ...(p.lunch.menu.length ? [`  Menu: ${p.lunch.menu.join(', ')}`] : []),
    '',
    'DAY-OF TIMELINE',
    ...prep,
    ...(p.warnings.length ? ['', 'NOTES', ...p.warnings.map((w) => `  - ${w}`)] : []),
    '',
    'Sent from TourneyCoach. Reply to this email to reach the organizer.',
  ].join('\n');

  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const html = `<div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:620px;color:#1A1F1C;">
<h2 style="margin:0 0 4px;font-size:20px;">${esc(plan.tournamentName ?? 'Golf tournament')} — F&amp;B order sheet</h2>
<p style="margin:0 0 18px;color:#5A6560;font-size:14px;">${esc(date)}${plan.shotgunTime ? `, ${esc(plan.shotgunTime)} shotgun` : ''}</p>
<p style="margin:0 0 18px;font-size:15px;line-height:1.6;">
<strong>${p.inputs.playerCount} players</strong>, ${p.inputs.volunteerCount} volunteers, ${p.inputs.guestCount} guests.
Headcount is locked — this number will not change.<br>
Weather assumed: ${Math.round(p.inputs.temperatureF)}°F${p.inputs.precipChance != null ? `, ${p.inputs.precipChance}% chance of rain` : ''}.</p>
<h3 style="font-size:15px;margin:22px 0 8px;">Beverage &amp; snack order</h3>
<table style="border-collapse:collapse;font-size:14px;width:100%;">${p.lines.map((l) => `<tr><td style="padding:6px 0;border-bottom:1px solid #EEF1EF;">${esc(l.label)}</td><td style="padding:6px 0;border-bottom:1px solid #EEF1EF;text-align:right;"><strong>${l.packs} × ${esc(pluralUnit(l.packUnit, l.packs))}</strong> <span style="color:#5A6560;">(${l.packedUnits})</span></td></tr>`).join('')}</table>
<h3 style="font-size:15px;margin:22px 0 8px;">Awards lunch</h3>
<p style="margin:0;font-size:14px;line-height:1.7;"><strong>${p.lunch.portions} portions</strong> for ${p.lunch.attendees} attendees — ${p.lunch.vegetarianPortions} vegetarian, ${p.lunch.standardPortions} standard.${p.lunch.menu.length ? `<br>Menu: ${esc(p.lunch.menu.join(', '))}` : ''}</p>
<h3 style="font-size:15px;margin:22px 0 8px;">Day-of timeline</h3>
<table style="border-collapse:collapse;font-size:14px;width:100%;">${p.prep.map((s) => `<tr><td style="padding:5px 12px 5px 0;color:#5A6560;white-space:nowrap;">${esc(timeOf(s.at))}</td><td style="padding:5px 0;">${esc(s.label)}</td></tr>`).join('')}</table>
${p.warnings.length ? `<h3 style="font-size:15px;margin:22px 0 8px;">Notes</h3><ul style="margin:0;padding-left:18px;font-size:14px;line-height:1.7;">${p.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
<p style="margin:24px 0 0;font-size:12px;color:#8A938E;">Sent from TourneyCoach. Reply to this email to reach the organizer.</p></div>`;

  return {
    subject: `F&B order — ${plan.tournamentName ?? 'golf tournament'}, ${date} (${p.inputs.playerCount} players)`,
    text, html,
  };
}

export async function sendKitchenSheet(
  service: DB, tournamentId: string, plan: FbPlanRecord,
): Promise<{ ok: boolean; to?: string; error?: string }> {
  const apiKey = process.env.SENDGRID_API_KEY;
  if (!apiKey) return { ok: false, error: 'SendGrid is not configured — add SENDGRID_API_KEY to send the kitchen sheet.' };

  const { data: t } = await service.from('tournaments')
    .select('course_id, contact_email, organizer_id').eq('id', tournamentId).maybeSingle();

  let to: string | null = null;
  if (t?.course_id) {
    const { data: c } = await service.from('courses').select('contact_email').eq('id', t.course_id as string).maybeSingle();
    to = (c?.contact_email as string | null) ?? null;
  }
  // Fall back to the tournament's own contact rather than silently not sending.
  to = to || ((t?.contact_email as string | null) ?? null);
  if (!to) {
    return { ok: false, error: 'No kitchen email on file — add a contact email to the course, or to the tournament.' };
  }

  let organizerName = 'The tournament committee';
  let organizerEmail: string | null = null;
  if (t?.organizer_id) {
    const { data: prof } = await service.from('profiles')
      .select('full_name, email').eq('id', t.organizer_id as string).maybeSingle();
    if (prof?.full_name) organizerName = prof.full_name as string;
    organizerEmail = (prof?.email as string | null) ?? null;
  }

  const sheet = buildKitchenSheet(plan);
  const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to }] }],
      from: { email: 'noreply@tourneycoach.com', name: `${organizerName} via TourneyCoach` },
      reply_to: organizerEmail ? { email: organizerEmail, name: organizerName } : undefined,
      subject: sheet.subject,
      content: [
        { type: 'text/plain', value: sheet.text },
        { type: 'text/html', value: sheet.html },
      ],
      categories: ['kitchen-handoff'],
    }),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => '');
    return { ok: false, error: `SendGrid send failed (${res.status}): ${err.slice(0, 200)}` };
  }
  return { ok: true, to };
}
