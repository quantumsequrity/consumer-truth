import crypto from 'crypto'

// R2 bucket type (from Cloudflare Workers runtime)
interface R2Object {
  key: string
  uploaded?: Date | string
  customMetadata?: Record<string, string>
}

interface R2ListResult {
  objects: R2Object[]
  truncated?: boolean
  cursor?: string
}

interface R2Bucket {
  put(key: string, value: ArrayBuffer | string, options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }): Promise<any>
  get(key: string): Promise<{ body: ReadableStream; httpMetadata?: { contentType?: string }; size: number } | null>
  delete(key: string | string[]): Promise<void>
  list(options?: { prefix?: string; cursor?: string; limit?: number }): Promise<R2ListResult>
}

// In-memory fallback for local dev (not on Cloudflare Workers)
interface AudioEntry {
  buffer: Buffer
  mimeType: string
  expiresAt: number
}

const memStore = new Map<string, AudioEntry>()
const MAX_ENTRIES = 50
const TTL_MS = 5 * 60 * 1000 // 5 minutes

// R2 has no built-in object TTL. We stamp a createdAt epoch ms on each upload
// and let the sweeper (app/api/cron/audio-sweep) delete anything older than
// R2_AUDIO_TTL_MS. Default: 1 hour, which is plenty for a freshly-issued TTS
// reply to be played back from WhatsApp / Telegram / the web client.
const R2_AUDIO_TTL_MS = 60 * 60 * 1000

/**
 * Get the R2 bucket binding if running on Cloudflare Workers.
 * Returns null in local dev.
 */
function getR2Bucket(): R2Bucket | null {
  try {
    // @opennextjs/cloudflare provides getCloudflareContext
    const { getCloudflareContext } = require('@opennextjs/cloudflare')
    const { env } = getCloudflareContext()
    return env?.AUDIO_BUCKET || null
  } catch {
    return null
  }
}

/**
 * Store audio data. Uses R2 on Cloudflare, in-memory locally.
 * Returns a unique ID.
 */
export async function storeAudio(buffer: Buffer, mimeType: string): Promise<string> {
  const id = crypto.randomBytes(16).toString('hex')
  const bucket = getR2Bucket()

  if (bucket) {
    // Cloudflare R2 storage
    await bucket.put(`tts/${id}.mp3`, buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer, {
      httpMetadata: { contentType: mimeType },
      customMetadata: { createdAt: Date.now().toString() },
    })
  } else {
    // In-memory fallback for local dev
    if (memStore.size >= MAX_ENTRIES) {
      let oldestKey = ''
      let oldestTime = Infinity
      for (const [key, entry] of memStore) {
        if (entry.expiresAt < oldestTime) {
          oldestTime = entry.expiresAt
          oldestKey = key
        }
      }
      if (oldestKey) memStore.delete(oldestKey)
    }

    memStore.set(id, {
      buffer,
      mimeType,
      expiresAt: Date.now() + TTL_MS,
    })
  }

  return id
}

/**
 * Retrieve audio data by ID. Uses R2 on Cloudflare, in-memory locally.
 * Returns null if not found.
 */
export async function getAudio(id: string): Promise<{ buffer: Buffer; mimeType: string } | null> {
  const bucket = getR2Bucket()

  if (bucket) {
    // Cloudflare R2 storage
    const object = await bucket.get(`tts/${id}.mp3`)
    if (!object) return null

    const arrayBuffer = await new Response(object.body).arrayBuffer()
    return {
      buffer: Buffer.from(arrayBuffer),
      mimeType: object.httpMetadata?.contentType || 'audio/mpeg',
    }
  } else {
    // In-memory fallback
    const entry = memStore.get(id)
    if (!entry) return null
    if (Date.now() > entry.expiresAt) {
      memStore.delete(id)
      return null
    }
    return { buffer: entry.buffer, mimeType: entry.mimeType }
  }
}

/**
 * Sweep expired audio objects from R2. Designed to be called from a cron
 * route — see app/api/cron/audio-sweep/route.ts. Returns the count of
 * deleted keys plus a `truncated` flag the caller can use to schedule a
 * follow-up run when the bucket has more than `pageLimit` candidates.
 *
 * Safe to call repeatedly; works as a noop when no R2 binding is available.
 */
export async function sweepExpiredAudio(
  options: { ttlMs?: number; pageLimit?: number } = {},
): Promise<{ scanned: number; deleted: number; truncated: boolean }> {
  const bucket = getR2Bucket()
  if (!bucket) return { scanned: 0, deleted: 0, truncated: false }

  const ttlMs = options.ttlMs ?? R2_AUDIO_TTL_MS
  const limit = options.pageLimit ?? 1000
  const cutoff = Date.now() - ttlMs

  const listed = await bucket.list({ prefix: 'tts/', limit })
  const toDelete: string[] = []

  for (const obj of listed.objects || []) {
    const stampedAt = Number(obj.customMetadata?.createdAt)
    const uploadedAt = obj.uploaded
      ? (typeof obj.uploaded === 'string' ? Date.parse(obj.uploaded) : obj.uploaded.getTime())
      : NaN

    // Prefer our own stamp (always set on `storeAudio`); fall back to R2's
    // upload timestamp for legacy objects that pre-date the stamp.
    const createdAt = Number.isFinite(stampedAt) ? stampedAt : uploadedAt
    if (!Number.isFinite(createdAt)) continue
    if (createdAt < cutoff) toDelete.push(obj.key)
  }

  if (toDelete.length > 0) {
    // R2 delete accepts an array.
    await bucket.delete(toDelete)
  }

  return {
    scanned: listed.objects?.length ?? 0,
    deleted: toDelete.length,
    truncated: !!listed.truncated,
  }
}
