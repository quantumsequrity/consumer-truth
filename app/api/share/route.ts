import { NextRequest, NextResponse } from 'next/server'
import { execute } from '@/lib/db'
import { rateLimit, getClientIdentifier, validateOrigin, getSecurityHeaders } from '@/lib/security'

const limiter = rateLimit({ windowMs: 60000, maxRequests: 20 })

export async function POST(req: NextRequest) {
  try {
    if (!validateOrigin(req)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403, headers: getSecurityHeaders() })
    }

    const clientId = getClientIdentifier(req)
    const { allowed } = limiter(clientId)
    if (!allowed) {
      return NextResponse.json({ error: 'Too many requests.' }, { status: 429, headers: getSecurityHeaders() })
    }

    const body = await req.json()
    const { scan_id, method } = body

    if (!scan_id || typeof scan_id !== 'string') {
      return NextResponse.json({ error: 'scan_id is required' }, { status: 400, headers: getSecurityHeaders() })
    }

    if (method !== 'whatsapp' && method !== 'copy') {
      return NextResponse.json({ error: 'method must be "whatsapp" or "copy"' }, { status: 400, headers: getSecurityHeaders() })
    }

    // Atomic increment - single SQL statement, no RPC needed
    await execute('UPDATE scans SET share_count = share_count + 1 WHERE id = ?', [scan_id])

    return NextResponse.json({ success: true }, { headers: getSecurityHeaders() })
  } catch (error) {
    console.error('Share tracking error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500, headers: getSecurityHeaders() })
  }
}
