import { NextRequest } from 'next/server';
import { createClient } from '@supabase/supabase-js';

function getSupabase(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    token ? { global: { headers: { Authorization: `Bearer ${token}` } } } : undefined,
  );
}

export async function GET(req: NextRequest) {
  const supabase = getSupabase(req);
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { data, error } = await supabase
    .from('coach_conversations')
    .select('id, title, tournament_id, created_at, updated_at')
    .eq('organizer_id', user.id)
    .order('updated_at', { ascending: false })
    .limit(50);

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  return Response.json(data ?? []);
}

export async function DELETE(req: NextRequest) {
  const supabase = getSupabase(req);
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { conversationId } = await req.json();
  if (!conversationId) {
    return Response.json({ error: 'conversationId required' }, { status: 400 });
  }

  await supabase.from('coach_messages').delete().eq('conversation_id', conversationId);
  await supabase.from('coach_conversations').delete().eq('id', conversationId);

  return Response.json({ deleted: true });
}
