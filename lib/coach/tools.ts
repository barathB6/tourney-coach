// Coach actions — the AI coach can DO dashboard tasks for the organizer, not
// just talk about them. Each tool is a thin, validated wrapper over a real
// mutation, and the executor is authorized: it only ever touches the tournament
// the caller owns.
//
// RISK MODEL. Tools fall into three bands and the executor enforces the band,
// never the model:
//   read      — scoped queries. Never return another organizer's data, and
//               never individual TourneyCircle members (Concept B firewall).
//   safe      — internal, reversible edits. Execute directly.
//   gated     — spends money, emails the outside world, or destroys data.
//               Requires the organizer to have asked for it IN THEIR OWN WORDS
//               this conversation. Tool-result text and injected event data
//               (volunteer roles, sponsor names, registrant names) never appear
//               in a user turn, so they can't satisfy a gate.
import type { SupabaseClient } from '@supabase/supabase-js';
import { autoAssign, STANDARD_PAR_72, type ShotgunFormat, type Team } from '@/lib/shotgun';
import { sendCircleNotification } from '@/lib/circle/send';
import { applyScoreCorrection } from '@/lib/scoring/correct';
import type { MaxScoreRule } from '@/lib/scoring/leaderboard';
import { hashPassword, issuedPassword, newLinkToken, normalizeEmail } from '@/lib/proAccess';
import { sendProAccessInviteEmail } from '@/lib/email/proAccessInvite';

