import { NextRequest, NextResponse } from 'next/server';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { completionCount, type CourseHole } from '@/lib/course';
import { newSessionToken, normalizeEmail, sessionExpiry, verifyPassword } from '@/lib/proAccess';

// The head pro's endpoint. No Supabase Auth: the pro is course staff, not a
// platform user. They prove identity with the link token plus the email and
// password issued to them, and hold a short-lived session token afterwards.
// Everything runs on the service-role client because course_pro_access is
// revoked from anon/authenticated entirely.
const getAdmin = () => createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

type Grant = { id: string; course_id: string; email: string };

async function grantForSession(admin: SupabaseClient, sessionToken: string): Promise<Grant | null> {
  const { data } = await admin
    .from('course_pro_access')
    .select('id, course_id, email, session_expires_at')
    .eq('session_token', sessionToken)
    .is('revoked_at', null)
    .maybeSingle();
  if (!data) return null;
  if (!data.session_expires_at || new Date(data.session_expires_at) < new Date()) return null;
  return { id: data.id, course_id: data.course_id, email: data.email };
}

async function courseWithHoles(admin: SupabaseClient, courseId: string) {
  const [{ data: course }, { data: holes }] = await Promise.all([
    admin.from('courses').select('id, name, city, state, tees, total_holes, par_total').eq('id', courseId).single(),
    admin.from('course_holes').select('hole_number, par, handicap, description, shape_tags, tee_yardages').eq('course_id', courseId).order('hole_number'),
  ]);
  return { course, holes: holes ?? [] };
}

// action=login  -> { linkToken, email, password }  : issues a session token
// action=save   -> { sessionToken, hole }          : upserts one hole
// action=logout -> { sessionToken }
export async function POST(req: NextRequest) {
  let body: {
    action?: string;
    linkToken?: string;
    email?: string;
    password?: string;
    sessionToken?: string;
    hole?: CourseHole;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const admin = getAdmin();

  if (body.action === 'login') {
    const { linkToken, email, password } = body;
    if (!linkToken || !email || !password) {
      return NextResponse.json({ error: 'Email and password are required' }, { status: 400 });
    }
    const { data: grant } = await admin
      .from('course_pro_access')
      .select('id, course_id, email, password_hash')
      .eq('link_token', linkToken)
      .is('revoked_at', null)
      .maybeSingle();

    // One message for every failure mode — a wrong email, a wrong password and
    // a revoked link are indistinguishable to whoever is guessing.
    const denied = NextResponse.json({ error: 'That email and password don’t match this link.' }, { status: 401 });
    if (!grant) return denied;
    if (normalizeEmail(email) !== normalizeEmail(grant.email)) return denied;
    if (!verifyPassword(password, grant.password_hash)) return denied;

    const sessionToken = newSessionToken();
    await admin.from('course_pro_access')
      .update({ session_token: sessionToken, session_expires_at: sessionExpiry(), last_login_at: new Date().toISOString() })
      .eq('id', grant.id);

    const { course, holes } = await courseWithHoles(admin, grant.course_id);
    return NextResponse.json({ sessionToken, email: grant.email, course, holes });
  }

  if (body.action === 'save') {
    const { sessionToken, hole } = body;
    if (!sessionToken || !hole) return NextResponse.json({ error: 'Missing session or hole' }, { status: 400 });
    const grant = await grantForSession(admin, sessionToken);
    if (!grant) return NextResponse.json({ error: 'Session expired — please sign in again.' }, { status: 401 });

    if (!Number.isInteger(hole.holeNumber) || hole.holeNumber < 1 || hole.holeNumber > 18) {
      return NextResponse.json({ error: 'Invalid hole number' }, { status: 400 });
    }
    if (hole.par != null && ![3, 4, 5].includes(hole.par)) {
      return NextResponse.json({ error: 'Par must be 3, 4, or 5' }, { status: 400 });
    }

    const { error } = await admin.from('course_holes').upsert({
      course_id: grant.course_id,
      hole_number: hole.holeNumber,
      par: hole.par,
      handicap: hole.handicap,
      description: hole.description,
      shape_tags: hole.shapeTags ?? [],
      tee_yardages: hole.teeYardages ?? {},
    }, { onConflict: 'course_id,hole_number' });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    // Keep the course's own summary in step, so the organizer's read-only view
    // reflects the pro's edits without a separate refresh path.
    const { holes } = await courseWithHoles(admin, grant.course_id);
    const asCourseHoles = holes.map((h) => ({
      holeNumber: h.hole_number, par: h.par, handicap: h.handicap,
      description: h.description, shapeTags: h.shape_tags ?? [], teeYardages: h.tee_yardages ?? {},
    }));
    const parTotal = asCourseHoles.reduce((sum, h) => sum + (h.par ?? 0), 0) || null;
    await admin.from('courses').update({
      par_total: parTotal,
      profile_status: completionCount(asCourseHoles) === 18 ? 'complete' : 'draft',
    }).eq('id', grant.course_id);

    return NextResponse.json({ ok: true });
  }

  if (body.action === 'logout') {
    if (body.sessionToken) {
      await admin.from('course_pro_access').update({ session_token: null, session_expires_at: null }).eq('session_token', body.sessionToken);
    }
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
}

// Resumes an existing session (the pro's browser holds the token) so a
// refresh doesn't force them to sign in again mid-pass.
export async function GET(req: NextRequest) {
  const sessionToken = req.nextUrl.searchParams.get('session');
  if (!sessionToken) return NextResponse.json({ error: 'Missing session' }, { status: 400 });

  const admin = getAdmin();
  const grant = await grantForSession(admin, sessionToken);
  if (!grant) return NextResponse.json({ error: 'Session expired' }, { status: 401 });

  const { course, holes } = await courseWithHoles(admin, grant.course_id);
  return NextResponse.json({ email: grant.email, course, holes });
}
