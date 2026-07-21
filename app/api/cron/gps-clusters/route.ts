import { NextRequest, NextResponse } from 'next/server';
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

  const clusters = await detectTeeClusters();
  const aggregation = await aggregateCourseProfiles();
  return NextResponse.json({ clustersDetected: clusters.length, aggregation });
}
