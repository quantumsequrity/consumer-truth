import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'

// D1 database interface
interface D1Database {
  prepare(query: string): D1PreparedStatement
}

interface D1PreparedStatement {
  bind(...values: any[]): D1PreparedStatement
  all<T = Record<string, unknown>>(): Promise<{ results: T[]; success: boolean }>
  first<T = Record<string, unknown>>(): Promise<T | null>
  run(): Promise<{ success: boolean }>
}

const FETCH_TIMEOUT = 10000
const RATE_LIMIT_MS = 250 // 4 req/sec for OpenFDA
// Each ingredient costs 2 OpenFDA calls + 2 * 250ms sleep ≈ 0.5s.
// 50 ingredients ≈ 25s of pure sleep, comfortably inside a cron wall budget.
// Previously 200, which guaranteed timeouts before the loop finished.
const BATCH_LIMIT = 50

// Timing-safe Bearer-token comparison. Reject early on bad shape so we never
// even allocate the comparison buffer for clearly malformed input.
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

function getIngredientsRefDb(): D1Database | null {
  try {
    const { getCloudflareContext } = require('@opennextjs/cloudflare')
    const { env } = getCloudflareContext()
    return env?.INGREDIENTS_REF_DB || null
  } catch {
    return null
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function fetchFDAEvents(name: string): Promise<number> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT)

  try {
    const encodedName = encodeURIComponent(`"${name}"`)
    const url = `https://api.fda.gov/food/event.json?search=products.industry_name:${encodedName}+reactions:${encodedName}&limit=1`

    const res = await fetch(url, {
      headers: { 'User-Agent': 'Alzhal-CronSync/1.0' },
      signal: controller.signal,
    })

    clearTimeout(timeout)
    if (!res.ok) return 0

    const data = await res.json()
    return data.meta?.results?.total || 0
  } catch {
    clearTimeout(timeout)
    return 0
  }
}

async function fetchFDARecalls(name: string): Promise<{
  total: number
  recent: Array<{ reason: string; classification: string; status: string }>
}> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT)

  try {
    const encodedName = encodeURIComponent(`"${name}"`)
    const url = `https://api.fda.gov/food/enforcement.json?search=reason_for_recall:${encodedName}&limit=3`

    const res = await fetch(url, {
      headers: { 'User-Agent': 'Alzhal-CronSync/1.0' },
      signal: controller.signal,
    })

    clearTimeout(timeout)
    if (!res.ok) return { total: 0, recent: [] }

    const data = await res.json()
    const total = data.meta?.results?.total || 0
    const recent = (data.results || []).slice(0, 3).map((r: any) => ({
      reason: (r.reason_for_recall || 'Unknown').slice(0, 200),
      classification: r.classification || 'Unknown',
      status: r.status || 'Unknown',
    }))

    return { total, recent }
  } catch {
    clearTimeout(timeout)
    return { total: 0, recent: [] }
  }
}

export async function POST(request: NextRequest) {
  // Auth check — timing-safe Bearer compare.
  const authHeader = request.headers.get('authorization')
  const cronSecret = process.env.CRON_SECRET
  if (!cronSecret || !timingSafeBearerCheck(authHeader, cronSecret)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const db = getIngredientsRefDb()
  if (!db) {
    return NextResponse.json({ error: 'INGREDIENTS_REF_DB not available' }, { status: 503 })
  }

  try {
    // Get stale ingredients (not synced in 7+ days, or never synced)
    const staleRows = await db.prepare(
      `SELECT name FROM ingredient_reference WHERE last_fda_sync_at IS NULL OR last_fda_sync_at < datetime('now', '-7 days') LIMIT ?`
    ).bind(BATCH_LIMIT).all<{ name: string }>()

    if (!staleRows.success || staleRows.results.length === 0) {
      return NextResponse.json({ message: 'No stale ingredients to sync', updated: 0 })
    }

    const names = staleRows.results.map(r => r.name)
    let updated = 0
    let errors = 0

    for (const name of names) {
      try {
        const eventCount = await fetchFDAEvents(name)
        await sleep(RATE_LIMIT_MS)

        const recalls = await fetchFDARecalls(name)
        await sleep(RATE_LIMIT_MS)

        await db.prepare(`
          UPDATE ingredient_reference
          SET fda_adverse_event_count = ?,
              fda_recall_count = ?,
              fda_recent_recalls = ?,
              last_fda_sync_at = datetime('now'),
              updated_at = datetime('now')
          WHERE name = ?
        `).bind(
          eventCount,
          recalls.total,
          JSON.stringify(recalls.recent),
          name
        ).run()

        updated++
      } catch {
        errors++
      }
    }

    return NextResponse.json({
      message: 'FDA sync complete',
      total: names.length,
      updated,
      errors,
    })
  } catch (error: any) {
    console.error('[FDA-Sync] Error:', error)
    return NextResponse.json({ error: 'Sync failed', details: error.message }, { status: 500 })
  }
}
