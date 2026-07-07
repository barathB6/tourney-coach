import { createClient } from '@supabase/supabase-js';
import { notFound, redirect } from 'next/navigation';

// eventname.tourneycoach.com/register (path form: /microsite/[slug]/register)
// resolves the slug and forwards to the registration form.
export default async function MicrositeRegisterPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ src?: string }>;
}) {
  const { slug } = await params;
  const { src } = await searchParams;

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );

  const { data: tournament } = await supabase
    .from('tournaments')
    .select('id')
    .eq('slug', slug)
    .in('status', ['published', 'live'])
    .single();

  if (!tournament) notFound();

  redirect(`/register?id=${tournament.id}${src ? `&src=${encodeURIComponent(src)}` : ''}`);
}
