// Server-side Realtime broadcast — the live-scoring push channel.
//
// Vercel serverless can't hold a websocket open, so the server pushes via
// Supabase Realtime's HTTP broadcast endpoint and only CLIENTS hold sockets:
// the public leaderboard subscribes to channel `leaderboard:<tournamentId>`
// with the anon key, and every score write POSTs one message here. Fire and
// forget by design — delivery is best-effort push on top of the client's
// poll fallback, so a broadcast hiccup must never fail a score submission.
async function broadcast(topic: string, event: string, payload: Record<string, unknown>): Promise<void> {
  try {
    await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/realtime/v1/api/broadcast`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY!,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY!}`,
      },
      body: JSON.stringify({
        messages: [{ topic, event, payload: { at: new Date().toISOString(), ...payload } }],
      }),
    });
  } catch {
    // best-effort: the client's poll fallback covers missed pushes
  }
}

export async function broadcastScoreUpdate(tournamentId: string, payload: Record<string, unknown> = {}): Promise<void> {
  await broadcast(`leaderboard:${tournamentId}`, 'score', payload);
}

// Contest leaderboards (closest-to-pin, long-drive) and winner announcements
// push here; the /contests manager subscribes to contests:<tournamentId>.
export async function broadcastContestUpdate(tournamentId: string, payload: Record<string, unknown> = {}): Promise<void> {
  await broadcast(`contests:${tournamentId}`, 'contest', payload);
}
