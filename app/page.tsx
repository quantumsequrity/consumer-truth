'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import FileUpload from '@/components/FileUpload'
import AnalysisResult from '@/components/AnalysisResult'
import LiveStats from '@/components/LiveStats'
import TrendingWidget from '@/components/TrendingWidget'
import ComparisonView from '@/components/ComparisonView'
import { PhotoPreviewEdit, type PreviewPayload } from '@/components/PhotoPreviewEdit'
import {
    Languages, HelpCircle, X, Shield, Heart, Type,
    ArrowLeft, AlertCircle, Mic, MicOff, Camera, Loader2,
    ChevronRight, GitCompareArrows
} from 'lucide-react'
import { AllergenSettings } from '@/components/AllergenSettings'
import { loadAllergenProfile } from '@/lib/allergens'

/* ========================================
   Processing State Component
   ======================================== */

function ProcessingState({ language: _language, mode }: { language: string; mode: 'image' | 'text' | 'voice' | 'compare' }) {
    // Real elapsed time instead of a fake ticking step list. Honesty beats
    // animation theatre — and the previous step list cycled through stages
    // that don't actually correspond to the request lifecycle.
    const [elapsed, setElapsed] = useState(0)
    useEffect(() => {
        const interval = setInterval(() => setElapsed(e => e + 1), 1000)
        return () => clearInterval(interval)
    }, [])

    const headline =
        mode === 'image'   ? 'Reading the label and cross-checking each ingredient'
        : mode === 'voice' ? 'Transcribing and answering your question'
        : mode === 'compare' ? 'Comparing the two products against the safety databases'
        :                    'Analysing your ingredients against the safety databases'

    // Honest expected-duration message — the API typically returns in 10–30s.
    const hint =
        elapsed < 8 ? 'This usually takes 10–30 seconds.'
        : elapsed < 20 ? "Still working — long ingredient lists can take a bit."
        : elapsed < 40 ? "Taking longer than usual. Hang tight."
        :               "If this keeps spinning, you can refresh and try again."

    return (
        <div className="w-full max-w-md mx-auto mt-16 animate-fade-in">
            <div className="flex flex-col items-center gap-4">
                <Loader2 size={28} className="text-green-500 animate-spin" />
                <p className="text-sm text-zinc-300 font-medium text-center px-4">
                    {headline}
                </p>
                <p className="text-xs text-zinc-500">{hint}</p>
                <p className="text-[10px] text-zinc-700 tabular-nums">{elapsed}s</p>
                <p className="text-xs text-zinc-600 text-center max-w-xs">
                    Cross-referencing FDA, EU CosIng, WHO/IARC, FSSAI/BIS, EFSA, and EPA.
                </p>
            </div>
        </div>
    )
}

/* ========================================
   Voice Recorder Component
   ======================================== */

function VoiceRecorder({ onRecordComplete, isAnalyzing, language: _language }: {
    onRecordComplete: (audioBlob: Blob) => void
    isAnalyzing: boolean
    language: string
}) {
    const [isRecording, setIsRecording] = useState(false)
    const [recordingTime, setRecordingTime] = useState(0)
    const [micError, setMicError] = useState<string | null>(null)
    const mediaRecorderRef = useRef<MediaRecorder | null>(null)
    const chunksRef = useRef<Blob[]>([])
    const timerRef = useRef<NodeJS.Timeout | null>(null)

    const startRecording = useCallback(async () => {
        setMicError(null)
        try {
            if (!navigator.mediaDevices?.getUserMedia) {
                setMicError('Your browser does not support microphone access. Try Chrome or Safari.')
                return
            }
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true })

            // Pick a MIME type the current browser actually supports.
            // iOS / desktop Safari do NOT support audio/webm — they fall back
            // to audio/mp4 (AAC). Chrome/Firefox prefer webm/opus.
            // The server validates the final MIME via magic bytes, so this
            // just has to produce a format the platform can encode.
            const candidates = [
                'audio/webm;codecs=opus',
                'audio/webm',
                'audio/mp4',
                'audio/mp4;codecs=mp4a.40.2', // AAC-LC
                'audio/ogg;codecs=opus',
            ]
            let chosenMime = ''
            for (const c of candidates) {
                // Some older browsers don't expose isTypeSupported at all;
                // fall through to default if so.
                if (typeof MediaRecorder.isTypeSupported === 'function' && MediaRecorder.isTypeSupported(c)) {
                    chosenMime = c
                    break
                }
            }

            const mediaRecorder = chosenMime
                ? new MediaRecorder(stream, { mimeType: chosenMime })
                : new MediaRecorder(stream)
            mediaRecorderRef.current = mediaRecorder
            chunksRef.current = []

            mediaRecorder.ondataavailable = (e) => {
                if (e.data.size > 0) chunksRef.current.push(e.data)
            }

            mediaRecorder.onstop = () => {
                // Strip codec params from the MIME so the server's MIME
                // allowlist matches ("audio/webm" not "audio/webm;codecs=opus").
                const recorderMime = (mediaRecorder.mimeType || chosenMime || 'audio/webm').split(';')[0].trim()
                const blob = new Blob(chunksRef.current, { type: recorderMime })
                onRecordComplete(blob)
                stream.getTracks().forEach(track => track.stop())
            }

            mediaRecorder.start()
            setIsRecording(true)
            setRecordingTime(0)

            timerRef.current = setInterval(() => {
                setRecordingTime(prev => {
                    // Auto-stop at 5 minutes to prevent unbounded recording
                    if (prev + 1 >= 300) {
                        mediaRecorderRef.current?.stop()
                        setIsRecording(false)
                        if (timerRef.current) clearInterval(timerRef.current)
                    }
                    return prev + 1
                })
            }, 1000)
        } catch (err) {
            console.error('Microphone access denied:', err)
            const name = (err as Error)?.name || ''
            if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
                setMicError('Microphone access was denied. Enable it in your browser settings and try again.')
            } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
                setMicError('No microphone found on this device.')
            } else if (name === 'NotReadableError') {
                setMicError('The microphone is in use by another app. Close it and try again.')
            } else {
                setMicError('Could not start the microphone. Please try again.')
            }
        }
    }, [onRecordComplete])

    const stopRecording = useCallback(() => {
        if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
            mediaRecorderRef.current.stop()
            setIsRecording(false)
            if (timerRef.current) clearInterval(timerRef.current)
        }
    }, [])

    const formatTime = (seconds: number) => {
        const m = Math.floor(seconds / 60)
        const s = seconds % 60
        return `${m}:${s.toString().padStart(2, '0')}`
    }

    return (
        <div className="py-10 px-6 flex flex-col items-center gap-5">
            <button
                onClick={isRecording ? stopRecording : startRecording}
                disabled={isAnalyzing}
                className={`w-16 h-16 rounded-full flex items-center justify-center transition-all active:scale-95 disabled:opacity-50 ${
                    isRecording
                        ? 'bg-red-500 hover:bg-red-600'
                        : 'bg-green-600 hover:bg-green-700'
                }`}
            >
                {isRecording ? <MicOff size={24} className="text-white" /> : <Mic size={24} className="text-white" />}
            </button>

            <div className="text-center">
                <p className="text-sm font-medium text-zinc-200">
                    {isRecording
                        ? ('Recording...')
                        : ('Ask by Voice')
                    }
                </p>
                {isRecording ? (
                    <p className="text-red-400 font-mono text-sm mt-1">{formatTime(recordingTime)}</p>
                ) : (
                    <p className="text-xs text-zinc-500 mt-1 max-w-xs">
                        {'Tap the mic and speak the ingredients or ask about a product'
                        }
                    </p>
                )}
            </div>

            {isRecording && (
                <button
                    onClick={stopRecording}
                    className="px-5 py-2.5 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm font-medium hover:bg-red-500/20 transition active:scale-95"
                >
                    {'Stop & Analyze'}
                </button>
            )}

            {micError && (
                <div className="w-full max-w-xs flex items-start gap-2 text-xs text-red-400 bg-red-500/5 border border-red-500/15 rounded-lg p-2.5 mt-1">
                    <AlertCircle size={14} className="flex-shrink-0 mt-0.5" />
                    <span>{micError}</span>
                </div>
            )}
        </div>
    )
}

