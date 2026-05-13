import { NextRequest, NextResponse } from 'next/server'
import { execute, generateId } from '@/lib/db'
import { rateLimit, getClientIdentifier, sanitizeInput, validateOrigin, getSecurityHeaders } from '@/lib/security'

const limiter = rateLimit({ windowMs: 60000, maxRequests: 10 })

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
    const { scan_id, rating, comment, ingredient_name } = body

    if (!scan_id || typeof scan_id !== 'string') {
      return NextResponse.json({ error: 'scan_id is required' }, { status: 400, headers: getSecurityHeaders() })
    }

    if (rating !== 'up' && rating !== 'down') {
      return NextResponse.json({ error: 'rating must be "up" or "down"' }, { status: 400, headers: getSecurityHeaders() })
    }

    const sanitizedComment = comment ? sanitizeInput(String(comment)).slice(0, 500) : null
    const sanitizedIngredient = ingredient_name ? sanitizeInput(String(ingredient_name)).slice(0, 200) : null

    try {
      await execute(
        'INSERT INTO feedback (id, scan_id, rating, comment, ingredient_name) VALUES (?, ?, ?, ?, ?)',
        [generateId(), scan_id, rating, sanitizedComment, sanitizedIngredient]
      )
    } catch (e) {
      console.error('Feedback insert failed:', e)
      return NextResponse.json({ error: 'Failed to save feedback' }, { status: 500, headers: getSecurityHeaders() })
    }

    return NextResponse.json({ success: true }, { headers: getSecurityHeaders() })
  } catch (error) {
    console.error('Feedback endpoint error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500, headers: getSecurityHeaders() })
  }
}
