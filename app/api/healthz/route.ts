import { NextResponse } from 'next/server'
import { getSecurityHeaders } from '@/lib/security'

/**
 * GET /api/healthz
 *
 * Lightweight liveness + binding-presence probe for ops dashboards and
 * synthetic monitors. Returns 200 with a JSON status; never throws.
 *
 * Reports:
 *   - Process liveness (the fact that we returned at all)
 *   - Whether each Cloudflare binding we expect is wired up
 *   - Whether each runtime secret is present (boolean only — never the value)
 *
 * Deliberately NOT auth-gated. Everything here is non-sensitive metadata.
 */

interface CfEnv {
    APP_DB?: unknown
    FOOD_DB?: unknown
    FOOD_NUTRITION_DB?: unknown
    FOOD_META_DB?: unknown
    INGREDIENTS_REF_DB?: unknown
    AUDIO_BUCKET?: unknown
    AI?: unknown
    [k: string]: unknown
}

function readCfEnv(): CfEnv | null {
    try {
        const { getCloudflareContext } = require('@opennextjs/cloudflare')
        const { env } = getCloudflareContext()
        return env ?? null
    } catch {
        return null
    }
}

export async function GET() {
    const env = readCfEnv()
    const has = (k: string) => env ? Object.prototype.hasOwnProperty.call(env, k) && env[k] != null : false

    const secretSet = (k: string) =>
        Boolean(process.env[k] && (process.env[k] as string).length > 0)

    return NextResponse.json(
        {
            ok: true,
            timestamp: new Date().toISOString(),
            runtime: {
                cloudflare_context: env !== null,
                node_env: process.env.NODE_ENV || 'unknown',
            },
            bindings: {
                APP_DB: has('APP_DB'),
                FOOD_DB: has('FOOD_DB'),
                FOOD_NUTRITION_DB: has('FOOD_NUTRITION_DB'),
                FOOD_META_DB: has('FOOD_META_DB'),
                INGREDIENTS_REF_DB: has('INGREDIENTS_REF_DB'),
                AUDIO_BUCKET: has('AUDIO_BUCKET'),
                AI: has('AI'),
            },
            secrets: {
                GEMINI_API_KEY: secretSet('GEMINI_API_KEY'),
                WHATSAPP_TOKEN: secretSet('WHATSAPP_TOKEN'),
                WHATSAPP_APP_SECRET: secretSet('WHATSAPP_APP_SECRET'),
                TELEGRAM_BOT_TOKEN: secretSet('TELEGRAM_BOT_TOKEN'),
                TELEGRAM_WEBHOOK_SECRET: secretSet('TELEGRAM_WEBHOOK_SECRET'),
                TELEGRAM_SETUP_SECRET: secretSet('TELEGRAM_SETUP_SECRET'),
                HASH_SALT: secretSet('HASH_SALT'),
                SCAN_TOKEN_SECRET: secretSet('SCAN_TOKEN_SECRET'),
                CRON_SECRET: secretSet('CRON_SECRET'),
            },
            flags: {
                USE_GROUNDED_RENDERER: process.env.USE_GROUNDED_RENDERER || 'false',
                RENDERER_BACKEND: process.env.RENDERER_BACKEND || 'gemini',
            },
        },
        { headers: { 'Cache-Control': 'no-store', ...getSecurityHeaders() } }
    )
}
