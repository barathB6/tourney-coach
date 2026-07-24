// Coach actions — the AI coach can DO dashboard tasks for the organizer, not
// just talk about them. Each tool is a thin, validated wrapper over a real
// mutation, and the executor is authorized: it only ever touches the tournament
// the caller owns. Outward-facing/irreversible actions (publishing the event)
// are flagged so the assistant confirms first.
import type { SupabaseClient } from '@supabase/supabase-js';

// Anthropic tool definitions passed to the model.
export const COACH_TOOLS = [
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
    name: 'add_sponsor',
    description:
      'Add a sponsor to the tournament. With no amount it is added as a prospect to reach out to; with an amount it is recorded as a committed (verbal) sponsor. Use for requests like "add ACME as a $2,500 sponsor" or "add Bob\'s Hardware to my sponsor list".',
    input_schema: {
      type: 'object',
      properties: {
        company: { type: 'string' },
        amountDollars: { type: 'integer', description: 'agreed/target amount in dollars, optional' },
      },
      required: ['company'],
    },
  },
] as const;

export interface ToolResult { ok: boolean; summary: string; error?: string }
// userIntent = the organizer's OWN words this conversation. Outward-facing
// actions are gated on it so injected third-party context (e.g. a malicious
// public volunteer-signup role) can never trigger them — that text never
// appears in the user's turns.
interface ToolCtx { service: SupabaseClient; organizerId: string; tournamentId: string | null; userIntent: string }
const OPEN_INTENT = /\b(open|publish|go[\s-]?live|launch|make .*public)\b/i;

const FORMATS = ['scramble', 'best_ball', 'alternate_shot', 'stroke_play'];
const int = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) ? v : null);
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

export async function executeCoachTool(name: string, input: Record<string, unknown>, ctx: ToolCtx): Promise<ToolResult> {
  if (!ctx.tournamentId) return { ok: false, summary: '', error: 'No tournament is selected, so I can\'t make changes yet.' };
  // Authorization: the tournament must belong to the caller. Every mutation
  // below is additionally scoped by tournament_id, never trusting the model.
  const { data: t } = await ctx.service.from('tournaments').select('id, organizer_id').eq('id', ctx.tournamentId).maybeSingle();
  if (!t || t.organizer_id !== ctx.organizerId) return { ok: false, summary: '', error: 'You don\'t have access to that tournament.' };

  switch (name) {
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
      const save = (p: Record<string, unknown>) => ctx.service.from('tournaments').update(p).eq('id', ctx.tournamentId!).eq('organizer_id', ctx.organizerId);
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

    case 'set_registration_status': {
      const action = str(input.action);
      if (action !== 'open' && action !== 'close') return { ok: false, summary: '', error: 'Say open or close.' };
      // Hard gate: publishing (outward-facing) requires the organizer to have
      // actually asked to open/go-live in their own words. Blocks any
      // injected-context attempt to publish a private draft.
      if (action === 'open' && !OPEN_INTENT.test(ctx.userIntent)) {
        return { ok: false, summary: '', error: 'Ask the organizer to confirm they want to open registration / go live before publishing.' };
      }
      const status = action === 'open' ? 'published' : 'draft';
      const { error } = await ctx.service.from('tournaments').update({ status }).eq('id', ctx.tournamentId).eq('organizer_id', ctx.organizerId);
      if (error) return { ok: false, summary: '', error: 'Could not change registration status.' };
      return { ok: true, summary: action === 'open' ? 'registration is now OPEN — your microsite is live to the public' : 'registration closed (back to private draft)' };
    }

    case 'add_sponsor': {
      const company = str(input.company).slice(0, 160);
      if (!company) return { ok: false, summary: '', error: 'I need the sponsor\'s name.' };
      const amt = int(input.amountDollars);
      const amount_cents = amt !== null && amt > 0 && amt <= 10000000 ? amt * 100 : null;
      const { error } = await ctx.service.from('sponsors').insert({
        tournament_id: ctx.tournamentId, company, amount_cents,
        status: amount_cents ? 'verbal' : 'not_contacted', source: 'organizer',
      });
      if (error) return { ok: false, summary: '', error: 'Could not add that sponsor.' };
      return { ok: true, summary: `added ${company}${amount_cents ? ` as a $${amt!.toLocaleString()} sponsor` : ' to your sponsor list'}` };
    }
  }
  return { ok: false, summary: '', error: 'I don\'t know how to do that yet.' };
}
