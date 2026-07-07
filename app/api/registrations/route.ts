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
  registrationId: string;
  locationName?: string | null;
}) {
  const apiKey = process.env.SENDGRID_API_KEY;
  if (!apiKey) return; // SendGrid not configured yet — skip silently

  const dateStr = new Date(params.eventDate).toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://www.tourneycoach.com';
  const qrParams = new URLSearchParams({ size: '180x180', data: `${appUrl}/checkin/${params.registrationId}` });
  // & must be escaped as &amp; inside an HTML attribute, or some email clients mis-parse the URL
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?${qrParams.toString().replace(/&/g, '&amp;')}`;

  const detailRow = (label: string, value: string) => `
    <tr>
      <td style="padding:8px 0;font-size:13px;color:#6B7775;text-transform:uppercase;letter-spacing:.06em;font-weight:600;">${label}</td>
      <td style="padding:8px 0;font-size:15px;color:#1A1F1C;font-weight:600;text-align:right;">${value}</td>
    </tr>`;

  const html = `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#FAF8F3;font-family:'Helvetica Neue',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#FAF8F3;padding:32px 16px;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">
        <tr>
          <td style="background:#1B4425;border-radius:14px 14px 0 0;padding:36px 40px;text-align:center;">
            <p style="margin:0 0 6px;color:#D9C58A;font-size:11px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;">You're registered</p>
            <h1 style="margin:0;color:#ffffff;font-size:26px;font-weight:700;">${params.tournamentName}</h1>
            <p style="margin:10px 0 0;color:rgba(255,255,255,.75);font-size:14px;">${dateStr}</p>
          </td>
        </tr>
        <tr>
          <td style="background:#ffffff;padding:32px 40px;border-left:1px solid #E5E0D5;border-right:1px solid #E5E0D5;">
            <p style="margin:0 0 20px;font-size:15px;color:#1A1F1C;line-height:1.6;">Hi ${params.contactName},</p>
            <p style="margin:0 0 24px;font-size:15px;color:#3A3F3C;line-height:1.6;">Your spot is confirmed. Here are your tournament details — keep this email handy for check-in day.</p>
            <table width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #E5E0D5;border-bottom:1px solid #E5E0D5;margin-bottom:24px;">
              ${params.teamName ? detailRow('Team', params.teamName) : ''}
              ${detailRow('Foursome', `#${params.foursomeNumber}`)}
              ${params.startingHole ? detailRow('Starting hole', `${params.startingHole}`) : ''}
              ${params.locationName ? detailRow('Location', params.locationName) : ''}
            </table>
            <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
              <tr><td align="center" style="padding:8px 0 4px;">
                <img src="${qrUrl}" width="140" height="140" alt="Check-in QR code" style="border:1px solid #E5E0D5;border-radius:10px;padding:8px;background:#fff;" />
              </td></tr>
              <tr><td align="center" style="font-size:12px;color:#6B7775;padding-top:6px;">Show this QR code at check-in</td></tr>
            </table>
            <p style="margin:0 0 8px;font-size:13px;font-weight:700;color:#1A1F1C;text-transform:uppercase;letter-spacing:.06em;">What to bring</p>
            <ul style="margin:0 0 8px;padding-left:18px;font-size:14px;color:#3A3F3C;line-height:1.9;">
              <li>Your clubs (rentals may be limited)</li>
              <li>Golf shoes — soft spikes only</li>
              <li>Sunscreen and a water bottle</li>
              <li>This confirmation (printed or on your phone)</li>
            </ul>
            <p style="margin:16px 0 0;font-size:14px;color:#3A3F3C;line-height:1.6;">Check-in opens 30 minutes before shotgun start. Please arrive with your team.</p>
          </td>
        </tr>
        <tr>
          <td style="background:#F2EFE7;border-radius:0 0 14px 14px;padding:20px 40px;text-align:center;border:1px solid #E5E0D5;border-top:none;">
            <p style="margin:0;font-size:12px;color:#6B7775;">Powered by <strong style="color:#1B6B3A;">TourneyCoach</strong> — tournaments that fund what matters</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

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
      content: [{ type: 'text/html', value: html }],
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

    // Calculate total
    const base = PRICES[registration_type];
    const addOnTotal = (add_ons as string[]).reduce((s, a) => s + (ADD_ON_PRICES[a] ?? 0), 0);
    const total_amount_cents = base + addOnTotal;
    const platform_fee_cents = Math.round(total_amount_cents * PLATFORM_FEE_RATE);

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

    // Send confirmation email (non-blocking — failure doesn't fail the request)
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
