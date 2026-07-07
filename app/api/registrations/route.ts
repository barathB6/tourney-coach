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

async function assignFoursomeAndHole(tournamentId: string, registrationType: string) {
  const supabase = getSupabase();
  const { count } = await supabase
    .from('registrations')
    .select('*', { count: 'exact', head: true })
    .eq('tournament_id', tournamentId);

  const foursomeNumber = (count ?? 0) + 1;

  // Shotgun: 18 holes, foursomes rotate. Starting hole 1–18.
  const startingHole = registrationType === 'single'
    ? null
    : ((foursomeNumber - 1) % 18) + 1;

  return { foursomeNumber, startingHole };
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

    // Check capacity — sum actual player slots used per existing registration
    const { data: existingRegs } = await supabase
      .from('registrations')
      .select('registration_type')
      .eq('tournament_id', tournament_id)
      .in('payment_status', ['pending', 'paid']);

    const slotsUsed = (existingRegs ?? []).reduce(
      (sum, r) => sum + (PLAYERS_PER_TYPE[r.registration_type] ?? 4), 0
    );
    if (slotsUsed + expectedPlayers > tournament.max_players) {
      return NextResponse.json({ error: 'Tournament is full' }, { status: 409 });
    }

    // Joining an existing team: make sure it has room (teams cap at 4 players)
    if (registration_type === 'single' && team_name) {
      const { data: teamRegs } = await supabase
        .from('registrations')
        .select('players')
        .eq('tournament_id', tournament_id)
        .eq('team_name', team_name)
        .in('payment_status', ['pending', 'paid']);

      const teamPlayers = (teamRegs ?? []).reduce(
        (sum, r) => sum + (Array.isArray(r.players) ? r.players.length : 0), 0
      );
      if (teamPlayers + 1 > 4) {
        return NextResponse.json({ error: 'That team is already full' }, { status: 409 });
      }
    }

    // Assign foursome and hole
    const { foursomeNumber, startingHole } = await assignFoursomeAndHole(tournament_id, registration_type);

    // Insert registration
    const { data: registration, error: insertErr } = await supabase
      .from('registrations')
      .insert({
        tournament_id,
        registration_type,
        team_name: team_name || null,
        contact_name,
        contact_email,
        contact_phone: contact_phone || null,
        players,
        add_ons,
        total_amount_cents,
        platform_fee_cents,
        registration_source: registration_source || (manual ? 'other' : 'direct'),
        // Paper registrations paid by cash/check are marked paid immediately
        payment_status: manual && mark_paid ? 'paid' : 'pending',
        foursome_number: foursomeNumber,
        starting_hole: startingHole,
      })
      .select()
      .single();

    if (insertErr) {
      console.error('Registration insert error:', insertErr);
      return NextResponse.json({ error: 'Failed to save registration' }, { status: 500 });
    }

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
        registrationId: registration.id,
        locationName: tournament.location_name,
        subtotalCents: subtotal_cents,
        platformFeeCents: platform_fee_cents,
      }).catch(err => console.error('Email send error:', err));

      await supabase
        .from('registrations')
        .update({ confirmation_sent_at: new Date().toISOString() })
        .eq('id', registration.id);
    }

    return NextResponse.json({
      id: registration.id,
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
