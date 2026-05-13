import { NextRequest, NextResponse } from 'next/server'
import { transcribeAudio } from '@/lib/gemini'
import {
    rateLimit,
    getClientIdentifier,
    validateFileSignature,
    validateOrigin,
    getSecurityHeaders,
} from '@/lib/security'

/**
 * POST /api/preview/voice
 *
 * Transcribes a voice note and returns the raw text. No intent detection,
 * no LLM answer, no DB writes — the user is expected to look at the
 * transcription, correct any mistakes, and then submit the edited text
 * through /api/question for an answer.
 *
 * Why this exists: STT mishears words constantly (product names, Indian
 * languages, accents). The previous flow committed to the LLM answer based
 * on the raw transcription; if the transcription was wrong, the user had
 * no way to fix it without re-recording. This endpoint is the equivalent
 * of /api/preview/image for the voice tab.
 */

export const maxDuration = 30

const limiter = rateLimit({ windowMs: 60000, maxRequests: 10 })

const ALLOWED_AUDIO_TYPES = [
    'audio/ogg',
    'audio/mp3',
    'audio/mp4',
    'audio/mpeg',
    'audio/webm',
    'audio/wav',
]

export async function POST(req: NextRequest) {
    try {
        if (!validateOrigin(req)) {
            return NextResponse.json({ error: 'Forbidden' }, { status: 403, headers: getSecurityHeaders() })
        }

        const clientId = getClientIdentifier(req)
        const { allowed } = limiter(clientId)
        if (!allowed) {
            return NextResponse.json(
                { error: 'Too many requests. Please wait.' },
                { status: 429, headers: getSecurityHeaders() }
            )
        }

        const formData = await req.formData()
        const audioFile = formData.get('audio')
        if (!audioFile || !(audioFile instanceof File)) {
            return NextResponse.json(
                { error: 'No audio file provided' },
                { status: 400, headers: getSecurityHeaders() }
            )
        }

        if (audioFile.size > 10 * 1024 * 1024) {
            return NextResponse.json(
                { error: 'Audio file too large (max 10MB)' },
                { status: 400, headers: getSecurityHeaders() }
            )
        }

        const mimeType = audioFile.type || 'audio/ogg'
        if (!ALLOWED_AUDIO_TYPES.includes(mimeType)) {
            return NextResponse.json(
                { error: 'Unsupported audio format. Please use OGG, MP3, MP4, WAV, or WebM.' },
                { status: 400, headers: getSecurityHeaders() }
            )
        }

        const signatureValid = await validateFileSignature(audioFile)
        if (!signatureValid) {
            return NextResponse.json(
                { error: 'File content does not match its declared audio type.' },
                { status: 400, headers: getSecurityHeaders() }
            )
        }

        const buffer = Buffer.from(await audioFile.arrayBuffer())
        const transcription = await transcribeAudio(buffer, mimeType)

        if (!transcription || transcription.trim().length < 2) {
            return NextResponse.json(
                { error: 'Could not understand the audio. Please speak clearly and try again.' },
                { status: 400, headers: getSecurityHeaders() }
            )
        }

        return NextResponse.json(
            { transcription: transcription.trim() },
            { headers: getSecurityHeaders() }
        )
    } catch (err) {
        console.error('[PreviewVoice] failed:', err)
        return NextResponse.json(
            { error: 'Transcription failed. Please try again.' },
            { status: 500, headers: getSecurityHeaders() }
        )
    }
}
