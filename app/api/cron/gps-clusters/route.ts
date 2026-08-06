import { NextRequest, NextResponse } from 'next/server';
import { captureError, captureEvent } from '@/lib/observability/report';
import { detectTeeClusters } from '@/lib/gps/clustering';
import { aggregateCourseProfiles } from '@/lib/gps/aggregate';

// Daily GPS pipeline pass (Vercel Cron, see vercel.json). Two stages, in
// order: (1) detect newly-converged tee-box clusters from raw tracks, then
// (2) aggregate all detections across tournaments into canonical course
// profiles with cross-tournament confidence, fairway routes, and hazard
// inference (Day 19). Aggregation runs after detection so the same pass
// folds in whatever clusters it just found.
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const started = Date.now();
  try {
    const clusters = await detectTeeClusters();
    const aggregation = await aggregateCourseProfiles();
    captureEvent('cron completed', {
      scope: 'cron.gps-clusters',
      detail: { ms: Date.now() - started, clustersDetected: clusters.length },
    });
    return NextResponse.json({ clustersDetected: clusters.length, aggregation });
  } catch (err) {
    // The GPS network is the structural moat; a clustering run that quietly
    // stops means the course profiles stop improving and nobody notices for
    // months.
    captureError(err, { scope: 'cron.gps-clusters', detail: { ms: Date.now() - started } });
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : 'unknown error' }, { status: 500 });
  }
}