/* ========================================
   Tutorial Modal
   ======================================== */

function TutorialModal({ language: _language, onClose }: { language: string; onClose: () => void }) {
    const [step, setStep] = useState(0)

    const steps = [
        {
            title: 'Welcome!',
            description: 'Alzhal tells you exactly what is in your food, cosmetics, and household products - and whether it is safe, grounded in real regulators (FDA, EU, WHO, FSSAI, IARC).',
            icon: Shield,
        },
        {
            title: 'Three Ways to Check',
            description: 'Upload a photo of the label, paste ingredient text, or use voice input. All three methods work instantly.',
            icon: Camera,
        },
        {
            title: 'Understand Your Report',
            description: 'Green means safe, yellow means caution, red means avoid. Every ingredient gets a detailed breakdown with official sources.',
            icon: Heart,
        }
    ]

    return (
        <div className="fixed inset-0 z-[100] bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 animate-fade-in">
            <div className="relative bg-zinc-900 border border-zinc-800 rounded-xl p-8 max-w-md w-full animate-fade-in">
                <button
                    onClick={onClose}
                    className="absolute top-4 right-4 p-1.5 rounded-md text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 transition"
                >
                    <X size={16} />
                </button>

                <div className="space-y-5">
                    <div className="w-10 h-10 rounded-lg bg-zinc-800 flex items-center justify-center">
                        {(() => {
                            const Icon = steps[step].icon
                            return <Icon className="w-5 h-5 text-green-500" />
                        })()}
                    </div>

                    <h2 className="text-xl font-semibold text-white">{steps[step].title}</h2>

                    <p className="text-sm text-zinc-400 leading-relaxed">{steps[step].description}</p>

                    <div className="flex gap-1.5 pt-1">
                        {steps.map((_, idx) => (
                            <div
                                key={idx}
                                className={`h-1 rounded-full transition-all duration-300 ${
                                    idx === step ? 'bg-green-500 w-5' : idx < step ? 'bg-zinc-600 w-3' : 'bg-zinc-800 w-3'
                                }`}
                            />
                        ))}
                    </div>

                    <div className="flex gap-3 pt-1">
                        {step < steps.length - 1 ? (
                            <>
                                <button
                                    onClick={onClose}
                                    className="flex-1 px-4 py-2.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 transition text-sm text-zinc-400 hover:text-zinc-200"
                                >
                                    {'Skip'}
                                </button>
                                <button
                                    onClick={() => setStep(step + 1)}
                                    className="flex-1 px-4 py-2.5 rounded-lg bg-white text-zinc-900 font-medium text-sm hover:bg-zinc-100 transition flex items-center justify-center gap-1 active:scale-[0.98]"
                                >
                                    {'Next'}
                                    <ChevronRight size={14} />
                                </button>
                            </>
                        ) : (
                            <button
                                onClick={onClose}
                                className="w-full px-4 py-2.5 rounded-lg bg-white text-zinc-900 font-medium text-sm hover:bg-zinc-100 transition active:scale-[0.98]"
                            >
                                {'Get Started'}
                            </button>
                        )}
                    </div>
                </div>
            </div>
        </div>
    )
}

