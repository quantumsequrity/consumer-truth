import { NextRequest } from 'next/server'
import crypto from 'crypto'

// Rate limiting store (in-memory for now, use Redis in production)
const RATE_LIMIT_MAX_ENTRIES = 10000
const rateLimitStore = new Map<string, { count: number; resetTime: number }>()

function cleanupRateLimitStore() {
  const now = Date.now()

  // First pass: remove expired entries
  for (const [key, record] of rateLimitStore) {
    if (now > record.resetTime) {
      rateLimitStore.delete(key)
    }
  }

  // If still over cap, remove oldest entries until under limit
  if (rateLimitStore.size >= RATE_LIMIT_MAX_ENTRIES) {
    const entries = [...rateLimitStore.entries()].sort(
      (a, b) => a[1].resetTime - b[1].resetTime
    )
    const toRemove = rateLimitStore.size - RATE_LIMIT_MAX_ENTRIES + 1
    for (let i = 0; i < toRemove; i++) {
      rateLimitStore.delete(entries[i][0])
    }
  }
}

export interface RateLimitConfig {
  windowMs: number // Time window in milliseconds
  maxRequests: number // Max requests per window
}

export function rateLimit(config: RateLimitConfig) {
  return (identifier: string): { allowed: boolean; resetTime?: number } => {
    const now = Date.now()
    const record = rateLimitStore.get(identifier)

    if (!record || now > record.resetTime) {
      // New window or expired - cleanup before adding
      cleanupRateLimitStore()
      rateLimitStore.set(identifier, {
        count: 1,
        resetTime: now + config.windowMs,
      })
      return { allowed: true }
    }

    // Atomic check-and-increment: increment first, then check
    record.count++
    if (record.count > config.maxRequests) {
      return { allowed: false, resetTime: record.resetTime }
    }

    return { allowed: true }
  }
}

// Get client identifier (IP address or phone number)
export function getClientIdentifier(req: NextRequest): string {
  // Use multiple headers to build a more reliable identifier.
  // Do not trust X-Forwarded-For alone as it is trivially spoofable.
  const forwardedFor = req.headers.get('x-forwarded-for')?.split(',')[0].trim() || ''
  const realIp = req.headers.get('x-real-ip') || ''
  const cfConnecting = req.headers.get('cf-connecting-ip') || ''

  // Prefer Cloudflare header (set by infrastructure, harder to spoof),
  // then x-real-ip (typically set by reverse proxy), then x-forwarded-for.
  const primaryIp = cfConnecting || realIp || forwardedFor

  if (primaryIp) {
    return primaryIp
  }

  // Fallback: hash a combination of available request headers to create
  // a per-client bucket instead of sharing a single 'unknown' bucket.
  const fingerprint = [
    req.headers.get('user-agent') || '',
    req.headers.get('accept-language') || '',
    req.headers.get('accept-encoding') || '',
    req.headers.get('accept') || '',
  ].join('|')

  return 'hashed-' + crypto.createHash('sha256').update(fingerprint).digest('hex').slice(0, 16)
}

// Sanitize user input to prevent XSS
export function sanitizeInput(input: string): string {
  if (!input) return ''

  // Run replacements in a loop until the output is stable,
  // so nested payloads like "jajavascript:vascript:" are fully stripped.
  let result = input
  let previous = ''
  const maxIterations = 10
  let iterations = 0

  do {
    previous = result
    result = result
      .replace(/[<>]/g, '') // Remove angle brackets (also prevents </user_input> prompt injection)
      .replace(/javascript:/gi, '') // Remove javascript: protocol
      .replace(/on\w+\s*=/gi, '') // Remove event handlers
      .replace(/user_input/gi, '') // Strip prompt boundary markers
    iterations++
  } while (result !== previous && iterations < maxIterations)

  return result.trim().slice(0, 5000) // Limit length
}

// Magic number signatures for file type validation
const FILE_SIGNATURES: Record<string, number[][]> = {
  'image/jpeg': [[0xFF, 0xD8, 0xFF]],
  'image/png': [[0x89, 0x50, 0x4E, 0x47]],
  'image/webp': [[0x52, 0x49, 0x46, 0x46]], // RIFF header (WebP starts with RIFF....WEBP)
  'image/avif': [], // AVIF uses ftyp box, checked separately
  'image/heic': [], // HEIC uses ftyp box, checked separately
  'image/heif': [], // HEIF uses ftyp box, checked separately
}

// Check if buffer matches ftyp-based formats (AVIF, HEIC, HEIF)
function isFtypFormat(bytes: Uint8Array): boolean {
  // ftyp box: bytes 4-7 should be 'ftyp'
  if (bytes.length < 12) return false
  return bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70
}