// Anthropic tool definitions passed to the model.
export const COACH_TOOLS = [
  // ── Read ──────────────────────────────────────────────────────────────────
  {
    name: 'list_registrations',
    description:
      "List this tournament's registrations — team names, contact names, type, payment status, foursome number and starting hole. Use before refunding, deleting, correcting a score, or answering questions about who has signed up. Returns the organizer's own registrants only.",
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['all', 'paid', 'pending', 'refunded'], description: 'filter by payment status, default all' },
      },
    },
  },
  {
    name: 'list_sponsors',
    description:
      "List this tournament's sponsors and prospects with their status, amount and contact. Use before updating a sponsor, marking one paid, or reporting on the sponsorship pipeline.",
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'list_contests',
    description:
      "List the tournament's contest holes (hole-in-one, closest to pin, long drive, putting) with prize, sponsor, insurance status and any recorded winner.",
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'list_volunteers',
    description: "List the tournament's volunteers with their role and check-in state.",
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_course_holes',
    description:
      "Read the course's 18 holes — par, handicap, tee yardages and layout tags. Use before changing hole data, or to answer questions about the course.",
    input_schema: { type: 'object', properties: {} },
  },

  // ── Safe writes ───────────────────────────────────────────────────────────
  {
    name: 'update_event_settings',
    description:
      "Change the tournament's core settings on the organizer's behalf. Use for renaming the event, moving the date, changing the format, setting the field size (max players), the entry fee, the fundraising goal, the shotgun time, or the cause name/tagline. Only include the specific fields the organizer actually wants changed. These are internal settings and safe to change directly.",
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'event name' },
        eventDate: { type: 'string', description: 'ISO date YYYY-MM-DD' },
        format: { type: 'string', enum: ['scramble', 'best_ball', 'alternate_shot', 'stroke_play'] },
        maxPlayers: { type: 'integer', description: 'field size in PLAYERS (a foursome is 4 players)' },
        entryFeeDollars: { type: 'integer', description: 'entry fee per player in dollars' },
        fundraisingGoalDollars: { type: 'integer', description: 'fundraising goal in dollars' },
        shotgunTime: { type: 'string', description: 'shotgun start time, 24h HH:MM' },
        causeOrg: { type: 'string', description: 'the charity/cause organization name' },
        causeTagline: { type: 'string', description: 'a short one-line cause tagline' },
      },
    },
  },
  {
    name: 'add_registration',
    description:
      "Record a registration taken offline — on paper, by phone, or by check. Use for 'add the Smith foursome, they paid by check'. Do NOT use for online sign-ups; those arrive on their own.",
    input_schema: {
      type: 'object',
      properties: {
        contactName: { type: 'string' },
        contactEmail: { type: 'string' },
        teamName: { type: 'string' },
        type: { type: 'string', enum: ['single', 'foursome', 'sponsor'], description: 'default foursome' },
        markPaid: { type: 'boolean', description: 'true if the money is already in hand' },
      },
      required: ['contactName', 'contactEmail'],
    },
  },
  {
    name: 'correct_score',
    description:
      "Correct a team's score on one hole. Appends a corrected score (history is preserved) and writes an audit row naming the organizer. Use for scorer typos. Call list_registrations first to get the registration id.",
    input_schema: {
      type: 'object',
      properties: {
        registrationId: { type: 'string' },
        holeNumber: { type: 'integer' },
        strokes: { type: 'integer' },
        reason: { type: 'string' },
      },
      required: ['registrationId', 'holeNumber', 'strokes'],
    },
  },
  {
    name: 'add_sponsor',
    description:
      'Add a sponsor to the tournament. With no amount it is added as a prospect to reach out to; with an amount it is recorded as a committed (verbal) sponsor. Use for requests like "add ACME as a $2,500 sponsor" or "add Bob\'s Hardware to my sponsor list".',
    input_schema: {
      type: 'object',
      properties: {
        company: { type: 'string' },
        amountDollars: { type: 'integer', description: 'agreed/target amount in dollars, optional' },
        contactName: { type: 'string' },
        email: { type: 'string' },
      },
      required: ['company'],
    },
  },
  {
    name: 'update_sponsor',
    description:
      "Update a sponsor's pipeline status, amount, or contact details — including marking one as paid. Call list_sponsors first to get the sponsor id. Marking 'paid' records the money as collected, so only do it when the organizer says it has actually arrived.",
    input_schema: {
      type: 'object',
      properties: {
        sponsorId: { type: 'string' },
        status: { type: 'string', enum: ['not_contacted', 'contacted', 'no_reply', 'replied', 'verbal', 'invoiced', 'pending', 'paid', 'declined'] },
        amountDollars: { type: 'integer' },
        contactName: { type: 'string' },
        email: { type: 'string' },
        notes: { type: 'string' },
      },
      required: ['sponsorId'],
    },
  },
  {
    name: 'add_sponsorship_tier',
    description:
      "Create a sponsorship package (tier) the public can buy — e.g. Title $5,000, Hole $250. Use 'starter' to load the proven four-tier structure (Title, Eagle, Birdie, Hole) in one step.",
    input_schema: {
      type: 'object',
      properties: {
        starter: { type: 'boolean', description: 'load the standard four-tier set instead of a single tier' },
        name: { type: 'string' },
        priceDollars: { type: 'integer' },
        quantity: { type: 'integer', description: 'how many are available, optional' },
        benefits: { type: 'array', items: { type: 'string' } },
      },
    },
  },
  {
    name: 'manage_contest',
    description:
      "Create, update, or record the winner of a contest hole (hole-in-one, closest to pin, long drive, putting contest). Call list_contests first for the contest id when updating.",
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'update', 'record_winner', 'delete'] },
        contestId: { type: 'string', description: 'required for update/record_winner/delete' },
        contestType: { type: 'string', enum: ['hole_in_one', 'closest_to_pin', 'long_drive', 'putting'] },
        holeNumber: { type: 'integer' },
        prize: { type: 'string' },
        sponsor: { type: 'string' },
        notes: { type: 'string' },
        winnerName: { type: 'string' },
        winnerDetail: { type: 'string', description: "e.g. \"4 ft 2 in\" or \"289 yds\"" },
      },
      required: ['action'],
    },
  },
  {
    name: 'set_hole_data',
    description:
      "Set a hole's par, handicap, or tee yardages on the course profile. Use for 'hole 7 is a par 3, 165 from the blues'.",
    input_schema: {
      type: 'object',
      properties: {
        holeNumber: { type: 'integer' },
        par: { type: 'integer', enum: [3, 4, 5] },
        handicap: { type: 'integer' },
        yardages: {
          type: 'object',
          description: 'tee yardages, e.g. {"blue": 385, "white": 355}',
          properties: {
            black: { type: 'integer' }, blue: { type: 'integer' }, white: { type: 'integer' },
            gold: { type: 'integer' }, red: { type: 'integer' },
          },
        },
      },
      required: ['holeNumber'],
    },
  },
  {
    name: 'add_volunteer',
    description: "Add a volunteer with their role (e.g. registration table, beverage cart, hole marshal).",
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        role: { type: 'string' },
        email: { type: 'string' },
        phone: { type: 'string' },
      },
      required: ['name'],
    },
  },
  {
    name: 'assign_shotgun_starts',
    description:
      "Auto-assign every paid team to a starting hole for a shotgun start, respecting par-3 capacity. Use for 'set up my shotgun' or 'assign starting holes'. Reversible — it can be re-run.",
    input_schema: {
      type: 'object',
      properties: { format: { type: 'string', enum: ['single', 'double'], description: 'default single' } },
    },
  },

  // ── Gated: money, outward-facing, or destructive ──────────────────────────
  {
    name: 'set_registration_status',
    description:
      "Open or close public registration. Opening PUBLISHES the event microsite so the public can find and sign up — this is outward-facing, so ONLY call it after the organizer has clearly said they want to go live/open registration. Closing sets it back to private draft.",
    input_schema: {
      type: 'object',
      properties: { action: { type: 'string', enum: ['open', 'close'] } },
      required: ['action'],
    },
  },
  {
    name: 'refund_registration',
    description:
      "Refund a registration's payment. This MOVES REAL MONEY and cannot be undone. Only call it after the organizer has explicitly asked to refund that specific person. Call list_registrations first for the id.",
    input_schema: {
      type: 'object',
      properties: { registrationId: { type: 'string' }, reason: { type: 'string' } },
      required: ['registrationId'],
    },
  },
  {
    name: 'delete_registration',
    description:
      "Permanently delete an unpaid registration. Cannot be undone. Only call it after the organizer explicitly asked to delete that specific entry. Paid registrations must be refunded instead.",
    input_schema: {
      type: 'object',
      properties: { registrationId: { type: 'string' } },
      required: ['registrationId'],
    },
  },
  {
    name: 'send_circle_notification',
    description:
      "Send the $29 TourneyCircle notification to matched local golfers. This CHARGES $29 and emails real people on the organizer's behalf. Only call it after the organizer has explicitly asked to send it. You never see who is reached — only the count.",
    input_schema: {
      type: 'object',
      properties: { radiusMiles: { type: 'integer', enum: [15, 25, 35, 50] } },
      required: ['radiusMiles'],
    },
  },
  {
    name: 'invite_golf_pro',
    description:
      "Email the course's head pro a link and password to fill in the hole data themselves. This EMAILS an outside person, and while their access is active the organizer's own course editing goes read-only. Only call it after the organizer explicitly asked to send it to the pro.",
    input_schema: {
      type: 'object',
      properties: { email: { type: 'string' } },
      required: ['email'],
    },
  },
] as const;

