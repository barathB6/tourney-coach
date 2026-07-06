import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

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

// Platform fee: 2.5% on entry fees (confirmed Day 6)
const PLATFORM_FEE_RATE = 0.025;

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

async function sendConfirmationEmail(params: {
  contactEmail: string;
  contactName: string;
  teamName: string | null;
  tournamentName: string;
  eventDate: string;
  foursomeNumber: number;
  startingHole: number | null;
}) {
  const apiKey = process.env.SENDGRID_API_KEY;
  if (!apiKey) return; // SendGrid not configured yet — skip silently

  const dateStr = new Date(params.eventDate).toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });
  const holeText = params.startingHole ? `Starting hole: ${params.startingHole}` : '';

  await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      personalizations: [{
        to: [{ email: params.contactEmail, name: params.contactName }],
      }],
      from: { email: 'noreply@tourneycoach.com', name: 'TourneyCoach' },
      subject: `You're registered — ${params.tournamentName}`,
      content: [{
        type: 'text/plain',
        value: [
          `Hi ${params.contactName},`,
          '',
          `You're registered for ${params.tournamentName}.`,
          '',
          `Date: ${dateStr}`,
          params.teamName ? `Team: ${params.teamName}` : '',
          `Foursome #${params.foursomeNumber}`,
          holeText,
          '',
          'Check-in opens 30 minutes before shotgun start. Please arrive with your team.',
          '',
          '— TourneyCoach',
        ].filter(Boolean).join('\n'),
      }],
    }),
  });
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
    } = body;

    // Validate required fields
    if (!tournament_id || !registration_type || !contact_name || !contact_email) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }
    if (!PRICES[registration_type]) {
      return NextResponse.json({ error: 'Invalid registration type' }, { status: 400 });
    }

    // Validate player count
    const expectedPlayers = PLAYERS_PER_TYPE[registration_type];
    if (!Array.isArray(players) || players.length !== expectedPlayers) {
      return NextResponse.json(
        { error: `${registration_type} requires exactly ${expectedPlayers} player(s)` },
        { status: 400 }
      );
    }

    // Calculate total
    const base = PRICES[registration_type];
    const addOnTotal = (add_ons as string[]).reduce((s, a) => s + (ADD_ON_PRICES[a] ?? 0), 0);
    const total_amount_cents = base + addOnTotal;
    const platform_fee_cents = Math.round(total_amount_cents * PLATFORM_FEE_RATE);

    // Fetch tournament for email
    const { data: tournament, error: tErr } = await supabase
      .from('tournaments')
      .select('name, event_date, max_players')
      .eq('id', tournament_id)
      .single();
    if (tErr || !tournament) {
      return NextResponse.json({ error: 'Tournament not found' }, { status: 404 });
    }

    // Check capacity
    const { count: existing } = await supabase
      .from('registrations')
      .select('*', { count: 'exact', head: true })
      .eq('tournament_id', tournament_id)
      .in('payment_status', ['pending', 'paid']);

    const slotsUsed = (existing ?? 0) * (PLAYERS_PER_TYPE[registration_type] ?? 4);
    if (slotsUsed + expectedPlayers > tournament.max_players) {
      return NextResponse.json({ error: 'Tournament is full' }, { status: 409 });
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
        registration_source: registration_source || 'direct',
        payment_status: 'pending',
        foursome_number: foursomeNumber,
        starting_hole: startingHole,
      })
      .select()
      .single();

    if (insertErr) {
      console.error('Registration insert error:', insertErr);
      return NextResponse.json({ error: 'Failed to save registration' }, { status: 500 });
    }

    // Send confirmation email (non-blocking — failure doesn't fail the request)
    sendConfirmationEmail({
      contactEmail: contact_email,
      contactName: contact_name,
      teamName: team_name || null,
      tournamentName: tournament.name,
      eventDate: tournament.event_date,
      foursomeNumber,
      startingHole,
    }).catch(err => console.error('Email send error:', err));

    // Update confirmation_sent_at after email attempt
    await supabase
      .from('registrations')
      .update({ confirmation_sent_at: new Date().toISOString() })
      .eq('id', registration.id);

    return NextResponse.json({
      id: registration.id,
      foursome_number: foursomeNumber,
      starting_hole: startingHole,
      total_amount_cents,
      // PAYMENT SDK GOES HERE — insert payment intent creation once processor confirmed
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
