import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { sendTelegramMessage, sendTelegramAudio, downloadTelegramFile, verifyTelegramWebhookSecret } from '@/lib/telegram'
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

const telegramAdapter: MessengerAdapter = {
    channel: 'telegram',
    sendMessage: (to, text) => sendTelegramMessage(to, text),
    sendAudio: (to, audioUrl) => sendTelegramAudio(to, audioUrl),
    downloadMedia: (mediaId) => downloadTelegramFile(mediaId),
}

/**
 * POST handler - Incoming Telegram updates via webhook.
 */
export async function POST(req: NextRequest) {
    try {
        // Reject forged updates. Anyone who knows the webhook URL could
        // otherwise impersonate any user and bypass per-user rate limiting.
        const secretHeader = req.headers.get('x-telegram-bot-api-secret-token')
        if (!verifyTelegramWebhookSecret(secretHeader)) {
            return NextResponse.json({ ok: false }, { status: 403, headers: getSecurityHeaders() })
        }

        const body = await req.json()
        const message = body.message
        if (!message) {
            return NextResponse.json({ ok: true }, { headers: getSecurityHeaders() })
        }

        const chatId = message.chat?.id
        const fromUser = message.from
        if (!chatId) {
            return NextResponse.json({ ok: true }, { headers: getSecurityHeaders() })
        }

        const chatIdStr = String(chatId)
        const userId = String(fromUser?.id || chatId)
        const profileName = sanitizeInput(fromUser?.first_name || 'User')

        // Rate limiting per user ID
        const { allowed } = limiter(userId)
        if (!allowed) {
            await sendTelegramMessage(chatId, 'Please wait a moment before sending another request.')
            return NextResponse.json({ ok: true }, { headers: getSecurityHeaders() })
        }

        const hashedId = crypto.createHash('sha256').update(userId).digest('hex').slice(0, 12)
        const adapter = telegramAdapter

        const hasPhoto = message.photo && message.photo.length > 0
        const hasVoice = !!message.voice
        const hasAudio = !!message.audio
        const textBody = sanitizeInput(message.text || message.caption || '')

        console.log(`[telegram] From ${hashedId}: ${textBody} (photo=${hasPhoto}, voice=${hasVoice})`)

        if (hasPhoto) {
            const photo = message.photo[message.photo.length - 1]
            const fileId = photo?.file_id
            if (!fileId) {
                await sendTelegramMessage(chatId, 'Could not retrieve the photo. Please try sending again.')
                return NextResponse.json({ ok: true }, { headers: getSecurityHeaders() })
            }
            await handlePhoto(adapter, chatIdStr, fileId, textBody, hashedId)
        } else if (hasVoice || hasAudio) {
            const fileId = hasVoice ? message.voice.file_id : message.audio.file_id
            if (!fileId) {
                await sendTelegramMessage(chatId, 'Could not retrieve the audio. Please try sending again.')
                return NextResponse.json({ ok: true }, { headers: getSecurityHeaders() })
            }
            await handleVoice(adapter, chatIdStr, fileId, hashedId)
        } else if (textBody && tryParseCompareIntent(textBody)) {
            const compared = tryParseCompareIntent(textBody)!
            await handleCompare(adapter, chatIdStr, compared.productA, compared.productB, hashedId)
        } else {
            await handleText(adapter, chatIdStr, textBody, profileName, hashedId)
        }

        return NextResponse.json({ ok: true }, { headers: getSecurityHeaders() })
    } catch (error) {
        console.error('[telegram] Webhook error:', error)
        return NextResponse.json({ ok: true }, { status: 200, headers: getSecurityHeaders() })
    }
}