// Validate file magic bytes against claimed MIME type
export async function validateFileSignature(file: File): Promise<boolean> {
  const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer())
  if (bytes.length < 4) return false

  const claimed = file.type.toLowerCase()

  // ftyp-based formats (AVIF, HEIC, HEIF)
  if (['image/avif', 'image/heic', 'image/heif'].includes(claimed)) {
    return isFtypFormat(bytes)
  }

  // Audio formats - basic signature checks
  if (claimed.startsWith('audio/')) {
    // OGG: starts with OggS
    if (claimed === 'audio/ogg' && bytes[0] === 0x4F && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53) return true
    // MP3: starts with ID3 or 0xFF 0xFB
    if ((claimed === 'audio/mp3' || claimed === 'audio/mpeg') && ((bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) || (bytes[0] === 0xFF && (bytes[1] & 0xE0) === 0xE0))) return true
    // WAV: RIFF header
    if (claimed === 'audio/wav' && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) return true
    // WebM/MP4: ftyp box or EBML header
    if ((claimed === 'audio/webm' || claimed === 'audio/mp4') && (bytes[0] === 0x1A && bytes[1] === 0x45 && bytes[2] === 0xDF && bytes[3] === 0xA3 || isFtypFormat(bytes))) return true
    // Unknown audio format - reject
    return false
  }

  const signatures = FILE_SIGNATURES[claimed]
  if (!signatures || signatures.length === 0) return true // No signature to check

  return signatures.some(sig =>
    sig.every((byte, i) => bytes[i] === byte)
  )
}

// Validate image file
export function validateImageFile(file: File): { valid: boolean; error?: string } {
  const maxSize = 10 * 1024 * 1024 // 10MB
  const allowedTypes = [
    'image/jpeg',
    'image/jpg',
    'image/png',
    'image/webp',
    'image/avif',
    'image/heic',
    'image/heif',
  ]

  if (file.size > maxSize) {
    return { valid: false, error: 'File size exceeds 10MB limit' }
  }

  const fileType = file.type.toLowerCase()
  if (!allowedTypes.includes(fileType)) {
    return { valid: false, error: 'Invalid file type. Only images are allowed.' }
  }

  return { valid: true }
}

// Validate language parameter
export function validateLanguage(lang: string): string {
  const allowedLanguages = ['English', 'Hindi', 'Tamil', 'Kannada', 'Telugu', 'Bengali', 'Marathi', 'Gujarati', 'Punjabi', 'Malayalam', 'Odia', 'Assamese', 'Urdu']
  const sanitized = sanitizeInput(lang)

  if (allowedLanguages.includes(sanitized)) {
    return sanitized
  }

  return 'English' // Default fallback
}

// Hash phone number for privacy
// Generate random salt at startup if env var not set (unique per process)
const HASH_SALT = process.env.HASH_SALT || crypto.randomBytes(32).toString('hex')

export function hashPhoneNumber(phone: string): string {
  return crypto.createHash('sha256').update(HASH_SALT + phone).digest('hex')
}

// Security headers for API responses
export function getSecurityHeaders() {
  return {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'X-XSS-Protection': '1; mode=block',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
  }
}

// CSRF protection: verify Origin header matches our domain
export function validateOrigin(req: NextRequest): boolean {
  const origin = req.headers.get('origin')
  const referer = req.headers.get('referer')

  // Webhook endpoints (WhatsApp, Telegram) don't send Origin headers
  // Allow requests with no Origin (same-origin requests in some browsers)
  if (!origin && !referer) return true

  const host = req.headers.get('host') || ''
  const allowedOrigins = [
    `https://${host}`,
    `http://${host}`, // Allow in dev
    'http://localhost:3000',
    'https://localhost:3000',
  ]

  if (origin && allowedOrigins.some(allowed => origin === allowed)) return true
  if (referer && allowedOrigins.some(allowed => referer.startsWith(allowed))) return true

  return false
}

// Validate and sanitize ingredient name
export function validateIngredientName(name: string): { valid: boolean; sanitized: string; error?: string } {
  const sanitized = sanitizeInput(name)

  if (!sanitized || sanitized.length < 2) {
    return { valid: false, sanitized: '', error: 'Ingredient name too short' }
  }

  if (sanitized.length > 200) {
    return { valid: false, sanitized: '', error: 'Ingredient name too long' }
  }

  // Block control characters (except normal whitespace)
  const controlCharPattern = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/
  if (controlCharPattern.test(sanitized)) {
    return { valid: false, sanitized: '', error: 'Invalid control characters in ingredient name' }
  }

  // Block SQL injection patterns
  const sqlInjectionPattern = /(';\s*--|;\s*DROP\s|;\s*DELETE\s|;\s*INSERT\s|;\s*UPDATE\s|UNION\s+SELECT|OR\s+1\s*=\s*1)/i
  if (sqlInjectionPattern.test(sanitized)) {
    return { valid: false, sanitized: '', error: 'Invalid characters in ingredient name' }
  }

  return { valid: true, sanitized }
}

// Validate product data from Gemini
export function validateProductData(data: any): { valid: boolean; error?: string } {
  if (!data || typeof data !== 'object') {
    return { valid: false, error: 'Invalid product data format' }
  }

  if (!data.product_name || typeof data.product_name !== 'string') {
    return { valid: false, error: 'Missing or invalid product name' }
  }

  if (!data.category || !['food', 'cosmetic', 'household', 'pharma'].includes(data.category)) {
    return { valid: false, error: 'Invalid category' }
  }

  if (!Array.isArray(data.ingredients)) {
    return { valid: false, error: 'Invalid ingredients array' }
  }

  if (data.ingredients.length === 0) {
    return { valid: false, error: 'No ingredients found' }
  }

  if (data.ingredients.length > 100) {
    return { valid: false, error: 'Too many ingredients (max 100)' }
  }

  for (let i = 0; i < data.ingredients.length; i++) {
    const ingredient = data.ingredients[i]
    if (!ingredient || typeof ingredient !== 'object' || typeof ingredient.name !== 'string' || ingredient.name.trim().length === 0) {
      return { valid: false, error: `Ingredient at index ${i} is missing a valid name property` }
    }
  }

  return { valid: true }
}
