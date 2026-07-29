import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { sendProAccessInviteEmail } from '@/lib/email/proAccessInvite';
import { hashPassword, issuedPassword, newLinkToken, normalizeEmail } from '@/lib/proAccess';

// Organizer-authenticated: read/issue/revoke the head pro's edit grant for a
// course. Credentials live in course_pro_access, which is unreachable from the
// browser, so all of it goes through the service-role client after we've
// separately confirmed the caller owns this course.
function getUserClient(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    token ? { global: { headers: { Authorization: `Bearer ${token}` } } } : undefined,
  );
}

const getAdmin = () => createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// Confirms the caller is signed in AND owns this course. Returns the course
// row (needed for its name) or an error response to return verbatim.
async function requireOwner(req: NextRequest, courseId: string) {
  const { data: { user }, error: authError } = await getUserClient(req).auth.getUser();
  if (authError || !user) {
    return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  }
  const { data: course } = await getAdmin()
    .from('courses')
    .select('id, name, organizer_id')
    .eq('id', courseId)
    .maybeSingle();
  if (!course) {
    return { error: NextResponse.json({ error: 'Course not found' }, { status: 404 }) };
  }
  if (course.organizer_id !== user.id) {
    return { error: NextResponse.json({ error: 'Only the course owner can manage pro access' }, { status: 403 }) };
  }
  return { user, course };
}

// Never returns the password — it exists in plaintext only in the POST
// response and the pro's email, by design.
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await requireOwner(req, id);
  if (gate.error) return gate.error;

  const { data: grant } = await getAdmin()
    .from('course_pro_access')
    .select('email, link_token, created_at, last_login_at')
    .eq('course_id', id)
    .is('revoked_at', null)
    .maybeSingle();

  return NextResponse.json({
    active: !!grant,
    email: grant?.email ?? null,
    loginUrl: grant ? `${req.nextUrl.origin}/course/pro/${grant.link_token}` : null,
    createdAt: grant?.created_at ?? null,
    lastLoginAt: grant?.last_login_at ?? null,
  });
}

// Issues (or re-issues) the grant. Re-issuing revokes the previous one, so a
// course never has two people who think they're the editor.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await requireOwner(req, id);
  if (gate.error) return gate.error;

  let body: { email?: string; year?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const email = normalizeEmail(body.email ?? '');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return NextResponse.json({ error: 'A valid email address is required' }, { status: 400 });
  }

  const admin = getAdmin();
  const year = body.year && Number.isInteger(body.year) ? body.year : new Date().getFullYear();
  const password = issuedPassword(gate.course.name, year);
  const linkToken = newLinkToken();

  await admin.from('course_pro_access')
    .update({ revoked_at: new Date().toISOString(), session_token: null })
    .eq('course_id', id)
    .is('revoked_at', null);

  const { error: insertErr } = await admin.from('course_pro_access').insert({
    course_id: id,
    email,
    password_hash: hashPassword(password),
    link_token: linkToken,
  });
  if (insertErr) {
    return NextResponse.json({ error: insertErr.message }, { status: 500 });
  }

  const loginUrl = `${req.nextUrl.origin}/course/pro/${linkToken}`;

  // The grant is already live; a mail failure shouldn't roll it back, since
  // the organizer can always copy the link and password from the response.
  let emailed = true;
  let emailError: string | null = null;
  try {
    await sendProAccessInviteEmail({
      toEmail: email,
      courseName: gate.course.name,
      organizerName: gate.user.user_metadata?.full_name ?? null,
      loginUrl,
      password,
    });
  } catch (e) {
    emailed = false;
    emailError = e instanceof Error ? e.message : 'Send failed';
  }

  return NextResponse.json({ active: true, email, loginUrl, password, emailed, emailError });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await requireOwner(req, id);
  if (gate.error) return gate.error;

  await getAdmin().from('course_pro_access')
    .update({ revoked_at: new Date().toISOString(), session_token: null })
    .eq('course_id', id)
    .is('revoked_at', null);

  return NextResponse.json({ active: false });
}