/* ========================================
   Main Page
   ======================================== */

/**
 * Turn a raw error into something a user can act on. The server already
 * returns user-friendly messages for known failure modes; this helper just
 * normalises network-layer errors that bypass the server (offline, fetch
 * abort, parse errors).
 */
function humanizeError(err: unknown): string {
    const msg = err instanceof Error ? err.message : String(err || '')
    if (!msg) return 'Something went wrong. Please try again.'
    if (/Failed to fetch|NetworkError|offline/i.test(msg)) {
        return 'Network error — check your connection and tap Retry.'
    }
    if (/timed out|timeout/i.test(msg)) {
        return 'The request took too long. Tap Retry.'
    }
    if (/429|rate limit|Too many/i.test(msg)) {
        return 'Service is busy right now. Wait a moment, then tap Retry.'
    }
    return msg
}

export default function Home() {
    const [isAnalyzing, setIsAnalyzing] = useState(false)
    const [analysisData, setAnalysisData] = useState<any>(null)
    const [voiceResponse, setVoiceResponse] = useState<any>(null)
    const [error, setError] = useState<string | null>(null)
    const [language, setLanguage] = useState('English')
    const [showTutorial, setShowTutorial] = useState(false)
    const [inputMode, setInputMode] = useState<'image' | 'text' | 'voice' | 'compare'>('image')
    const [textInput, setTextInput] = useState('')
    const [textMode, setTextMode] = useState<'auto' | 'product' | 'ingredients'>('auto')
    const [compareA, setCompareA] = useState('')
    const [compareB, setCompareB] = useState('')
    const [comparisonData, setComparisonData] = useState<any>(null)
    // Last action stored as a function so the error UI can offer a one-tap
    // retry without the user re-entering anything.
    const [lastAction, setLastAction] = useState<(() => void) | null>(null)
    // Soft "no result" state — server says "we couldn't ID this, try a photo".
    const [noResult, setNoResult] = useState<{ query: string; message: string } | null>(null)
    // OCR preview waiting for the user to edit + confirm before we run the
    // full analysis. See PhotoPreviewEdit + /api/preview/image.
    const [photoPreview, setPhotoPreview] = useState<PreviewPayload | null>(null)
    const [showAllergenSettings, setShowAllergenSettings] = useState(false)
    // Count of currently-selected allergens, refreshed when the modal closes.
    const [allergenCount, setAllergenCount] = useState(0)
    useEffect(() => {
        setAllergenCount(loadAllergenProfile().length)
    }, [showAllergenSettings])
    // Recent scan history (last 5), persisted to localStorage.
    const [recentScans, setRecentScans] = useState<Array<{
        productName: string
        brand?: string
        score: number
        scoreLabel: string
        scannedAt: number
    }>>([])


    useEffect(() => {
        const hasVisited = localStorage.getItem('ct_visited')
        if (!hasVisited) {
            setShowTutorial(true)
            localStorage.setItem('ct_visited', 'true')
        }

        // Restore textarea draft so an accidental refresh doesn't wipe the user's input.
        try {
            const draft = localStorage.getItem('ct_text_draft')
            if (draft && draft.length <= 5000) setTextInput(draft)
        } catch {
            // localStorage can throw in private-mode Safari; non-blocking.
        }

        // Load recent-scan history.
        try {
            const raw = localStorage.getItem('ct_recent_scans')
            if (raw) {
                const parsed = JSON.parse(raw)
                if (Array.isArray(parsed)) setRecentScans(parsed.slice(0, 5))
            }
        } catch {
            // Ignore corrupted data.
        }
    }, [])

    // Persist textarea draft while typing — debounced via a microtask so it
    // doesn't write on every keystroke synchronously.
    useEffect(() => {
        try {
            if (textInput) localStorage.setItem('ct_text_draft', textInput)
            else localStorage.removeItem('ct_text_draft')
        } catch {
            // localStorage may be unavailable; skip silently.
        }
    }, [textInput])

    // Record a scan in the history (called from analyzeData effect below).
    const recordScan = useCallback((data: any) => {
        if (!data?.product?.product_name) return
        try {
            const ingredients = Array.isArray(data.ingredients) ? data.ingredients : []
            const total = ingredients.length || 1
            const safe = ingredients.filter((i: any) => (i.analysis?.category || '').toUpperCase() === 'SAFE').length
            const warning = ingredients.filter((i: any) => (i.analysis?.category || '').toUpperCase() === 'CAUTION').length
            const score = Math.round(((safe + warning * 0.5) / total) * 100)
            const scoreLabel = score >= 70 ? 'Safe' : score >= 40 ? 'Caution' : 'Danger'

            const entry = {
                productName: data.product.product_name,
                brand: data.product.brand,
                score,
                scoreLabel,
                scannedAt: Date.now(),
            }

            setRecentScans(prev => {
                const filtered = prev.filter(s => s.productName !== entry.productName)
                const next = [entry, ...filtered].slice(0, 5)
                try { localStorage.setItem('ct_recent_scans', JSON.stringify(next)) } catch {}
                return next
            })
        } catch {
            // Failure here is purely cosmetic; never blocks the user flow.
        }
    }, [])

    // Whenever a new analysis lands, push it into history.
    useEffect(() => {
        if (analysisData) recordScan(analysisData)
    }, [analysisData, recordScan])

    // Global keyboard shortcuts. Single window listener instead of N hidden
    // <button accessKey=…> elements: works on focused inputs, doesn't conflict
    // with native browser chord (Ctrl+Enter is "send", Esc is "cancel").
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPod|iPad/.test(navigator.platform)
            const cmdEnter = (isMac ? e.metaKey : e.ctrlKey) && e.key === 'Enter'

            if (cmdEnter && !isAnalyzing) {
                if (inputMode === 'text' && textInput.trim()) {
                    e.preventDefault()
                    handleTextAnalysis()
                } else if (inputMode === 'compare' && compareA.trim() && compareB.trim()) {
                    e.preventDefault()
                    handleComparison()
                }
                return
            }

            if (e.key === 'Escape') {
                // Esc returns to the landing input from any result view.
                if (analysisData || voiceResponse || comparisonData) {
                    e.preventDefault()
                    resetAnalysis()
                } else if (showTutorial) {
                    e.preventDefault()
                    setShowTutorial(false)
                }
                return
            }

            // "?" — opens the tutorial as quick help. Skip if user is typing.
            if (e.key === '?' && !showTutorial) {
                const target = e.target as HTMLElement | null
                const isTyping = target && (
                    target.tagName === 'INPUT' ||
                    target.tagName === 'TEXTAREA' ||
                    target.isContentEditable
                )
                if (!isTyping) {
                    e.preventDefault()
                    setShowTutorial(true)
                }
            }
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
        // We intentionally read state through closures here rather than via
        // exhaustive deps — re-binding the listener on every keystroke would
        // be wasteful.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [inputMode, textInput, compareA, compareB, isAnalyzing, analysisData, voiceResponse, comparisonData, showTutorial])

    const handleFileSelect = async (file: File, ocrText: string = '') => {
        setIsAnalyzing(true)
        setError(null)
        setAnalysisData(null)
        setPhotoPreview(null)
        // Stash the retry. The function captures `file` and `ocrText` so the
        // user doesn't have to re-pick the photo on a transient failure.
        setLastAction(() => () => handleFileSelect(file, ocrText))

        const formData = new FormData()
        formData.append('image', file)
        if (ocrText) {
            formData.append('ocrText', ocrText)
        }

        try {
            // Step 1: OCR only. Returns a list of extracted ingredients which
            // the user can edit before we run the full (expensive) analysis.
            const previewResp = await fetch('/api/preview/image', {
                method: 'POST',
                body: formData,
            })
            const previewData = await previewResp.json()

            if (!previewResp.ok) {
                throw new Error(previewData.error || 'OCR failed')
            }

            if (!Array.isArray(previewData.ingredients) || previewData.ingredients.length === 0) {
                throw new Error("Couldn't find any ingredients in this photo. Try a clearer shot of the back-of-pack ingredient list.")
            }

            setPhotoPreview(previewData as PreviewPayload)
        } catch (err: any) {
            console.error(err)
            setError(humanizeError(err))
        } finally {
            setIsAnalyzing(false)
        }
    }

    /**
     * Called by PhotoPreviewEdit after the user confirms the edited list.
     * Forwards to /api/analyze/text with mode='ingredients' so the analysis
     * pipeline gets the user-curated list, not the raw OCR.
     */
    const handlePreviewAnalyze = async (edited: { productName: string; ingredients: string[] }) => {
        setIsAnalyzing(true)
        setError(null)
        setAnalysisData(null)
        setLastAction(() => () => handlePreviewAnalyze(edited))

        try {
            // Comma-join the chips into the format /api/analyze/text expects.
            const text = edited.ingredients.join(', ')

            const response = await fetch('/api/analyze/text', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    text,
                    language,
                    mode: 'ingredients',
                }),
            })

            const data = await response.json()
            if (!response.ok) throw new Error(data.error || 'Analysis failed')

            // Inject the user-confirmed product name so the result card shows
            // it instead of the placeholder "Text Analysis".
            if (data.product) {
                data.product.product_name = edited.productName || data.product.product_name
            }
            setAnalysisData(data)
            setPhotoPreview(null)
        } catch (err: any) {
            console.error(err)
            setError(humanizeError(err))
        } finally {
            setIsAnalyzing(false)
        }
    }

    const handleTextAnalysis = async () => {
        if (!textInput.trim() || textInput.trim().length < 3) {
            setError('Please enter at least one ingredient name.')
            return
        }

        setIsAnalyzing(true)
        setError(null)
        setAnalysisData(null)
        setNoResult(null)
        setLastAction(() => () => handleTextAnalysis())

        try {
            const response = await fetch('/api/analyze/text', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    text: textInput,
                    language,
                    mode: textMode,
                }),
            })

            const data = await response.json()

            if (!response.ok) {
                throw new Error(data.error || 'Analysis failed')
            }

            // Soft "couldn't ID this product" path. We get a 200 with a
            // needsPhoto flag instead of an error, so the user lands on a
            // friendly empty state with a one-tap photo upload instead of a
            // red error banner.
            if (data.needsPhoto) {
                setNoResult({ query: data.query || textInput, message: data.message })
                return
            }

            setAnalysisData(data)
        } catch (err: any) {
            console.error(err)
            setError(humanizeError(err))
        } finally {
            setIsAnalyzing(false)
        }
    }

    const handleVoiceComplete = async (audioBlob: Blob) => {
        setIsAnalyzing(true)
        setError(null)
        setAnalysisData(null)
        setVoiceResponse(null)
        setLastAction(() => () => handleVoiceComplete(audioBlob))

        // File extension matches the actual blob MIME (Safari produces mp4,
        // Chrome produces webm). The server validates by magic bytes anyway.
        const ext = (audioBlob.type || '').includes('mp4') ? 'm4a'
            : (audioBlob.type || '').includes('ogg') ? 'ogg'
            : 'webm'

        const formData = new FormData()
        formData.append('audio', audioBlob, `voice.${ext}`)
        formData.append('language', language)

        try {
            const response = await fetch('/api/analyze/voice', {
                method: 'POST',
                body: formData,
            })

            const data = await response.json()

            if (!response.ok) {
                throw new Error(data.error || 'Voice analysis failed')
            }

            // Voice API returns { transcription, language, intent, response } - not ingredients
            setVoiceResponse(data)
        } catch (err: any) {
            console.error(err)
            setError(humanizeError(err))
        } finally {
            setIsAnalyzing(false)
        }
    }

    const handleComparison = async () => {
        if (!compareA.trim() || !compareB.trim()) {
            setError('Please enter both product names.')
            return
        }

        setIsAnalyzing(true)
        setError(null)
        setComparisonData(null)
        setLastAction(() => () => handleComparison())

        try {
            const response = await fetch('/api/compare', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    product_a: compareA,
                    product_b: compareB,
                    language,
                }),
            })

            const data = await response.json()

            if (!response.ok) {
                throw new Error(data.error || 'Comparison failed')
            }

            setComparisonData(data)
        } catch (err: any) {
            console.error(err)
            setError(humanizeError(err))
        } finally {
            setIsAnalyzing(false)
        }
    }

    const resetAnalysis = () => {
        setAnalysisData(null)
        setVoiceResponse(null)
        setComparisonData(null)
        setError(null)
        setNoResult(null)
        setPhotoPreview(null)
        setTextInput('')
        setCompareA('')
        setCompareB('')
    }

    const labels = {
        heroTitle: 'Know What You',
        heroHighlight: 'Consume.',
        heroSubtitle: 'Instant AI safety analysis against FDA, EU, WHO & BIS/FSSAI standards.',
        uploadTab: 'Photo',
        textTab: 'Text',
        voiceTab: 'Voice',
        compareTab: 'Compare',
        textPlaceholder: 'Type a product name or paste ingredients...\nExample: Maaza, Coca-Cola, or Sodium Laureth Sulfate, Parabens',
        analyzeBtn: 'Analyze',
        scanAnother: 'Scan Another Product',
        disclaimer: 'Educational information only, not medical advice. Consult professionals for health concerns.',
    }

    return (
        <main className="min-h-screen bg-[#09090b] text-white">

            {/* Tutorial Modal */}
            {showTutorial && (
                <TutorialModal language={language} onClose={() => setShowTutorial(false)} />
            )}

            {/* Allergen profile settings */}
            {showAllergenSettings && (
                <AllergenSettings onClose={() => setShowAllergenSettings(false)} />
            )}

            {/* ====== NAVBAR ====== */}
            <nav className="sticky top-0 z-50 w-full bg-[#09090b]/80 backdrop-blur-md border-b border-zinc-800/50">
                <div className="max-w-3xl mx-auto px-4 py-3 flex justify-between items-center">
                    <span className="font-display text-base tracking-tight text-[var(--text-primary)]" style={{ fontWeight: 500 }}>
                        Alzhal
                    </span>

                    <div className="flex items-center gap-2">
                        <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-zinc-900 border border-zinc-800 hover:border-zinc-700 transition">
                            <Languages size={13} className="text-zinc-500" aria-hidden />
                            <select
                                value={language}
                                onChange={(e) => setLanguage(e.target.value)}
                                aria-label="Choose response language"
                                className="bg-transparent outline-none text-zinc-300 text-xs cursor-pointer focus-visible:ring-2 focus-visible:ring-green-500/50 rounded"
                            >
                                <option value="Tamil">தமிழ்</option>
                                <option value="English">English</option>
                                <option value="Telugu">తెలుగు</option>
                                <option value="Kannada">ಕನ್ನಡ</option>
                                <option value="Malayalam">മലയാളം</option>
                                <option value="Hindi">हिंदी</option>
                                <option value="Bengali">বাংলা</option>
                                <option value="Marathi">मराठी</option>
                                <option value="Gujarati">ગુજરાતી</option>
                                <option value="Punjabi">ਪੰਜਾਬੀ</option>
                                <option value="Odia">ଓଡ଼ିଆ</option>
                                <option value="Assamese">অসমীয়া</option>
                                <option value="Urdu">اردو</option>
                            </select>
                        </div>

                        <button
                            onClick={() => setShowAllergenSettings(true)}
                            className="p-1.5 rounded-md text-zinc-600 hover:text-zinc-300 hover:bg-zinc-800 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-green-500/50 relative"
                            title={allergenCount > 0 ? `Allergen profile (${allergenCount} active)` : 'Allergen profile'}
                            aria-label={allergenCount > 0 ? `Open allergen profile, ${allergenCount} active` : 'Open allergen profile'}
                        >
                            <Heart size={15} aria-hidden />
                            {allergenCount > 0 && (
                                <span
                                    className="absolute -top-0.5 -right-0.5 min-w-[14px] h-[14px] px-1 rounded-full bg-amber-500 text-[9px] font-bold text-zinc-900 flex items-center justify-center"
                                    aria-hidden
                                >
                                    {allergenCount}
                                </span>
                            )}
                        </button>
                        <button
                            onClick={() => { setShowTutorial(true) }}
                            className="p-1.5 rounded-md text-zinc-600 hover:text-zinc-300 hover:bg-zinc-800 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-green-500/50"
                            title="Help and tutorial (press ?)"
                            aria-label="Open the help tutorial"
                        >
                            <HelpCircle size={15} aria-hidden />
                        </button>
                    </div>
                </div>
            </nav>

            {/* ====== MAIN CONTENT ====== */}
            <div className="max-w-xl mx-auto px-4 sm:px-6 pt-12 sm:pt-16 md:pt-24 pb-20">

                {/* ====== HERO + INPUT ====== */}
                {!analysisData && !voiceResponse && !comparisonData && !isAnalyzing && !photoPreview && (
                    <div className="animate-fade-in">

                        {/* Hero */}
                        <div className="text-center mb-10">
                            <h1 className="text-4xl sm:text-5xl font-bold tracking-tight mb-3">
                                {labels.heroTitle}{' '}
                                <span className="text-green-500">{labels.heroHighlight}</span>
                            </h1>
                            <p className="text-sm text-zinc-500 max-w-md mx-auto">
                                {labels.heroSubtitle}
                            </p>
                        </div>

                        {/* Tab Switcher */}
                        <div className="flex gap-1 p-1 bg-zinc-900 border border-zinc-800 rounded-lg mb-6">
                            {[
                                { key: 'image' as const, label: labels.uploadTab, icon: Camera },
                                { key: 'text' as const, label: labels.textTab, icon: Type },
                                { key: 'voice' as const, label: labels.voiceTab, icon: Mic },
                                { key: 'compare' as const, label: labels.compareTab, icon: GitCompareArrows },
                            ].map(tab => (
                                <button
                                    key={tab.key}
                                    onClick={() => { setInputMode(tab.key); setError(null); setNoResult(null) }}
                                    className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-md text-sm font-medium transition-all ${
                                        inputMode === tab.key
                                            ? 'bg-zinc-800 text-white'
                                            : 'text-zinc-500 hover:text-zinc-300'
                                    }`}
                                >
                                    <tab.icon size={14} />
                                    {tab.label}
                                </button>
                            ))}
                        </div>

                        {/* Input Area */}
                        <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
                            {inputMode === 'image' && (
                                <FileUpload onFileSelect={handleFileSelect} isUploading={isAnalyzing} language={language} />
                            )}

                            {inputMode === 'text' && (
                                <div className="p-4 space-y-3">
                                    {/* Mode selector: tell the server explicitly what kind of
                                        input this is, instead of relying on guessing. */}
                                    <div className="flex gap-1 p-0.5 bg-zinc-950 border border-zinc-800 rounded-md text-xs">
                                        {[
                                            { key: 'auto' as const,        label: 'Auto-detect' },
                                            { key: 'product' as const,     label: 'Product name' },
                                            { key: 'ingredients' as const, label: 'Ingredients list' },
                                        ].map(m => (
                                            <button
                                                key={m.key}
                                                onClick={() => setTextMode(m.key)}
                                                className={`flex-1 py-1.5 rounded transition ${
                                                    textMode === m.key
                                                        ? 'bg-zinc-800 text-white'
                                                        : 'text-zinc-500 hover:text-zinc-300'
                                                }`}
                                                disabled={isAnalyzing}
                                            >
                                                {m.label}
                                            </button>
                                        ))}
                                    </div>

                                    <textarea
                                        value={textInput}
                                        onChange={(e) => setTextInput(e.target.value)}
                                        placeholder={
                                            textMode === 'product'
                                                ? 'Type a product name. Example: Maggi noodles, Coca-Cola, Dove soap'
                                                : textMode === 'ingredients'
                                                    ? 'Paste an ingredients list, comma-separated.\nExample: Water, Sugar, Sodium Benzoate, Citric Acid'
                                                    : labels.textPlaceholder
                                        }
                                        className="w-full h-36 p-3 rounded-md bg-zinc-950 border border-zinc-800 focus:border-zinc-600 focus:outline-none text-sm text-white placeholder-zinc-600 resize-none transition"
                                        disabled={isAnalyzing}
                                        maxLength={5000}
                                    />

                                    {/* Quick-pick examples — clicking fills the textarea so the user
                                        can edit them, instead of submitting blind. */}
                                    {!textInput && (
                                        <div className="flex flex-wrap gap-1.5">
                                            <span className="text-[11px] text-zinc-600 self-center mr-1">Try:</span>
                                            {(textMode === 'ingredients'
                                                ? ['Aspartame, Phenylalanine', 'Sodium Benzoate, Citric Acid', 'Parabens, SLS, Tartrazine']
                                                : ['Maggi noodles', 'Coca-Cola', 'Dove soap', 'Lays chips']
                                            ).map(ex => (
                                                <button
                                                    key={ex}
                                                    onClick={() => setTextInput(ex)}
                                                    className="px-2 py-1 text-[11px] rounded bg-zinc-900 border border-zinc-800 text-zinc-400 hover:text-zinc-200 hover:border-zinc-600 transition"
                                                    disabled={isAnalyzing}
                                                >
                                                    {ex}
                                                </button>
                                            ))}
                                        </div>
                                    )}

                                    <div className="flex items-center justify-between text-xs text-zinc-600 px-0.5">
                                        <span>{textInput.length}/5000</span>
                                        <span>
                                            {textMode === 'ingredients'
                                                ? 'Separate with commas'
                                                : textMode === 'product'
                                                    ? 'Up to ~5 words for best results'
                                                    : 'Auto: short input → product, comma list → ingredients'}
                                        </span>
                                    </div>
                                    <button
                                        onClick={handleTextAnalysis}
                                        disabled={isAnalyzing || !textInput.trim()}
                                        className="w-full py-2.5 rounded-md bg-green-600 hover:bg-green-700 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium transition active:scale-[0.98] flex items-center justify-center gap-2"
                                    >
                                        {labels.analyzeBtn}
                                        <kbd className="hidden sm:inline-block text-[10px] font-mono opacity-70 px-1.5 py-0.5 rounded bg-black/30 border border-white/10">⌘/Ctrl ↵</kbd>
                                    </button>
                                </div>
                            )}

                            {inputMode === 'voice' && (
                                <VoiceRecorder
                                    onRecordComplete={handleVoiceComplete}
                                    isAnalyzing={isAnalyzing}
                                    language={language}
                                />
                            )}

                            {inputMode === 'compare' && (
                                <div className="p-4 space-y-3">
                                    <input
                                        type="text"
                                        value={compareA}
                                        onChange={(e) => setCompareA(e.target.value)}
                                        placeholder={'First product (e.g., Maggi Noodles)'}
                                        className="w-full p-3 rounded-md bg-zinc-950 border border-zinc-800 focus:border-zinc-600 focus:outline-none text-sm text-white placeholder-zinc-600 transition"
                                        disabled={isAnalyzing}
                                        maxLength={200}
                                    />
                                    <div className="text-center text-xs text-zinc-600 font-medium">
                                        {'VS'}
                                    </div>
                                    <input
                                        type="text"
                                        value={compareB}
                                        onChange={(e) => setCompareB(e.target.value)}
                                        placeholder={'Second product (e.g., Yippee Noodles)'}
                                        className="w-full p-3 rounded-md bg-zinc-950 border border-zinc-800 focus:border-zinc-600 focus:outline-none text-sm text-white placeholder-zinc-600 transition"
                                        disabled={isAnalyzing}
                                        maxLength={200}
                                    />
                                    <button
                                        onClick={handleComparison}
                                        disabled={isAnalyzing || !compareA.trim() || !compareB.trim()}
                                        className="w-full py-2.5 rounded-md bg-green-600 hover:bg-green-700 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium transition active:scale-[0.98] flex items-center justify-center gap-2"
                                    >
                                        {'Compare Products'}
                                        <kbd className="hidden sm:inline-block text-[10px] font-mono opacity-70 px-1.5 py-0.5 rounded bg-black/30 border border-white/10">⌘/Ctrl ↵</kbd>
                                    </button>
                                </div>
                            )}
                        </div>

                        {/* Soft "no result" state — friendlier than a red error */}
                        {noResult && (
                            <div role="status" className="mt-4 flex items-start gap-3 text-sm bg-blue-500/[0.04] border border-blue-500/15 rounded-lg p-4 animate-fade-in">
                                <Camera size={18} className="flex-shrink-0 mt-0.5 text-blue-300" aria-hidden />
                                <div className="flex-1 min-w-0">
                                    <p className="font-medium text-blue-200 mb-1">
                                        Couldn&apos;t identify &ldquo;{noResult.query}&rdquo;
                                    </p>
                                    <p className="text-xs text-blue-200/80 leading-relaxed mb-3">
                                        {noResult.message}
                                    </p>
                                    <div className="flex flex-wrap gap-2">
                                        <button
                                            onClick={() => {
                                                setNoResult(null)
                                                setInputMode('image')
                                            }}
                                            className="px-3 py-1.5 rounded-md bg-blue-500/15 hover:bg-blue-500/25 border border-blue-500/30 text-xs font-medium text-blue-200 transition active:scale-95 flex items-center gap-1.5"
                                        >
                                            <Camera size={12} />
                                            Take a photo instead
                                        </button>
                                        <button
                                            onClick={() => {
                                                setNoResult(null)
                                                setTextMode('ingredients')
                                            }}
                                            className="px-3 py-1.5 rounded-md bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-xs font-medium text-zinc-300 transition active:scale-95"
                                        >
                                            I&apos;ll paste ingredients instead
                                        </button>
                                    </div>
                                </div>
                            </div>
                        )}

                        {/* Error with optional one-tap retry */}
                        {error && (
                            <div role="alert" className="mt-4 flex items-start gap-2 text-sm text-red-400 bg-red-500/[0.04] border border-red-500/15 rounded-lg p-3 animate-fade-in">
                                <AlertCircle size={16} className="flex-shrink-0 mt-0.5" aria-hidden />
                                <div className="flex-1 min-w-0">
                                    <p className="leading-relaxed">{error}</p>
                                    {lastAction && (
                                        <button
                                            onClick={() => {
                                                setError(null)
                                                lastAction()
                                            }}
                                            className="mt-2 px-3 py-1.5 rounded-md bg-red-500/10 hover:bg-red-500/20 border border-red-500/20 text-xs font-medium text-red-300 transition active:scale-95"
                                        >
                                            Retry
                                        </button>
                                    )}
                                </div>
                            </div>
                        )}

                        {/* Recent scans (local to this device only) */}
                        {recentScans.length > 0 && (
                            <div className="mt-6">
                                <div className="flex items-center justify-between mb-2 px-0.5">
                                    <p className="text-[11px] uppercase tracking-wider text-zinc-600 font-medium">Recent on this device</p>
                                    <button
                                        onClick={() => {
                                            setRecentScans([])
                                            try { localStorage.removeItem('ct_recent_scans') } catch {}
                                        }}
                                        className="text-[11px] text-zinc-600 hover:text-zinc-400 transition"
                                    >
                                        Clear
                                    </button>
                                </div>
                                <div className="flex flex-wrap gap-1.5">
                                    {recentScans.map((s) => {
                                        const tone =
                                            s.scoreLabel === 'Safe' ? 'border-green-500/20 text-green-300/90'
                                            : s.scoreLabel === 'Caution' ? 'border-yellow-500/20 text-yellow-300/90'
                                            : 'border-red-500/20 text-red-300/90'
                                        return (
                                            <button
                                                key={s.productName + s.scannedAt}
                                                onClick={() => {
                                                    setInputMode('text')
                                                    setTextMode('product')
                                                    setTextInput(s.productName)
                                                }}
                                                className={`px-2.5 py-1 rounded-md text-xs bg-zinc-900 border ${tone} hover:bg-zinc-800 transition`}
                                                title={`Re-scan ${s.productName} (last score: ${s.score}/100)`}
                                            >
                                                {s.productName}
                                                <span className="text-zinc-600 ml-1.5 tabular-nums">{s.score}</span>
                                            </button>
                                        )
                                    })}
                                </div>
                            </div>
                        )}

                        {/* Stats */}
                        <div className="mt-8">
                            <LiveStats language={language} />
                        </div>

                        {/* Trending */}
                        <div className="mt-6">
                            <TrendingWidget language={language} />
                        </div>
                    </div>
                )}

                {/* ====== PHOTO PREVIEW + EDIT ====== */}
                {/* Shown after OCR but before analysis. User can fix mistakes.
                    The key forces a clean remount when a new preview arrives,
                    so internal edit state resets without a useEffect. */}
                {photoPreview && !analysisData && !isAnalyzing && (
                    <PhotoPreviewEdit
                        key={`${photoPreview.product_name}-${photoPreview.ingredients.length}-${photoPreview.primarySource}`}
                        preview={photoPreview}
                        isAnalyzing={isAnalyzing}
                        onBack={() => {
                            setPhotoPreview(null)
                            setError(null)
                        }}
                        onAnalyze={handlePreviewAnalyze}
                    />
                )}

                {/* ====== PROCESSING STATE ====== */}
                {isAnalyzing && !analysisData && !voiceResponse && !comparisonData && (
                    <ProcessingState language={language} mode={inputMode} />
                )}

                {/* ====== VOICE RESPONSE ====== */}
                {voiceResponse && (
                    <div className="animate-fade-in">
                        <button
                            onClick={resetAnalysis}
                            className="mb-6 flex items-center gap-1.5 text-sm text-zinc-500 hover:text-zinc-300 transition group focus:outline-none focus-visible:ring-2 focus-visible:ring-green-500/50 rounded px-1"
                            aria-label="Go back and scan another product (press Esc)"
                        >
                            <ArrowLeft size={14} className="group-hover:-translate-x-0.5 transition-transform" aria-hidden />
                            {labels.scanAnother}
                        </button>

                        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-5 space-y-4">
                            {voiceResponse.transcription && (
                                <div>
                                    <p className="text-xs text-zinc-500 mb-1">{'You said'}</p>
                                    <p className="text-sm text-zinc-300 italic">&ldquo;{voiceResponse.transcription}&rdquo;</p>
                                </div>
                            )}
                            <div>
                                <p className="text-xs text-zinc-500 mb-1">{'Response'}</p>
                                <p className="text-sm text-zinc-200 leading-relaxed whitespace-pre-wrap">{voiceResponse.response}</p>
                            </div>
                            {voiceResponse.language && voiceResponse.language !== 'English' && (
                                <p className="text-xs text-zinc-600">{'Language'}: {voiceResponse.language}</p>
                            )}
                        </div>
                    </div>
                )}

                {/* ====== COMPARISON RESULT ====== */}
                {comparisonData && (
                    <div className="animate-fade-in">
                        <button
                            onClick={resetAnalysis}
                            className="mb-6 flex items-center gap-1.5 text-sm text-zinc-500 hover:text-zinc-300 transition group focus:outline-none focus-visible:ring-2 focus-visible:ring-green-500/50 rounded px-1"
                            aria-label="Go back and scan another product (press Esc)"
                        >
                            <ArrowLeft size={14} className="group-hover:-translate-x-0.5 transition-transform" aria-hidden />
                            {labels.scanAnother}
                        </button>

                        <ComparisonView data={comparisonData} language={language} />
                    </div>
                )}

                {/* ====== ANALYSIS RESULT ====== */}
                {analysisData && (
                    <div className="animate-fade-in">
                        <button
                            onClick={resetAnalysis}
                            className="mb-6 flex items-center gap-1.5 text-sm text-zinc-500 hover:text-zinc-300 transition group focus:outline-none focus-visible:ring-2 focus-visible:ring-green-500/50 rounded px-1"
                            aria-label="Go back and scan another product (press Esc)"
                        >
                            <ArrowLeft size={14} className="group-hover:-translate-x-0.5 transition-transform" aria-hidden />
                            {labels.scanAnother}
                        </button>

                        <AnalysisResult data={analysisData} language={language} />
                    </div>
                )}
            </div>

            {/* ====== FOOTER ====== */}
            <footer className="border-t border-zinc-800/50 py-5 px-4">
                <p className="text-center text-xs text-zinc-600 max-w-lg mx-auto">
                    {labels.disclaimer}
                </p>
            </footer>
        </main>
    )
}
