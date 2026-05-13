import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { sweepExpiredAudio } from '@/lib/audio-store'

/**
 * POST /api/cron/audio-sweep
 *
 * R2 has no native object TTL, so TTS audio uploaded by /api/analyze/voice
 * (and the WhatsApp / Telegram audio replies) would accumulate forever
 * without this sweeper. Scheduled via wrangler `[[triggers]] crons`:
 *
 *   [triggers]
 *   crons = ["0 * * * *"]   # hourly
 *
 * Auth: same Bearer-token pattern as /api/cron/fda-sync, timing-safe compare.
 */
function timingSafeBearerCheck(authHeader: string | null, expected: string): boolean {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return false
  const provided = authHeader.slice('Bearer '.length)
  if (provided.length !== expected.length) return false
  try {
    return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected))
  } catch {
    return false
  }
}

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get('authorization')
  const cronSecret = process.env.CRON_SECRET
  if (!cronSecret || !timingSafeBearerCheck(authHeader, cronSecret)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const result = await sweepExpiredAudio()
    return NextResponse.json({
      ok: true,
      ...result,
      // If truncated=true the bucket has more than one page of expired
      // objects. The next cron tick will pick them up; no in-loop pagination
      // because we want to stay inside the worker wall budget.
    })
  } catch (err) {
    console.error('[cron/audio-sweep] failed:', err)
    return NextResponse.json({ error: 'Sweep failed' }, { status: 500 })
  }
}
