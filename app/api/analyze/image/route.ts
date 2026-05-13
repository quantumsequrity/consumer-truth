import { NextRequest, NextResponse } from 'next/server'
import { processImageAndAnalyze } from '@/lib/analysis'
import { getFullProductDataByName } from '@/lib/product-data'
import { execute, generateId } from '@/lib/db'
import { rateLimit, getClientIdentifier, validateImageFile, validateFileSignature, validateLanguage, validateOrigin, getSecurityHeaders, signScanId } from '@/lib/security'

export const maxDuration = 60

const limiter = rateLimit({ windowMs: 60000, maxRequests: 5 })

export async function POST(req: NextRequest) {
    try {
        // CSRF protection
        if (!validateOrigin(req)) {
            return NextResponse.json({ error: 'Forbidden' }, { status: 403, headers: getSecurityHeaders() })
        }

        // Rate limiting
        const clientId = getClientIdentifier(req)
        const { allowed } = limiter(clientId)
        if (!allowed) {
            return NextResponse.json(
                { error: 'Too many requests. Please wait a moment before scanning again.' },
                { status: 429, headers: getSecurityHeaders() }
            )
        }

        const formData = await req.formData()
        const file = formData.get('image')
        const rawLang = formData.get('language')
        const language = validateLanguage(typeof rawLang === 'string' ? rawLang : 'English')

        // Client-side Tesseract OCR text (optional, max 10,000 chars)
        const rawOcrText = formData.get('ocrText')
        const clientOcrText = typeof rawOcrText === 'string'
            ? rawOcrText.slice(0, 10000).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, '')
            : ''

        if (!file || !(file instanceof File)) {
            return NextResponse.json({ error: 'No image provided' }, { status: 400, headers: getSecurityHeaders() })
        }

        // Validate file type and size
        const validation = validateImageFile(file)
        if (!validation.valid) {
            return NextResponse.json({ error: validation.error }, { status: 400, headers: getSecurityHeaders() })
        }

        // Validate file signature (magic bytes) to prevent spoofed MIME types
        const signatureValid = await validateFileSignature(file)
        if (!signatureValid) {
            return NextResponse.json(
                { error: 'File content does not match its declared type. Please upload a valid image.' },
                { status: 400, headers: getSecurityHeaders() }
            )
        }

        const buffer: Buffer = Buffer.from(await file.arrayBuffer()) as Buffer
        let mimeType = file.type

        // Detect MIME type from extension if browser sends generic type
        if (mimeType === 'application/octet-stream' || !mimeType) {
            const fileName = file.name.toLowerCase()
            if (fileName.endsWith('.jpg') || fileName.endsWith('.jpeg')) mimeType = 'image/jpeg'
            else if (fileName.endsWith('.png')) mimeType = 'image/png'
            else if (fileName.endsWith('.webp')) mimeType = 'image/webp'
            else if (fileName.endsWith('.avif')) mimeType = 'image/avif'
            else if (fileName.endsWith('.heic')) mimeType = 'image/heic'
            else if (fileName.endsWith('.heif')) mimeType = 'image/heif'

            // Default to jpeg if still unknown
            if (mimeType === 'application/octet-stream') {
                mimeType = 'image/jpeg'
            }
        }

        // Validate final MIME type - pass all supported formats to Gemini directly
        if (!['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/heic', 'image/heif'].includes(mimeType)) {
            return NextResponse.json(
                { error: 'Unsupported image format. Please use JPEG, PNG, WebP, AVIF, or HEIC.' },
                { status: 400, headers: getSecurityHeaders() }
            )
        }

        // Process and analyze (pass client OCR text for multi-source merge)
        const result = await processImageAndAnalyze(buffer, mimeType, language, clientOcrText)

        // Fetch nutrition data (non-blocking)
        let nutrition = null
        try {
            const productName = result.productData?.product_name
            if (productName) {
                const fullData = await getFullProductDataByName(productName)
                if (fullData?.nutrition) {
                    nutrition = {
                        ...fullData.nutrition,
                        nutriscore_grade: fullData.product?.nutriscore_grade || null,
                        nova_group: fullData.product?.nova_group || null,
                    }
                }
            }
        } catch (e) {
            console.warn('[ImageAnalysis] Nutrition fetch failed (non-blocking):', e)
        }

        // Log scan (non-blocking)
        let scanId: string | undefined
        try {
            scanId = generateId()
            await execute(
                `INSERT INTO scans (id, product_id, input_type, language, ingredients_found, response_sent) VALUES (?, ?, ?, ?, ?, 1)`,
                [scanId, result.productId || null, 'web_upload', language, JSON.stringify(result.ingredients.map((i: any) => i.name))]
            )
        } catch (e) {
            console.error('Failed to log scan:', e)
            scanId = undefined
        }

        // Mint an HMAC-signed token so the client can prove ownership of this
        // scan on subsequent /api/question calls (load conversation history,
        // append messages). Without it the question route still answers but
        // refuses to read or write conversation history for this scan.
        const scanToken = scanId ? signScanId(scanId) : undefined

        return NextResponse.json({
            product: result.productData,
            ingredients: result.ingredients,
            scanId,
            scanToken,
            scannedCount: result.scannedCount,
            ocrSources: result.ocrSources,
            nutrition,
        }, { headers: getSecurityHeaders() })
    } catch (error: any) {
        console.error('Analysis failed:', error)

        // Return user-friendly error messages
        let userMessage = 'Analysis failed. Please try again.'
        if (error.message?.includes('429')) {
            userMessage = 'Service is busy. Please wait a moment and try again.'
        } else if (error.message?.includes('parse')) {
            userMessage = 'Could not read the product label clearly. Please try a clearer photo.'
        } else if (error.message?.includes('API')) {
            userMessage = 'External service temporarily unavailable. Please try again shortly.'
        }

        return NextResponse.json({ error: userMessage }, { status: 500, headers: getSecurityHeaders() })
    }
}