export interface ToolResult { ok: boolean; summary: string; error?: string }
// userIntent = the organizer's OWN words this conversation. Outward-facing
// actions are gated on it so injected third-party context (e.g. a malicious
// public volunteer-signup role) can never trigger them — that text never
// appears in the user's turns.
interface ToolCtx { service: SupabaseClient; organizerId: string; tournamentId: string | null; userIntent: string }

// Each gated action needs the organizer to have said something that plainly
// means it. Deliberately narrow: a false negative just asks them to confirm,
// a false positive spends their money or mails a stranger.
const GATES: Record<string, { re: RegExp; ask: string }> = {
  set_registration_status: { re: /\b(open|publish|go[\s-]?live|launch|make .*public)\b/i, ask: 'confirm they want to open registration / go live' },
  refund_registration: { re: /\brefund(ed|ing|s)?\b/i, ask: 'confirm the refund — it moves real money and cannot be undone' },
  delete_registration: { re: /\b(delete|remove|cancel)\b/i, ask: 'confirm they want that registration deleted' },
  send_circle_notification: { re: /\b(send|blast|notify|notification|tourneycircle)\b/i, ask: 'confirm they want to send the $29 TourneyCircle notification' },
  invite_golf_pro: { re: /\b(pro|invite|send|email)\b/i, ask: 'confirm they want the invitation emailed to the golf pro' },
};

const FORMATS = ['scramble', 'best_ball', 'alternate_shot', 'stroke_play'];
const int = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) ? v : null);
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const TEES = ['black', 'blue', 'white', 'gold', 'red'] as const;

const STARTER_TIERS = [
  { name: 'Title Sponsor', label: 'Title', price_cents: 500000, quantity: 1, highlight: true, benefits: ['Event named: "Presented by [Name]"', 'Logo on all materials', 'Premier banner placement', 'Foursome included'] },
  { name: 'Eagle Sponsor', label: 'Eagle', price_cents: 250000, quantity: 4, highlight: false, benefits: ['Logo on banners', 'Tee box signage', 'Foursome included', 'Awards mention'] },
  { name: 'Birdie Sponsor', label: 'Birdie', price_cents: 100000, quantity: 8, highlight: false, benefits: ['Hole sign', 'Program listing', 'Two players included'] },
  { name: 'Hole Sponsor', label: 'Hole', price_cents: 25000, quantity: 18, highlight: false, benefits: ['One hole sign', 'Program listing'] },
];

