// Volunteer role invitation. Same raw-fetch-to-SendGrid shape as the other
// helpers in this directory — no SDK for one HTTP POST.

export interface VolunteerInviteParams {
  toEmail: string;
  volunteerName: string;
  tournamentName: string;
  roleName: string;
  roleDescription: string | null;
  phaseLabel: string;         // "planning" or "day of the tournament"
  whenLabel: string | null;   // e.g. "Sep 15, 2026 · 6:30 AM"
  tasks: string[];            // what the role actually involves
  confirmUrl: string;
  organizerName: string | null;
}

export async function sendVolunteerInviteEmail(p: VolunteerInviteParams): Promise<{ ok: boolean; error?: string }> {
  const apiKey = process.env.SENDGRID_API_KEY;
  if (!apiKey) return { ok: false, error: 'Email is not configured (SENDGRID_API_KEY)' };

  const from = p.organizerName ? `${p.organizerName} via TourneyCoach` : 'TourneyCoach';
  const subject = `Can you take "${p.roleName}" for ${p.tournamentName}?`;

  // The tasks are the honest part of the ask. Someone deciding whether to say
  // yes wants to know what they are actually signing up for, not just a title.
  const taskList = p.tasks.length
    ? `\n\nWhat the role involves:\n${p.tasks.map((t) => `  • ${t}`).join('\n')}`
    : '';
  const when = p.whenLabel ? `\nWhen: ${p.whenLabel}` : '';

  const text = `Hi ${p.volunteerName},

You're being asked to take on "${p.roleName}" for ${p.tournamentName} — this is a ${p.phaseLabel} role.${when}
${p.roleDescription ? `\n${p.roleDescription}` : ''}${taskList}

Say yes or no here (no account needed):
${p.confirmUrl}

Thank you — events like this only happen because people say yes.`;

  const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: p.toEmail, name: p.volunteerName }] }],
      from: { email: 'noreply@tourneycoach.com', name: from },
      subject,
      content: [{ type: 'text/plain', value: text }],
    }),
  }).catch(() => null);

  if (!res) return { ok: false, error: 'Could not reach the email service' };
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return { ok: false, error: `SendGrid returned ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}` };
  }
  return { ok: true };
}

// SMS is deliberately short — it is a nudge with a link, not the whole ask.
// The email carries the task list; a 900-character text does not get read.
export function volunteerInviteSms(p: { volunteerName: string; tournamentName: string; roleName: string; confirmUrl: string }): string {
  return `TourneyCoach: ${p.volunteerName}, can you take "${p.roleName}" for ${p.tournamentName}? Say yes or no: ${p.confirmUrl}`;
}

export function volunteerReminderSms(p: { roleName: string; tournamentName: string; whenLabel: string; offsetLabel: string }): string {
  return `TourneyCoach reminder: "${p.roleName}" for ${p.tournamentName} starts ${p.offsetLabel} (${p.whenLabel}). Thank you!`;
}
