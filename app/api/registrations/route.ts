import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { sendConfirmationEmail } from '@/lib/email/confirmation';

const getSupabase = () => createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const PRICES: Record<string, number> = {
  foursome: 60000,  // cents
  single: 16500,
  sponsor: 500000,
};
const ADD_ON_PRICES: Record<string, number> = {
  mulligans: 8000,
  putting: 4000,
};
const PLAYERS_PER_TYPE: Record<string, number> = {
  foursome: 4,
  single: 1,
  sponsor: 4,
};

// New-member platform fee: 2.5% added on top of entry fee. Waived for
// returning members (anyone who already has a player_profiles row, i.e.
// has registered for a TourneyCoach tournament before). Confirmed Day 7.
const PLATFORM_FEE_RATE = 0.025;

async function isReturningMember(email: string): Promise<boolean> {
  const supabase = getSupabase();
  const { data } = await supabase
    .from('player_profiles')
    .select('id')
    .eq('email', email.trim().toLowerCase())
    .maybeSingle();
  return !!data;
}

export async function POST(req: NextRequest) {
  try {
    const supabase = getSupabase();
    const body = await req.json();
    const {
      tournament_id,
      registration_type,
      team_name,
      contact_name,
      contact_email,
      contact_phone,
      players,
      add_ons = [],
      registration_source,
      manual = false,
      mark_paid = false,
    } = body;

    // Validate required fields
    if (!tournament_id || !registration_type || !contact_name || !contact_email) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }
    if (!PRICES[registration_type]) {
      return NextResponse.json({ error: 'Invalid registration type' }, { status: 400 });
    }

    // Manual (paper) registrations: only the tournament's organizer may add them
    if (manual) {
      const authHeader = req.headers.get('authorization');
      if (!authHeader?.startsWith('Bearer ')) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }
      const { data: { user }, error: authErr } = await supabase.auth.getUser(authHeader.slice(7));
      if (authErr || !user) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }
      const { data: owned } = await supabase
        .from('tournaments')
        .select('id')
        .eq('id', tournament_id)
        .eq('organizer_id', user.id)
        .single();
      if (!owned) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }
    }

    // Validate player count
    const expectedPlayers = PLAYERS_PER_TYPE[registration_type];
    if (!Array.isArray(players) || players.length !== expectedPlayers) {
      return NextResponse.json(
        { error: `${registration_type} requires exactly ${expectedPlayers} player(s)` },
        { status: 400 }
      );
    }

    // Calculate total. New-member fee is added on top; returning members pay
    // exactly the listed price. "Returning" is determined by the contact's
    // email already having a player_profiles row from a prior registration —
    // computed server-side, never trusted from the client.
    const base = PRICES[registration_type];
    const addOnTotal = (add_ons as string[]).reduce((s, a) => s + (ADD_ON_PRICES[a] ?? 0), 0);
    const subtotal_cents = base + addOnTotal;
    const returning = await isReturningMember(contact_email);
    const platform_fee_cents = returning ? 0 : Math.round(subtotal_cents * PLATFORM_FEE_RATE);
    const total_amount_cents = subtotal_cents + platform_fee_cents;

    // Fetch tournament for email
    const { data: tournament, error: tErr } = await supabase
      .from('tournaments')
      .select('name, event_date, max_players, location_name')
      .eq('id', tournament_id)
      .single();
    if (tErr || !tournament) {
      return NextResponse.json({ error: 'Tournament not found' }, { status: 404 });
    }

    // Capacity check, team-join check, foursome/hole assignment, and the
    // insert all happen atomically in one Postgres function (locks the
    // tournament row for the transaction) — see migration 011 for why:
    // doing these as separate app-code round trips let concurrent
    // registrations race past capacity checks and duplicate foursome numbers.
    const { data: registration, error: insertErr } = await supabase
      .rpc('create_registration_atomic', {
        p_tournament_id: tournament_id,
        p_registration_type: registration_type,
        p_team_name: team_name || null,
        p_contact_name: contact_name,
        p_contact_email: contact_email,
        p_contact_phone: contact_phone || null,
        p_players: players,
        p_add_ons: add_ons,
        p_total_amount_cents: total_amount_cents,
        p_platform_fee_cents: platform_fee_cents,
        p_registration_source: registration_source || (manual ? 'other' : 'direct'),
        p_payment_status: manual && mark_paid ? 'paid' : 'pending',
      })
      .single();

    if (insertErr) {
      const message = insertErr.message || 'Failed to save registration';
      const status = message.includes('Tournament is full') || message.includes('already full') ? 409
        : message.includes('not found') ? 404
        : 500;
      if (status === 500) console.error('Registration insert error:', insertErr);
      return NextResponse.json({ error: message }, { status });
    }

    const reg = registration as { id: string; foursome_number: number; starting_hole: number | null };
    const foursomeNumber = reg.foursome_number;
    const startingHole = reg.starting_hole;

    // Confirmation email only fires once payment is actually confirmed.
    // Online registrations are still 'pending' here — the webhook sends it
    // when Adyen reports AUTHORISATION success. Manual paper registrations
    // marked paid at creation (cash/check) are already paid, so send now.
    if (manual && mark_paid) {
      sendConfirmationEmail({
        contactEmail: contact_email,
        contactName: contact_name,
        teamName: team_name || null,
        tournamentName: tournament.name,
        eventDate: tournament.event_date,
        foursomeNumber,
        startingHole,
        registrationId: reg.id,
        locationName: tournament.location_name,
        subtotalCents: subtotal_cents,
        platformFeeCents: platform_fee_cents,
      }).catch(err => console.error('Email send error:', err));

      await supabase
        .from('registrations')
        .update({ confirmation_sent_at: new Date().toISOString() })
        .eq('id', reg.id);
    }

    return NextResponse.json({
      id: reg.id,
      foursome_number: foursomeNumber,
      starting_hole: startingHole,
      subtotal_cents,
      platform_fee_cents,
      total_amount_cents,
      returning_member: returning,
    }, { status: 201 });

  } catch (err) {
    console.error('Registration route error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  const supabase = getSupabase();
  const { searchParams } = new URL(req.url);
  const tournamentId = searchParams.get('tournament_id');
  if (!tournamentId) {
    return NextResponse.json({ error: 'tournament_id required' }, { status: 400 });
  }

  const { data, error, count } = await supabase
    .from('registrations')
    .select('id, registration_type, team_name, contact_name, foursome_number, starting_hole, payment_status, created_at', { count: 'exact' })
    .eq('tournament_id', tournamentId)
    .order('foursome_number', { ascending: true });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ registrations: data, count });
}