export async function executeCoachTool(name: string, input: Record<string, unknown>, ctx: ToolCtx): Promise<ToolResult> {
  if (!ctx.tournamentId) return { ok: false, summary: '', error: 'No tournament is selected, so I can\'t make changes yet.' };
  // Authorization: the tournament must belong to the caller. Every mutation
  // below is additionally scoped by tournament_id, never trusting the model.
  const { data: t } = await ctx.service.from('tournaments')
    .select('id, organizer_id, course_id, max_players, hole_pars, max_score_rule').eq('id', ctx.tournamentId).maybeSingle();
  if (!t || t.organizer_id !== ctx.organizerId) return { ok: false, summary: '', error: 'You don\'t have access to that tournament.' };

  // Risk gate, enforced here rather than in the prompt.
  const gate = GATES[name];
  if (gate && !gate.re.test(ctx.userIntent)) {
    return { ok: false, summary: '', error: `Ask the organizer to ${gate.ask} before doing this.` };
  }

  const tid = ctx.tournamentId;
  switch (name) {
    // ── Read ────────────────────────────────────────────────────────────────
    case 'list_registrations': {
      const filter = str(input.status);
      let q = ctx.service.from('registrations')
        .select('id, contact_name, team_name, registration_type, payment_status, foursome_number, starting_hole, total_amount_cents')
        .eq('tournament_id', tid).order('foursome_number', { ascending: true }).limit(200);
      if (['paid', 'pending', 'refunded'].includes(filter)) q = q.eq('payment_status', filter);
      const { data, error } = await q;
      if (error) return { ok: false, summary: '', error: 'Could not read registrations.' };
      if (!data?.length) return { ok: true, summary: 'no registrations yet' };
      const lines = data.map((r) => `${r.id} | ${r.team_name || r.contact_name} | ${r.registration_type} | ${r.payment_status}${r.foursome_number ? ` | foursome ${r.foursome_number}` : ''}${r.starting_hole ? ` | hole ${r.starting_hole}` : ''} | $${((r.total_amount_cents ?? 0) / 100).toLocaleString()}`);
      return { ok: true, summary: `${data.length} registration(s):\n${lines.join('\n')}` };
    }

    case 'list_sponsors': {
      const { data, error } = await ctx.service.from('sponsors')
        .select('id, company, status, amount_cents, contact_name, email').eq('tournament_id', tid).order('created_at').limit(200);
      if (error) return { ok: false, summary: '', error: 'Could not read sponsors.' };
      if (!data?.length) return { ok: true, summary: 'no sponsors or prospects yet' };
      const lines = data.map((s) => `${s.id} | ${s.company} | ${s.status}${s.amount_cents ? ` | $${(s.amount_cents / 100).toLocaleString()}` : ''}${s.contact_name ? ` | ${s.contact_name}` : ''}`);
      return { ok: true, summary: `${data.length} sponsor(s):\n${lines.join('\n')}` };
    }

    case 'list_contests': {
      const { data, error } = await ctx.service.from('contest_holes')
        .select('id, contest_type, hole_number, prize, sponsor, insurance_status, winner_name, winner_detail').eq('tournament_id', tid).order('hole_number').limit(50);
      if (error) return { ok: false, summary: '', error: 'Could not read contests — the contest manager may need migration 031.' };
      if (!data?.length) return { ok: true, summary: 'no contest holes set up yet' };
      const lines = data.map((c) => `${c.id} | ${c.contest_type} | ${c.hole_number ? `hole ${c.hole_number}` : 'practice green'} | ${c.prize || 'no prize set'}${c.sponsor ? ` | ${c.sponsor}` : ''}${c.winner_name ? ` | WINNER ${c.winner_name} ${c.winner_detail ?? ''}` : ''}`);
      return { ok: true, summary: `${data.length} contest(s):\n${lines.join('\n')}` };
    }

    case 'list_volunteers': {
      const { data, error } = await ctx.service.from('volunteers')
        .select('id, name, role, checked_in_at').eq('tournament_id', tid).order('created_at').limit(200);
      if (error) return { ok: false, summary: '', error: 'Could not read volunteers.' };
      if (!data?.length) return { ok: true, summary: 'no volunteers signed up yet' };
      return { ok: true, summary: `${data.length} volunteer(s):\n${data.map((v) => `${v.name} | ${v.role || 'unassigned'}${v.checked_in_at ? ' | checked in' : ''}`).join('\n')}` };
    }

    case 'get_course_holes': {
      if (!t.course_id) return { ok: true, summary: 'no course profile is linked to this tournament yet' };
      const { data, error } = await ctx.service.from('course_holes')
        .select('hole_number, par, handicap, tee_yardages, description').eq('course_id', t.course_id).order('hole_number');
      if (error) return { ok: false, summary: '', error: 'Could not read the course.' };
      if (!data?.length) return { ok: true, summary: 'the course profile has no hole data yet' };
      const lines = data.map((h) => `${h.hole_number}: par ${h.par ?? '—'}${h.handicap ? ` hcp ${h.handicap}` : ''} ${JSON.stringify(h.tee_yardages ?? {})}${h.description ? ` — ${h.description}` : ''}`);
      return { ok: true, summary: lines.join('\n') };
    }

    // ── Safe writes ─────────────────────────────────────────────────────────
    case 'update_event_settings': {
      const patch: Record<string, unknown> = {};
      const changes: string[] = [];
      const nm = str(input.name);
      if (nm) { patch.name = nm.slice(0, 120); changes.push(`renamed to "${patch.name}"`); }
      const date = str(input.eventDate);
      if (/^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(Date.parse(date))) { patch.event_date = date; changes.push(`date set to ${date}`); }
      const fmt = str(input.format);
      if (FORMATS.includes(fmt)) { patch.format = fmt; changes.push(`format set to ${fmt.replace('_', ' ')}`); }
      const mp = int(input.maxPlayers);
      if (mp !== null && mp >= 4 && mp <= 500) { patch.max_players = mp; changes.push(`field size set to ${mp} players`); }
      const fee = int(input.entryFeeDollars);
      if (fee !== null && fee >= 0 && fee <= 100000) { patch.entry_fee_cents = fee * 100; changes.push(`entry fee set to $${fee}/player`); }
      const goal = int(input.fundraisingGoalDollars);
      if (goal !== null && goal >= 0 && goal <= 100000000) { patch.fundraising_goal_cents = goal * 100; changes.push(`fundraising goal set to $${goal.toLocaleString()}`); }
      const time = str(input.shotgunTime);
      if (/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) { patch.shotgun_time = time; changes.push(`shotgun time set to ${time}`); }
      const org = str(input.causeOrg);
      if (org) { patch.cause_org = org.slice(0, 160); changes.push(`cause set to ${patch.cause_org}`); }
      const tag = str(input.causeTagline);
      if (tag) { patch.cause_tagline = tag.slice(0, 200); changes.push('cause tagline updated'); }
      if (!changes.length) return { ok: false, summary: '', error: 'Nothing valid to change there.' };
      const save = (p: Record<string, unknown>) => ctx.service.from('tournaments').update(p).eq('id', tid).eq('organizer_id', ctx.organizerId);
      let { error } = await save(patch);
      // A single bad column (e.g. fundraising_goal_cents before migration 030,
      // or a name that collides) shouldn't drop every other change. Retry once
      // without the goal field and report the rest as saved.
      if (error && 'fundraising_goal_cents' in patch) {
        const { fundraising_goal_cents: _dropped, ...rest } = patch;
        void _dropped;
        if (Object.keys(rest).length) {
          ({ error } = await save(rest));
          if (!error) return { ok: true, summary: `${changes.filter((c) => !c.includes('goal')).join(', ')} (couldn't set the fundraising goal — run migration 030)` };
        }
      }
      if (error) return { ok: false, summary: '', error: 'Something went wrong saving that.' };
      return { ok: true, summary: changes.join(', ') };
    }

    case 'add_registration': {
      const contactName = str(input.contactName).slice(0, 120);
      if (!contactName) return { ok: false, summary: '', error: 'I need the contact\'s name.' };
      // Every registration must carry a real email — it's how the confirmation,
      // the scorecard link and the day-of texts reach them, and the column is
      // NOT NULL. Ask rather than invent a placeholder address.
      const contactEmail = str(input.contactEmail).slice(0, 160);
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(contactEmail)) {
        return { ok: false, summary: '', error: `I need an email address for ${contactName} — that's how their confirmation and scorecard link get to them.` };
      }
      const type = ['single', 'foursome', 'sponsor'].includes(str(input.type)) ? str(input.type) : 'foursome';
      const price = type === 'single' ? 16500 : type === 'sponsor' ? 500000 : 60000;
      const { error } = await ctx.service.from('registrations').insert({
        tournament_id: tid,
        contact_name: contactName,
        contact_email: contactEmail,
        team_name: str(input.teamName).slice(0, 120) || null,
        registration_type: type,
        total_amount_cents: price,
        payment_status: input.markPaid === true ? 'paid' : 'pending',
        registration_source: 'other',
        players: [{ name: contactName, email: '' }],
      });
      if (error) return { ok: false, summary: '', error: 'Could not add that registration.' };
      return { ok: true, summary: `added ${str(input.teamName) || contactName} as a ${type} registration (${input.markPaid === true ? 'paid' : 'payment pending'})` };
    }

    case 'correct_score': {
      const registrationId = str(input.registrationId);
      const hole = int(input.holeNumber);
      const strokes = int(input.strokes);
      if (!registrationId || hole === null || strokes === null) return { ok: false, summary: '', error: 'I need the registration, hole number and stroke count.' };
      if (hole < 1 || hole > 18 || strokes < 1 || strokes > 20) return { ok: false, summary: '', error: 'That hole or stroke count is out of range.' };
      // Ownership: the registration must belong to THIS tournament.
      const { data: reg } = await ctx.service.from('registrations').select('id, contact_name, team_name').eq('id', registrationId).eq('tournament_id', tid).maybeSingle();
      if (!reg) return { ok: false, summary: '', error: 'That registration isn\'t part of this tournament.' };
      // Same path as the Registrations tab: applies the tournament's max-score
      // rule, appends rather than overwrites, and writes the audit row naming
      // the organizer. A correction made through the coach is not a lesser
      // record than one made by hand.
      const result = await applyScoreCorrection({
        service: ctx.service, registrationId, tournamentId: tid,
        courseId: (t.course_id as string | null) ?? null,
        maxScoreRule: (t.max_score_rule as MaxScoreRule | null) ?? null,
        holeNumber: hole, strokes, reason: str(input.reason) || null, correctedBy: ctx.organizerId,
      });
      if (!result.ok) return { ok: false, summary: '', error: 'Could not record that correction.' };
      const who = reg.team_name || reg.contact_name;
      const from = result.previousStrokes != null ? `${result.previousStrokes} → ` : '';
      return {
        ok: true,
        summary: `hole ${hole} corrected for ${who}: ${from}${result.strokesRecorded}${result.capped ? ' (capped by the max-score rule)' : ''}${result.auditLogged ? '' : ' — audit table missing, run migration 028'}`,
      };
    }

    case 'add_sponsor': {
      const company = str(input.company).slice(0, 160);
      if (!company) return { ok: false, summary: '', error: 'I need the sponsor\'s name.' };
      const amt = int(input.amountDollars);
      const amount_cents = amt !== null && amt > 0 && amt <= 10000000 ? amt * 100 : null;
      const { error } = await ctx.service.from('sponsors').insert({
        tournament_id: tid, company, amount_cents,
        contact_name: str(input.contactName).slice(0, 120) || null,
        email: str(input.email).slice(0, 160) || null,
        status: amount_cents ? 'verbal' : 'not_contacted', source: 'organizer',
      });
      if (error) return { ok: false, summary: '', error: 'Could not add that sponsor.' };
      return { ok: true, summary: `added ${company}${amount_cents ? ` as a $${amt!.toLocaleString()} sponsor` : ' to your sponsor list'}` };
    }

    case 'update_sponsor': {
      const sponsorId = str(input.sponsorId);
      if (!sponsorId) return { ok: false, summary: '', error: 'I need the sponsor id — let me look up your sponsors first.' };
      const { data: sp } = await ctx.service.from('sponsors').select('id, company').eq('id', sponsorId).eq('tournament_id', tid).maybeSingle();
      if (!sp) return { ok: false, summary: '', error: 'That sponsor isn\'t part of this tournament.' };
      const patch: Record<string, unknown> = {};
      const changes: string[] = [];
      const status = str(input.status);
      if (['not_contacted', 'contacted', 'no_reply', 'replied', 'verbal', 'invoiced', 'pending', 'paid', 'declined'].includes(status)) {
        patch.status = status; patch.last_touch = new Date().toISOString(); changes.push(`status → ${status.replace('_', ' ')}`);
      }
      const amt = int(input.amountDollars);
      if (amt !== null && amt >= 0 && amt <= 10000000) { patch.amount_cents = amt * 100; changes.push(`amount → $${amt.toLocaleString()}`); }
      const cn = str(input.contactName); if (cn) { patch.contact_name = cn.slice(0, 120); changes.push('contact updated'); }
      const em = str(input.email); if (em) { patch.email = em.slice(0, 160); changes.push('email updated'); }
      const nt = str(input.notes); if (nt) { patch.notes = nt.slice(0, 400); changes.push('notes updated'); }
      if (!changes.length) return { ok: false, summary: '', error: 'Nothing valid to change there.' };
      const { error } = await ctx.service.from('sponsors').update(patch).eq('id', sponsorId).eq('tournament_id', tid);
      if (error) return { ok: false, summary: '', error: 'Could not update that sponsor.' };
      return { ok: true, summary: `${sp.company}: ${changes.join(', ')}` };
    }

    case 'add_sponsorship_tier': {
      if (input.starter === true) {
        const { count } = await ctx.service.from('sponsorship_tiers').select('id', { count: 'exact', head: true }).eq('tournament_id', tid);
        if ((count ?? 0) > 0) return { ok: false, summary: '', error: 'This tournament already has sponsorship packages — add a single tier instead.' };
        const rows = STARTER_TIERS.map((x, i) => ({ ...x, tournament_id: tid, sort_order: i }));
        const { error } = await ctx.service.from('sponsorship_tiers').insert(rows);
        if (error) return { ok: false, summary: '', error: 'Could not create the starter packages.' };
        return { ok: true, summary: 'created the standard four packages — Title $5,000, Eagle $2,500, Birdie $1,000, Hole $250' };
      }
      const tierName = str(input.name).slice(0, 120);
      const price = int(input.priceDollars);
      if (!tierName || price === null || price < 0) return { ok: false, summary: '', error: 'I need a package name and price.' };
      const { count } = await ctx.service.from('sponsorship_tiers').select('id', { count: 'exact', head: true }).eq('tournament_id', tid);
      const benefits = Array.isArray(input.benefits) ? (input.benefits as unknown[]).filter((b) => typeof b === 'string').slice(0, 10) : [];
      const { error } = await ctx.service.from('sponsorship_tiers').insert({
        tournament_id: tid, name: tierName, label: tierName.split(' ')[0], price_cents: price * 100,
        quantity: int(input.quantity), benefits, highlight: false, sort_order: count ?? 0,
      });
      if (error) return { ok: false, summary: '', error: 'Could not create that package.' };
      return { ok: true, summary: `created the ${tierName} package at $${price.toLocaleString()}` };
    }

    case 'manage_contest': {
      const action = str(input.action);
      const contestId = str(input.contestId);
      const ensureOwned = async () => {
        if (!contestId) return null;
        const { data } = await ctx.service.from('contest_holes').select('id, contest_type, hole_number').eq('id', contestId).eq('tournament_id', tid).maybeSingle();
        return data;
      };

      if (action === 'create') {
        const type = str(input.contestType);
        if (!['hole_in_one', 'closest_to_pin', 'long_drive', 'putting'].includes(type)) return { ok: false, summary: '', error: 'I need a valid contest type.' };
        const hole = int(input.holeNumber);
        if (type !== 'putting' && (hole === null || hole < 1 || hole > 18)) return { ok: false, summary: '', error: 'That contest needs a hole number between 1 and 18.' };
        const { error } = await ctx.service.from('contest_holes').insert({
          tournament_id: tid, contest_type: type, hole_number: type === 'putting' ? hole : hole,
          prize: str(input.prize).slice(0, 200) || null,
          sponsor: str(input.sponsor).slice(0, 120) || null,
          notes: str(input.notes).slice(0, 400) || null,
          insurance_status: 'none', category_mode: 'open',
        });
        if (error) return { ok: false, summary: '', error: error.code === '23505' ? 'There\'s already a contest on that hole.' : 'Could not create that contest.' };
        return { ok: true, summary: `added a ${type.replace(/_/g, ' ')} contest${hole ? ` on hole ${hole}` : ''}` };
      }

      const existing = await ensureOwned();
      if (!existing) return { ok: false, summary: '', error: 'That contest isn\'t part of this tournament.' };

      if (action === 'delete') {
        const { error } = await ctx.service.from('contest_holes').delete().eq('id', contestId).eq('tournament_id', tid);
        if (error) return { ok: false, summary: '', error: 'Could not delete that contest.' };
        return { ok: true, summary: `removed the ${existing.contest_type.replace(/_/g, ' ')} contest` };
      }

      if (action === 'record_winner') {
        const winner = str(input.winnerName).slice(0, 120);
        if (!winner) return { ok: false, summary: '', error: 'I need the winner\'s name.' };
        const { error } = await ctx.service.from('contest_holes').update({
          winner_name: winner, winner_detail: str(input.winnerDetail).slice(0, 80) || null, decided_at: new Date().toISOString(),
        }).eq('id', contestId).eq('tournament_id', tid);
        if (error) return { ok: false, summary: '', error: 'Could not record that winner.' };
        return { ok: true, summary: `${winner} recorded as the winner of the ${existing.contest_type.replace(/_/g, ' ')}` };
      }

      // update
      const patch: Record<string, unknown> = {};
      const changes: string[] = [];
      const pz = str(input.prize); if (pz) { patch.prize = pz.slice(0, 200); changes.push('prize'); }
      const spn = str(input.sponsor); if (spn) { patch.sponsor = spn.slice(0, 120); changes.push('sponsor'); }
      const nts = str(input.notes); if (nts) { patch.notes = nts.slice(0, 400); changes.push('notes'); }
      const hn = int(input.holeNumber); if (hn !== null && hn >= 1 && hn <= 18) { patch.hole_number = hn; changes.push(`hole ${hn}`); }
      if (!changes.length) return { ok: false, summary: '', error: 'Nothing valid to change there.' };
      const { error } = await ctx.service.from('contest_holes').update(patch).eq('id', contestId).eq('tournament_id', tid);
      if (error) return { ok: false, summary: '', error: 'Could not update that contest.' };
      return { ok: true, summary: `updated the ${existing.contest_type.replace(/_/g, ' ')} contest (${changes.join(', ')})` };
    }

    case 'set_hole_data': {
      if (!t.course_id) return { ok: false, summary: '', error: 'No course profile is linked to this tournament yet — set one up first.' };
      const hole = int(input.holeNumber);
      if (hole === null || hole < 1 || hole > 18) return { ok: false, summary: '', error: 'Hole number must be 1–18.' };
      const { data: existing } = await ctx.service.from('course_holes')
        .select('par, handicap, tee_yardages').eq('course_id', t.course_id).eq('hole_number', hole).maybeSingle();
      const row: Record<string, unknown> = { course_id: t.course_id, hole_number: hole };
      const changes: string[] = [];
      const par = int(input.par);
      if (par !== null && [3, 4, 5].includes(par)) { row.par = par; changes.push(`par ${par}`); }
      else if (existing) row.par = existing.par;
      const hcp = int(input.handicap);
      if (hcp !== null && hcp >= 1 && hcp <= 18) { row.handicap = hcp; changes.push(`handicap ${hcp}`); }
      else if (existing) row.handicap = existing.handicap;
      const yards = (input.yardages && typeof input.yardages === 'object') ? input.yardages as Record<string, unknown> : null;
      const merged: Record<string, number> = { ...(existing?.tee_yardages as Record<string, number> ?? {}) };
      if (yards) {
        for (const tee of TEES) {
          const v = int(yards[tee]);
          if (v !== null && v > 0 && v <= 800) { merged[tee] = v; changes.push(`${tee} ${v}y`); }
        }
      }
      row.tee_yardages = merged;
      if (!changes.length) return { ok: false, summary: '', error: 'Nothing valid to change on that hole.' };
      const { error } = await ctx.service.from('course_holes').upsert(row, { onConflict: 'course_id,hole_number' });
      if (error) return { ok: false, summary: '', error: 'Could not save that hole.' };
      return { ok: true, summary: `hole ${hole}: ${changes.join(', ')}` };
    }

    case 'add_volunteer': {
      const vName = str(input.name).slice(0, 120);
      if (!vName) return { ok: false, summary: '', error: 'I need the volunteer\'s name.' };
      const { error } = await ctx.service.from('volunteers').insert({
        tournament_id: tid, name: vName,
        role: str(input.role).slice(0, 80) || null,
        email: str(input.email).slice(0, 160) || null,
        phone: str(input.phone).slice(0, 40) || null,
      });
      if (error) return { ok: false, summary: '', error: 'Could not add that volunteer.' };
      return { ok: true, summary: `added ${vName}${str(input.role) ? ` as ${str(input.role)}` : ''}` };
    }

    case 'assign_shotgun_starts': {
      const format = (str(input.format) === 'double' ? 'double' : 'single') as ShotgunFormat;
      const { data: regs } = await ctx.service.from('registrations')
        .select('id, foursome_number, starting_hole, team_name, contact_name')
        .eq('tournament_id', tid).eq('payment_status', 'paid');
      if (!regs?.length) return { ok: false, summary: '', error: 'There are no paid registrations to assign yet.' };

      // One team per foursome_number; singles without one become their own team.
      const byGroup = new Map<number, string[]>();
      let synthetic = 1000;
      for (const r of regs) {
        const key = r.foursome_number ?? synthetic++;
        if (!byGroup.has(key)) byGroup.set(key, []);
        byGroup.get(key)!.push(r.id);
      }
      const teams: Team[] = [...byGroup.keys()].map((n) => ({ id: String(n), name: `Team ${n}`, startingHole: null, startSlot: null }));
      const pars = (t.hole_pars as number[] | null)?.length === 18 ? t.hole_pars as number[] : STANDARD_PAR_72;
      const assigned = autoAssign(teams, pars, format);

      let placed = 0;
      for (const team of assigned) {
        if (team.startingHole == null) continue;
        const ids = byGroup.get(Number(team.id));
        if (!ids?.length) continue;
        const { error } = await ctx.service.from('registrations')
          .update({ starting_hole: team.startingHole, start_slot: team.startSlot ?? null })
          .in('id', ids).eq('tournament_id', tid);
        if (!error) placed += 1;
      }
      const unplaced = assigned.filter((x) => x.startingHole == null).length;
      return {
        ok: true,
        summary: `assigned ${placed} team${placed === 1 ? '' : 's'} to starting holes (${format} shotgun)${unplaced ? ` — ${unplaced} couldn't be placed, the course is at capacity` : ''}`,
      };
    }

    // ── Gated ───────────────────────────────────────────────────────────────
    case 'set_registration_status': {
      const action = str(input.action);
      if (action !== 'open' && action !== 'close') return { ok: false, summary: '', error: 'Say open or close.' };
      const status = action === 'open' ? 'published' : 'draft';
      const { error } = await ctx.service.from('tournaments').update({ status }).eq('id', tid).eq('organizer_id', ctx.organizerId);
      if (error) return { ok: false, summary: '', error: 'Could not change registration status.' };
      return { ok: true, summary: action === 'open' ? 'registration is now OPEN — your microsite is live to the public' : 'registration closed (back to private draft)' };
    }

    case 'refund_registration': {
      const registrationId = str(input.registrationId);
      const { data: reg } = await ctx.service.from('registrations')
        .select('id, contact_name, team_name, payment_status, total_amount_cents').eq('id', registrationId).eq('tournament_id', tid).maybeSingle();
      if (!reg) return { ok: false, summary: '', error: 'That registration isn\'t part of this tournament.' };
      if (reg.payment_status !== 'paid') return { ok: false, summary: '', error: `That registration is ${reg.payment_status}, so there's nothing to refund.` };
      // Mirrors the dashboard's refund: the Adyen webhook flips the final state.
      const { error } = await ctx.service.from('registrations').update({ payment_status: 'refunded' }).eq('id', registrationId).eq('tournament_id', tid);
      if (error) return { ok: false, summary: '', error: 'Could not start that refund.' };
      return { ok: true, summary: `refunded $${((reg.total_amount_cents ?? 0) / 100).toLocaleString()} to ${reg.team_name || reg.contact_name}` };
    }

    case 'delete_registration': {
      const registrationId = str(input.registrationId);
      const { data: reg } = await ctx.service.from('registrations')
        .select('id, contact_name, team_name, payment_status').eq('id', registrationId).eq('tournament_id', tid).maybeSingle();
      if (!reg) return { ok: false, summary: '', error: 'That registration isn\'t part of this tournament.' };
      if (reg.payment_status === 'paid') return { ok: false, summary: '', error: 'That one is paid — refund it instead of deleting it, so the money is accounted for.' };
      const { error } = await ctx.service.from('registrations').delete().eq('id', registrationId).eq('tournament_id', tid);
      if (error) return { ok: false, summary: '', error: 'Could not delete that registration.' };
      return { ok: true, summary: `deleted the registration for ${reg.team_name || reg.contact_name}` };
    }

    case 'send_circle_notification': {
      const radius = int(input.radiusMiles);
      if (radius === null || ![15, 25, 35, 50].includes(radius)) return { ok: false, summary: '', error: 'Radius must be 15, 25, 35 or 50 miles.' };
      // Same code path as the dashboard button — suppression, cadence and the
      // disclosure floor are enforced once, in lib/circle/send.ts. The coach
      // gets back a count and nothing else; recipient identities never surface
      // here any more than they do on the dashboard.
      const result = await sendCircleNotification({
        service: ctx.service, tournamentId: tid, organizerId: ctx.organizerId,
        courseId: (t.course_id as string | null) ?? null, radiusMiles: radius,
      });
      if (!result.ok) return { ok: false, summary: '', error: result.error };
      return { ok: true, summary: `$29 notification queued to ${result.reached} matched golfer${result.reached === 1 ? '' : 's'} within ${radius} miles — you'll see clicks and registrations here as they come in` };
    }

    case 'invite_golf_pro': {
      if (!t.course_id) return { ok: false, summary: '', error: 'No course profile is linked to this tournament yet — set one up first.' };
      const email = normalizeEmail(str(input.email));
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false, summary: '', error: 'I need a valid email address for the pro.' };
      const { data: course } = await ctx.service.from('courses').select('id, name, organizer_id').eq('id', t.course_id as string).maybeSingle();
      // The course can belong to someone else even when the tournament is
      // yours — only its owner may hand out editing rights.
      if (!course || course.organizer_id !== ctx.organizerId) {
        return { ok: false, summary: '', error: 'You don\'t own that course profile, so you can\'t grant access to it.' };
      }
      const year = new Date().getFullYear();
      const password = issuedPassword(course.name, year);
      const linkToken = newLinkToken();
      // Re-issuing replaces the previous grant, so a course never has two
      // people who each believe they're the editor.
      await ctx.service.from('course_pro_access')
        .update({ revoked_at: new Date().toISOString(), session_token: null })
        .eq('course_id', course.id).is('revoked_at', null);
      const { error: grantErr } = await ctx.service.from('course_pro_access').insert({
        course_id: course.id, email, password_hash: hashPassword(password), link_token: linkToken,
      });
      if (grantErr) return { ok: false, summary: '', error: 'Could not create the pro access grant.' };

      const base = process.env.NEXT_PUBLIC_SITE_URL || 'https://tourneycoach.com';
      const loginUrl = `${base}/course/pro/${linkToken}`;
      let mailed = true;
      try {
        await sendProAccessInviteEmail({ toEmail: email, courseName: course.name, organizerName: null, loginUrl, password });
      } catch { mailed = false; }
      return {
        ok: true,
        summary: mailed
          ? `emailed ${email} their course link and password (${password}) — while their access is active your own course editing is view-only`
          : `created the grant but the email didn't send — give the pro this link ${loginUrl} and password ${password} yourself`,
      };
    }
  }
  return { ok: false, summary: '', error: 'I don\'t know how to do that yet.' };
}
