import { getAudioBase64 } from 'google-tts-api'
import { storeAudio } from './audio-store'

// Language name → BCP-47 code mapping
const LANGUAGE_CODES: Record<string, string> = {
  english: 'en',
  hindi: 'hi',
  tamil: 'ta',
  telugu: 'te',
  kannada: 'kn',
  malayalam: 'ml',
  bengali: 'bn',
  marathi: 'mr',
  gujarati: 'gu',
  punjabi: 'pa',
  odia: 'or',
  assamese: 'as',
  urdu: 'ur',
  nepali: 'ne',
  arabic: 'ar',
  spanish: 'es',
  french: 'fr',
  german: 'de',
  japanese: 'ja',
  korean: 'ko',
  chinese: 'zh',
}

function getLanguageCode(language: string): string {
  const key = language.toLowerCase().trim()
  return LANGUAGE_CODES[key] || 'en'
}

// google-tts-api has a ~200 char limit per request
// Split text into chunks at sentence boundaries
function splitTextIntoChunks(text: string, maxLength: number = 180): string[] {
  if (text.length <= maxLength) return [text]

  const chunks: string[] = []
  let remaining = text

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining)
      break
    }

    // Try to split at sentence boundary (. ! ?)
    let splitIdx = -1
    for (let i = maxLength; i >= maxLength / 2; i--) {
      if (remaining[i] === '.' || remaining[i] === '!' || remaining[i] === '?') {
        splitIdx = i + 1
        break
      }
    }

    // Fallback: split at last space
    if (splitIdx === -1) {
      for (let i = maxLength; i >= maxLength / 2; i--) {
        if (remaining[i] === ' ') {
          splitIdx = i + 1
          break
        }
      }
    }

    // Worst case: hard cut
    if (splitIdx === -1) splitIdx = maxLength

    chunks.push(remaining.slice(0, splitIdx).trim())
    remaining = remaining.slice(splitIdx).trim()
  }

  return chunks.filter(c => c.length > 0)
}

/**
 * Generate TTS audio using google-tts-api (Google Translate voice engine).
 * Returns an audio store ID that can be served via /api/audio/[id].
 * Returns null on failure.
 */
export async function generateTTSAudio(
  text: string,
  language: string = 'English'
): Promise<string | null> {
  try {
    const langCode = getLanguageCode(language)

    // Limit total text to 4000 chars (~20 chunks = ~60s audio)
    const safeText = text.slice(0, 4000)
    const chunks = splitTextIntoChunks(safeText)

    console.log(`[TTS] Generating audio: ${chunks.length} chunk(s), lang=${langCode}`)

    const audioBuffers: Buffer[] = []

    for (const chunk of chunks) {
      const base64 = await getAudioBase64(chunk, {
        lang: langCode,
        slow: false,
        host: 'https://translate.google.com',
      })
      audioBuffers.push(Buffer.from(base64, 'base64'))
    }

    // Concatenate all MP3 chunks
    const fullAudio = Buffer.concat(audioBuffers)

    // Store in R2 (or memory in dev) and return the ID
    const audioId = await storeAudio(fullAudio, 'audio/mpeg')
    console.log(`[TTS] Audio stored: ${audioId} (${fullAudio.length} bytes)`)

    return audioId
  } catch (error) {
    console.error('[TTS] Generation failed:', error)
    return null
  }
}

/**
 * Build the public URL for a stored audio file.
 * Returns null if no APP_URL is configured.
 */
export function getAudioUrl(audioId: string): string | null {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.VERCEL_URL
  if (!baseUrl) {
    console.warn('[TTS] No APP_URL configured, cannot build audio URL')
    return null
  }
  const origin = baseUrl.startsWith('http') ? baseUrl : `https://${baseUrl}`
  return `${origin}/api/audio/${audioId}`
}
