import { NextRequest, NextResponse } from 'next/server';
import { detectTeeClusters } from '@/lib/gps/clustering';

// Runs periodically via Vercel Cron (see vercel.json) to sweep for newly
// converged tee-box clusters across every course with unlabeled GPS tracks.
// Safe to run frequently — detectTeeClusters() only touches holes whose
// gps_status.tee is still unset.
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const results = await detectTeeClusters();
  return NextResponse.json({ clustersDetected: results.length, results });
}
