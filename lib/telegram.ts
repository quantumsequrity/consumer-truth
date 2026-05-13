import crypto from 'crypto'

const botToken = process.env.TELEGRAM_BOT_TOKEN

if (!botToken) {
    if (process.env.NODE_ENV === 'production') {
        console.error(
            'Missing TELEGRAM_BOT_TOKEN environment variable. ' +
            'Telegram bot will not work.'
        )
    } else {
        console.warn('Missing TELEGRAM_BOT_TOKEN - Telegram operations will fail')
    }
}

export type TelegramResult = { success: true; data: any } | { success: false; error: string }

const TELEGRAM_API = `https://api.telegram.org/bot${botToken}`

/**
 * Verify the X-Telegram-Bot-Api-Secret-Token header on incoming webhooks.
 *
 * Telegram echoes back whatever `secret_token` was passed to setWebhook. We
 * compare it timing-safely to TELEGRAM_WEBHOOK_SECRET. Without this check
 * anyone who knows the webhook URL can forge updates pretending to be any
 * user, bypassing the per-user rate limit.
 *
 * Dev fallback: if no secret is configured AND we are not in production, the
 * check is skipped with a warning. In production a missing secret is a hard
 * fail so the webhook cannot accidentally ship unguarded.
 */
export function verifyTelegramWebhookSecret(headerValue: string | null): boolean {
    const expected = process.env.TELEGRAM_WEBHOOK_SECRET

    if (!expected) {
        if (process.env.NODE_ENV === 'production') {
            console.error('[Telegram] TELEGRAM_WEBHOOK_SECRET not set in production — rejecting')
            return false
        }
        console.warn('[Telegram] TELEGRAM_WEBHOOK_SECRET not set — skipping check (dev only)')
        return true
    }

    if (!headerValue) {
        console.warn('[Telegram] Missing X-Telegram-Bot-Api-Secret-Token header')
        return false
    }

    // Telegram secret tokens are 1–256 chars of A-Z, a-z, 0-9, _, -.
    // Equal-length precondition for timingSafeEqual.
    if (headerValue.length !== expected.length) {
        return false
    }

    try {
        const a = Buffer.from(headerValue)
        const b = Buffer.from(expected)
        return crypto.timingSafeEqual(a, b)
    } catch {
        return false
    }
}

/**
 * Make a Telegram Bot API call.
 */
