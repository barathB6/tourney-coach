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

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  const supabase = getSupabase(req);

  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Verify ownership
  const { data: conv } = await supabase
    .from('coach_conversations')
    .select('id')
    .eq('id', id)
    .eq('organizer_id', user.id)
    .single();

  if (!conv) {
    return Response.json({ error: 'Conversation not found' }, { status: 404 });
  }

  const { data: messages, error } = await supabase
    .from('coach_messages')
    .select('id, role, content, created_at')
    .eq('conversation_id', id)
    .order('created_at', { ascending: true });

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  return Response.json(messages ?? []);
}
