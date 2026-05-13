import { NextRequest, NextResponse } from 'next/server'
import { rateLimit, getClientIdentifier, sanitizeInput, validateOrigin, getSecurityHeaders } from '@/lib/security'
import { searchProducts, searchProductsByBarcode, type ProductRecord } from '@/lib/product-data'

export const maxDuration = 15

const limiter = rateLimit({ windowMs: 60000, maxRequests: 20 })

export async function POST(req: NextRequest) {
  try {
    if (!validateOrigin(req)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403, headers: getSecurityHeaders() })
    }

    // Rate limiting
    const clientId = getClientIdentifier(req)
    const { allowed } = limiter(clientId)
    if (!allowed) {
      return NextResponse.json(
        { error: 'Too many requests. Please wait a moment.' },
        { status: 429, headers: getSecurityHeaders() }
      )
    }

    const body = await req.json()
    const rawQuery = body.query || ''

    if (!rawQuery || typeof rawQuery !== 'string') {
      return NextResponse.json(
        { error: 'Please provide a search query' },
        { status: 400, headers: getSecurityHeaders() }
      )
    }

    const query = sanitizeInput(rawQuery).trim()
    if (query.length < 2) {
      return NextResponse.json(
        { error: 'Search query too short (minimum 2 characters)' },
        { status: 400, headers: getSecurityHeaders() }
      )
    }

    if (query.length > 200) {
      return NextResponse.json(
        { error: 'Search query too long (maximum 200 characters)' },
        { status: 400, headers: getSecurityHeaders() }
      )
    }

    // Check if the query looks like a barcode (all digits, 8-14 chars)
    const isBarcodeQuery = /^\d{8,14}$/.test(query)

    let results: ProductRecord[] = []

    if (isBarcodeQuery) {
      const product = await searchProductsByBarcode(query)
      if (product) {
        results = [product]
      }
    } else {
      results = await searchProducts(query, 10)
    }

    return NextResponse.json(
      { results, query, count: results.length },
      { headers: getSecurityHeaders() }
    )
  } catch (error: any) {
    console.error('[Search API] Error:', error.message || error)
    return NextResponse.json(
      { error: 'Search failed. Please try again.' },
      { status: 500, headers: getSecurityHeaders() }
    )
  }
}