async function telegramApiCall(method: string, payload: Record<string, any>): Promise<TelegramResult> {
    const res = await fetch(`${TELEGRAM_API}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    })

    if (!res.ok) {
        const errText = await res.text()
        console.error(`[Telegram] API error (${res.status}) on ${method}: ${errText}`)
        return { success: false, error: errText }
    }

    return { success: true, data: await res.json() }
}

/**
 * Split text into chunks of ≤maxLen chars, breaking at newlines when possible.
 */
function splitMessage(text: string, maxLen = 4096): string[] {
    if (text.length <= maxLen) return [text]

    const chunks: string[] = []
    let remaining = text

    while (remaining.length > 0) {
        if (remaining.length <= maxLen) {
            chunks.push(remaining)
            break
        }

        // Find last newline within maxLen
        let splitAt = remaining.lastIndexOf('\n', maxLen)
        if (splitAt < maxLen * 0.3) {
            // No good newline break — split at maxLen
            splitAt = maxLen
        }

        chunks.push(remaining.slice(0, splitAt))
        remaining = remaining.slice(splitAt).replace(/^\n/, '') // trim leading newline from next chunk
    }

    return chunks
}

/**
 * Send a text message to a Telegram chat.
 * Supports Markdown formatting.
 * Automatically splits messages longer than 4096 chars.
 */
export async function sendTelegramMessage(chatId: number | string, text: string): Promise<TelegramResult> {
    const chunks = splitMessage(text, 4096)
    let lastResult: TelegramResult = { success: true, data: null }

    for (const chunk of chunks) {
        try {
            lastResult = await telegramApiCall('sendMessage', {
                chat_id: chatId,
                text: chunk,
                parse_mode: 'Markdown',
            })
        } catch (error) {
            console.error('[Telegram] Error sending message:', error)
            // Retry without Markdown if parse_mode causes issues
            try {
                lastResult = await telegramApiCall('sendMessage', {
                    chat_id: chatId,
                    text: chunk,
                })
            } catch (retryError) {
                return { success: false, error: String(retryError) }
            }
        }
    }

    return lastResult
}

/**
 * Send an audio file via URL to a Telegram chat.
 * Uses sendVoice for voice-like TTS audio (plays inline in Telegram).
 */
export async function sendTelegramAudio(chatId: number | string, audioUrl: string): Promise<TelegramResult> {
    try {
        return await telegramApiCall('sendVoice', {
            chat_id: chatId,
            voice: audioUrl,
        })
    } catch (error) {
        console.error('[Telegram] Error sending audio:', error)
        return { success: false, error: String(error) }
    }
}

/**
 * Download a file from Telegram servers.
 * First gets the file path via getFile, then downloads the actual file.
 * Returns the buffer and a guessed MIME type.
 */
export async function downloadTelegramFile(fileId: string): Promise<{ buffer: Buffer; mimeType: string } | null> {
    try {
        // Step 1: Get file path from Telegram
        const fileInfoRes = await fetch(`${TELEGRAM_API}/getFile?file_id=${encodeURIComponent(fileId)}`)
        if (!fileInfoRes.ok) {
            console.error(`[Telegram] getFile failed (${fileInfoRes.status})`)
            return null
        }

        const fileInfo = await fileInfoRes.json()
        const filePath: string | undefined = fileInfo.result?.file_path
        if (!filePath) {
            console.error('[Telegram] No file_path in getFile response')
            return null
        }

        // Step 2: Download the file
        const fileUrl = `https://api.telegram.org/file/bot${botToken}/${filePath}`

        // SSRF protection: only allow Telegram file URLs
        const parsedUrl = new URL(fileUrl)
        if (parsedUrl.hostname !== 'api.telegram.org') {
            console.error(`[Telegram] Blocked non-Telegram file URL: ${parsedUrl.hostname}`)
            return null
        }

        const fileRes = await fetch(fileUrl)
        if (!fileRes.ok) {
            console.error(`[Telegram] File download failed (${fileRes.status})`)
            return null
        }

        const arrayBuffer = await fileRes.arrayBuffer()
        const buffer = Buffer.from(arrayBuffer)

        // Guess MIME type from file extension
        const ext = filePath.split('.').pop()?.toLowerCase() || ''
        const mimeMap: Record<string, string> = {
            jpg: 'image/jpeg',
            jpeg: 'image/jpeg',
            png: 'image/png',
            webp: 'image/webp',
            gif: 'image/gif',
            ogg: 'audio/ogg',
            oga: 'audio/ogg',
            mp3: 'audio/mpeg',
            m4a: 'audio/mp4',
            wav: 'audio/wav',
        }
        const mimeType = mimeMap[ext] || 'application/octet-stream'

        return { buffer, mimeType }
    } catch (error) {
        console.error('[Telegram] File download error:', error)
        return null
    }
}

/**
 * Set the webhook URL for the Telegram bot.
 *
 * Registers the TELEGRAM_WEBHOOK_SECRET so Telegram echoes it back on every
 * update via the X-Telegram-Bot-Api-Secret-Token header. The webhook handler
 * uses that to reject forged requests.
 */
export async function setWebhook(url: string): Promise<TelegramResult> {
    const payload: Record<string, string> = { url }
    const secret = process.env.TELEGRAM_WEBHOOK_SECRET
    if (secret) {
        payload.secret_token = secret
    }
    return telegramApiCall('setWebhook', payload)
}
