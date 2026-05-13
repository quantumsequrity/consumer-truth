import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { sendWhatsAppMessage, sendWhatsAppAudio, verifyWebhookSignature, downloadMedia } from '@/lib/whatsapp'
import { rateLimit, sanitizeInput, getSecurityHeaders } from '@/lib/security'
import {
    handlePhoto,
    handleVoice,
    handleCompare,
    handleText,
    tryParseCompareIntent,
    type MessengerAdapter,
} from '@/lib/webhook-shared'

export const maxDuration = 60

const limiter = rateLimit({ windowMs: 60000, maxRequests: 10 })

const whatsappAdapter: MessengerAdapter = {
    channel: 'whatsapp',
    sendMessage: (to, text) => sendWhatsAppMessage(to, text),
    sendAudio: (to, audioUrl) => sendWhatsAppAudio(to, audioUrl),
    downloadMedia: (mediaId) => downloadMedia(mediaId),
}

/**
 * GET handler - Meta webhook verification.
 */
export async function GET(req: NextRequest) {
    const searchParams = req.nextUrl.searchParams
    const mode = searchParams.get('hub.mode')
    const token = searchParams.get('hub.verify_token')
    const challenge = searchParams.get('hub.challenge')

    const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN

    // Timing-safe compare on equal-length strings, fall through otherwise.
    let tokenOk = false
    if (mode === 'subscribe' && token && verifyToken && token.length === verifyToken.length) {
        try {
            tokenOk = crypto.timingSafeEqual(Buffer.from(token), Buffer.from(verifyToken))
        } catch {
            tokenOk = false
        }
    }

    if (tokenOk) {
        console.log('[whatsapp] Webhook verified successfully')
        return new NextResponse(challenge, {
            status: 200,
            headers: { 'Content-Type': 'text/plain', ...getSecurityHeaders() },
        })
    }

    console.warn('[whatsapp] Webhook verification failed')
    return NextResponse.json(
        { error: 'Forbidden' },
        { status: 403, headers: getSecurityHeaders() }
    )
}

/**
 * POST handler - Incoming WhatsApp messages from Meta webhook.
 */
export async function POST(req: NextRequest) {
    try {
        const rawBody = await req.text()

        const signature = req.headers.get('x-hub-signature-256')
        if (!verifyWebhookSignature(signature, rawBody)) {
            console.error('[whatsapp] Invalid webhook signature - rejecting request')
            return NextResponse.json({ error: 'Unauthorized' }, { status: 403, headers: getSecurityHeaders() })
        }

        const body = JSON.parse(rawBody)
        const entry = body.entry?.[0]
        const changes = entry?.changes?.[0]
        const value = changes?.value

        if (!value?.messages || value.messages.length === 0) {
            // Status update (delivered, read, etc.) — acknowledge.
            return NextResponse.json({ success: true }, { headers: getSecurityHeaders() })
        }

        const message = value.messages[0]
        const from = message.from
        const messageType = message.type
        const profileName = sanitizeInput(value.contacts?.[0]?.profile?.name || 'User')

        const textBody = sanitizeInput(
            messageType === 'text'
                ? (message.text?.body || '')
                : (message.image?.caption || message.document?.caption || ''),
        )

        const { allowed } = limiter(from)
        if (!allowed) {
            await sendWhatsAppMessage(from, 'Please wait a moment before sending another request.')
            return NextResponse.json({ success: true }, { headers: getSecurityHeaders() })
        }

        const hashedFrom = crypto.createHash('sha256').update(from || '').digest('hex').slice(0, 12)
        console.log(`[whatsapp] From ${hashedFrom}: ${textBody} (Type: ${messageType})`)

        if (messageType === 'image') {
            const mediaId = message.image?.id
            if (!mediaId) {
                await sendWhatsAppMessage(from, 'Could not retrieve the media. Please try sending again.')
                return NextResponse.json({ success: true }, { headers: getSecurityHeaders() })
            }
            await handlePhoto(whatsappAdapter, from, mediaId, textBody, hashedFrom)
        } else if (messageType === 'audio') {
            const mediaId = message.audio?.id
            if (!mediaId) {
                await sendWhatsAppMessage(from, 'Could not retrieve the audio. Please try sending again.')
                return NextResponse.json({ success: true }, { headers: getSecurityHeaders() })
            }
            await handleVoice(whatsappAdapter, from, mediaId, hashedFrom)
        } else if (textBody && tryParseCompareIntent(textBody)) {
            const compared = tryParseCompareIntent(textBody)!
            await handleCompare(whatsappAdapter, from, compared.productA, compared.productB, hashedFrom)
        } else {
            await handleText(whatsappAdapter, from, textBody, profileName, hashedFrom)
        }

        return NextResponse.json({ success: true }, { headers: getSecurityHeaders() })
    } catch (error) {
        console.error('[whatsapp] Webhook error:', error)
        // Always 200 to Meta to prevent retries on parse errors.
        return NextResponse.json({ success: true }, { status: 200, headers: getSecurityHeaders() })
    }
}
