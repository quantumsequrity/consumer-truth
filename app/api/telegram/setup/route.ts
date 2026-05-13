import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { setWebhook } from '@/lib/telegram'
import { getSecurityHeaders } from '@/lib/security'

/**
 * GET /api/telegram/setup
 *
 * One-time setup endpoint to register the Telegram webhook. Requires a
 * `?secret=` parameter that matches `TELEGRAM_SETUP_SECRET`.
 *
 * IMPORTANT: this used to accept the bot token itself as the secret. That was
 * wrong — the bot token doubles as the Telegram API credential, and putting
 * it in a URL leaks it into server access logs and the user's browser
 * history. Use a separate `openssl rand -hex 32` value.
 *
 * Usage:
 *   curl "https://your-domain.com/api/telegram/setup?secret=$TELEGRAM_SETUP_SECRET"
 */
export async function GET(req: NextRequest) {
    const secret = req.nextUrl.searchParams.get('secret')
    const botToken = process.env.TELEGRAM_BOT_TOKEN
    const setupSecret = process.env.TELEGRAM_SETUP_SECRET

    if (!botToken) {
        return NextResponse.json(
            { error: 'TELEGRAM_BOT_TOKEN not configured' },
            { status: 500, headers: getSecurityHeaders() }
        )
    }

    if (!setupSecret) {
        return NextResponse.json(
            { error: 'TELEGRAM_SETUP_SECRET not configured. Set it with `wrangler secret put TELEGRAM_SETUP_SECRET`.' },
            { status: 500, headers: getSecurityHeaders() }
        )
    }

    // Timing-safe equality. Reject early on missing input or length mismatch
    // (the early returns leak the length comparison, but the secret length is
    // not itself sensitive — the secret content is what matters).
    let authorized = false
    if (secret && secret.length === setupSecret.length) {
        try {
            authorized = crypto.timingSafeEqual(Buffer.from(secret), Buffer.from(setupSecret))
        } catch {
            authorized = false
        }
    }

    if (!authorized) {
        return NextResponse.json(
            { error: 'Invalid secret' },
            { status: 403, headers: getSecurityHeaders() }
        )
    }

    const appUrl = process.env.NEXT_PUBLIC_APP_URL
    if (!appUrl) {
        return NextResponse.json(
            { error: 'NEXT_PUBLIC_APP_URL not configured' },
            { status: 500, headers: getSecurityHeaders() }
        )
    }

    // Sanity: TELEGRAM_WEBHOOK_SECRET should also be set, otherwise the
    // webhook route can't enforce signature verification. Warn loudly.
    if (!process.env.TELEGRAM_WEBHOOK_SECRET && process.env.NODE_ENV === 'production') {
        return NextResponse.json(
            { error: 'TELEGRAM_WEBHOOK_SECRET not configured — refusing to register an unverified webhook in production.' },
            { status: 500, headers: getSecurityHeaders() }
        )
    }

    const webhookUrl = `${appUrl}/api/telegram/webhook`
    const result = await setWebhook(webhookUrl)

    if (result.success) {
        return NextResponse.json(
            { ok: true, webhook_url: webhookUrl, telegram_response: result.data },
            { headers: getSecurityHeaders() }
        )
    }

    return NextResponse.json(
        { error: 'Failed to set webhook', details: result.error },
        { status: 500, headers: getSecurityHeaders() }
    )
}
