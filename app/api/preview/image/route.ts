import { NextRequest, NextResponse } from 'next/server'
import { analyzeImage } from '@/lib/gemini'
import { extractWithWorkersAI } from '@/lib/workers-ai-ocr'
import { mergeOcrResults } from '@/lib/ocr-merge'
import {
    rateLimit,
    getClientIdentifier,
    validateImageFile,
    validateFileSignature,
    validateOrigin,
    getSecurityHeaders,
} from '@/lib/security'

/**
 * POST /api/preview/image
 *
 * Runs the multi-source OCR pipeline ONLY. Does not call any analysis,
 * does not write to D1, does not hit external regulatory APIs. The point
 * is to give the user a chance to edit the extracted ingredient list
 * before paying the cost (latency + LLM calls + DB writes) of a full
 * analysis run.
 *
 * Returned `ingredients` are strings ready to feed into /api/analyze/text
 * with mode='ingredients'.
 *
 * Same auth (CSRF + rate limit + magic-byte file validation) as the full
 * /api/analyze/image route. Lower maxDuration because the work is bounded
 * to OCR.
 */

export const maxDuration = 30

const limiter = rateLimit({ windowMs: 60000, maxRequests: 10 })

export async function POST(req: NextRequest) {
    try {
        if (!validateOrigin(req)) {
            return NextResponse.json({ error: 'Forbidden' }, { status: 403, headers: getSecurityHeaders() })
        }

        const clientId = getClientIdentifier(req)
        const { allowed } = limiter(clientId)
        if (!allowed) {
            return NextResponse.json(
                { error: 'Too many requests. Please wait a moment.' },
                { status: 429, headers: getSecurityHeaders() }
            )
        }

        const formData = await req.formData()
        const file = formData.get('image')
        const rawOcrText = formData.get('ocrText')
        const clientOcrText =
            typeof rawOcrText === 'string'
                ? rawOcrText.slice(0, 10000).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, '')
                : ''

        if (!file || !(file instanceof File)) {
            return NextResponse.json({ error: 'No image provided' }, { status: 400, headers: getSecurityHeaders() })
        }

        const validation = validateImageFile(file)
        if (!validation.valid) {
            return NextResponse.json({ error: validation.error }, { status: 400, headers: getSecurityHeaders() })
        }

        const signatureValid = await validateFileSignature(file)
        if (!signatureValid) {
            return NextResponse.json(
                { error: 'File content does not match its declared type. Please upload a valid image.' },
                { status: 400, headers: getSecurityHeaders() }
            )
        }

        const buffer = Buffer.from(await file.arrayBuffer()) as Buffer
        let mimeType = file.type
        if (mimeType === 'application/octet-stream' || !mimeType) {
            const fileName = file.name.toLowerCase()
            if (fileName.endsWith('.jpg') || fileName.endsWith('.jpeg')) mimeType = 'image/jpeg'
            else if (fileName.endsWith('.png')) mimeType = 'image/png'
            else if (fileName.endsWith('.webp')) mimeType = 'image/webp'
            else if (fileName.endsWith('.avif')) mimeType = 'image/avif'
            else if (fileName.endsWith('.heic')) mimeType = 'image/heic'
            else if (fileName.endsWith('.heif')) mimeType = 'image/heif'
            else mimeType = 'image/jpeg'
        }

        // Multi-source OCR in parallel. Workers AI fails open (returns null)
        // when its binding is missing, so this still works in local dev.
        const [geminiResult, workersAIResult] = await Promise.allSettled([
            analyzeImage(buffer, mimeType),
            extractWithWorkersAI(buffer, mimeType),
        ])

        const geminiData = geminiResult.status === 'fulfilled' ? geminiResult.value : null
        const workersAIData = workersAIResult.status === 'fulfilled' ? workersAIResult.value : null

        try {
            const merged = mergeOcrResults({
                gemini: geminiData,
                workersAI: workersAIData,
                tesseractRaw: clientOcrText,
            })
            return NextResponse.json(
                {
                    product_name: merged.product_name,
                    brand: merged.brand,
                    category: merged.category,
                    ingredients: merged.ingredients.map(i => i.name),
                    ocrSources: merged.ocrSources,
                    primarySource: merged.primarySource,
                },
                { headers: getSecurityHeaders() }
            )
        } catch (err) {
            console.error('[PreviewImage] merge failed:', err)
            return NextResponse.json(
                { error: "Couldn't read any ingredients from the photo. Try a clearer image of the ingredients list." },
                { status: 422, headers: getSecurityHeaders() }
            )
        }
    } catch (error: any) {
        console.error('[PreviewImage] failed:', error)
        return NextResponse.json(
            { error: 'Preview failed. Please try again.' },
            { status: 500, headers: getSecurityHeaders() }
        )
    }
}
