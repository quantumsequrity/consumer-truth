'use client'

import { useState, useEffect, useMemo, useRef } from 'react'
import {
    CheckCircle2, AlertTriangle, XCircle, ChevronDown, Share2,
    ShieldCheck, ShieldAlert, Info, ExternalLink, BookOpen,
    Copy, MessageCircle, Send, Loader2, Beaker, Pill,
    UtensilsCrossed, SprayCan, Droplets, FlaskConical, Ban,
    ThumbsUp, ThumbsDown, Eye, TrendingUp, Camera, Search,
    Download
} from 'lucide-react'
import { WhatThisMeans, LearnMoreLinks } from './IngredientGuidance'
import { useToast } from './Toast'
import { matchAllergens, loadAllergenProfile, type AllergenMatch } from '@/lib/allergens'

// Map the internal 3-state verdict (+ banned list) to the broader 5-state
// guidance verdict used by WhatThisMeans, so a banned ingredient always shows
// the strongest message even if its analysis.category is just "danger".
function toGuidanceVerdict(
    verdict: 'safe' | 'warning' | 'danger',
    bannedList: string[],
): 'safe' | 'caution' | 'danger' | 'banned' | 'unknown' {
    if (bannedList.length > 0) return 'banned'
    if (verdict === 'safe') return 'safe'
    if (verdict === 'warning') return 'caution'
    return 'danger'
}

/* ========================================
   Types
   ======================================== */

interface Ingredient {
    name: string
    percentage?: string
    analysis: {
        simple_name: string
        chemical_formula?: string
        cas_number?: string
        raw_materials?: string
        common_uses?: string[]
        fda_status?: string
        eu_status?: string
        who_status?: string
        banned_in?: string[]
        banned_countries?: string[]
        safe_limit?: string
        concerns?: string[]
        category?: string
        translated_text?: string
        regulatory_status?: {
            india_bis?: string
            india_fssai?: string
            eu_cosing?: string
            us_fda?: string
            us_epa?: string
            who_iarc?: string
        }
        safety_limits?: {
            fssai_max?: string
            eu_max?: string
            fda_max?: string
        }
        sources_cited?: string[]
        epa_link?: string
        // v2-grounded fields - present when the grounded pipeline served this ingredient
        _grounded?: boolean
        _per_jurisdiction?: Array<{
            jurisdiction: string
            status: string
            regulation_ref: string | null
            source_url: string
            source_name: string
        }>
        _citations?: Array<{
            fact_type: string
            jurisdiction: string
            source_name: string
            source_url: string
            snapshot_date: string
        }>
        limit_exceeded?: {
            fssai?: { max_allowed?: string; typical_use?: string; exceeded?: boolean }
            eu?: { max_allowed?: string; typical_use?: string; exceeded?: boolean }
            fda?: { max_allowed?: string; typical_use?: string; exceeded?: boolean }
        }
        regional_ban_conflicts?: string[]
    }
}

interface AnalysisResultProps {
    data: {
        product: {
            product_name: string
            brand: string
            category: string
            ingredients: any[]
        }
        ingredients: Ingredient[]
        scanId?: string
        scanToken?: string
        scannedCount?: number
        isProductNameLookup?: boolean
        nutrition?: any
    }
    language?: string
}

/* ========================================
   Score Gauge Component
   ======================================== */

function ScoreGauge({ score, size = 120 }: { score: number; size?: number }) {
    const [animatedScore, setAnimatedScore] = useState(0)
    const radius = (size - 16) / 2
    const circumference = 2 * Math.PI * radius
    const center = size / 2

    useEffect(() => {
        const timer = setTimeout(() => setAnimatedScore(score), 100)
        return () => clearTimeout(timer)
    }, [score])

    const offset = circumference - (circumference * animatedScore) / 100

    let strokeColor = '#22c55e'
    let glowColor = 'rgba(34, 197, 94, 0.3)'
    let label = 'Safe'
    if (score < 70) { strokeColor = '#eab308'; glowColor = 'rgba(234, 179, 8, 0.3)'; label = 'Caution' }
    if (score < 40) { strokeColor = '#ef4444'; glowColor = 'rgba(239, 68, 68, 0.3)'; label = 'Danger' }

    return (
        <div className="relative flex items-center justify-center" style={{ width: size, height: size }}>
            <svg width={size} height={size} className="transform -rotate-90">
                {/* Background ring */}
                <circle
                    cx={center}
                    cy={center}
                    r={radius}
                    stroke="rgba(255,255,255,0.06)"
                    strokeWidth="8"
                    fill="transparent"
                />
                {/* Score ring */}
                <circle
                    cx={center}
                    cy={center}
                    r={radius}
                    stroke={strokeColor}
                    strokeWidth="8"
                    fill="transparent"
                    strokeDasharray={circumference}
                    strokeDashoffset={offset}
                    strokeLinecap="round"
                    className="score-gauge-ring"
                    style={{
                        filter: `drop-shadow(0 0 6px ${glowColor})`,
                    }}
                />
            </svg>
            <div className="absolute flex flex-col items-center">
                <span className="text-3xl md:text-4xl font-bold tabular-nums" style={{ color: strokeColor }}>
                    {animatedScore}
                </span>
                <span className="text-[10px] uppercase tracking-widest font-semibold mt-0.5" style={{ color: strokeColor }}>
                    {label}
                </span>
            </div>
        </div>
    )
}

/* ========================================
   Category Badge
   ======================================== */

function CategoryBadge({ category }: { category: string }) {
    const cat = (category || 'product').toLowerCase()

    const config: Record<string, { icon: any; label: string; color: string }> = {
        food: { icon: UtensilsCrossed, label: 'Food', color: 'text-orange-400 bg-orange-500/10 border-orange-500/20' },
        cosmetic: { icon: SprayCan, label: 'Cosmetic', color: 'text-pink-400 bg-pink-500/10 border-pink-500/20' },
        cosmetics: { icon: SprayCan, label: 'Cosmetics', color: 'text-pink-400 bg-pink-500/10 border-pink-500/20' },
        shampoo: { icon: Droplets, label: 'Shampoo', color: 'text-cyan-400 bg-cyan-500/10 border-cyan-500/20' },
        soap: { icon: Droplets, label: 'Soap', color: 'text-sky-400 bg-sky-500/10 border-sky-500/20' },
        household: { icon: FlaskConical, label: 'Household', color: 'text-amber-400 bg-amber-500/10 border-amber-500/20' },
        pharma: { icon: Pill, label: 'Pharma', color: 'text-violet-400 bg-violet-500/10 border-violet-500/20' },
        pharmaceutical: { icon: Pill, label: 'Pharma', color: 'text-violet-400 bg-violet-500/10 border-violet-500/20' },
    }

    const cfg = config[cat] || { icon: Beaker, label: category || 'Product', color: 'text-gray-400 bg-white/5 border-white/10' }
    const Icon = cfg.icon

    return (
        <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full border text-xs font-semibold uppercase tracking-wider ${cfg.color}`}>
            <Icon size={12} />
            {cfg.label}
        </span>
    )
}

/* ========================================
   Nutrition Card
   ======================================== */

// Thresholds per 100g (UK/EU traffic light system)
const HIGH_THRESHOLDS: Record<string, { amber: number; red: number }> = {
    fat: { amber: 3, red: 17.5 },
    saturated_fat: { amber: 1.5, red: 5 },
    sugars: { amber: 5, red: 22.5 },
    salt: { amber: 0.3, red: 1.5 },
}
const GOOD_THRESHOLDS: Record<string, number> = {
    proteins: 5,
    fiber: 3,
}

function getNutrientColor(key: string, value: number): string {
    const high = HIGH_THRESHOLDS[key]
    if (high) {
        if (value >= high.red) return 'text-red-400'
        if (value >= high.amber) return 'text-yellow-400'
        return 'text-green-400'
    }
    const good = GOOD_THRESHOLDS[key]
    if (good) {
        return value >= good ? 'text-green-400' : 'text-gray-400'
    }
    return 'text-gray-300'
}

function getNutrientBg(key: string, value: number): string {
    const high = HIGH_THRESHOLDS[key]
    if (high) {
        if (value >= high.red) return 'bg-red-500/8 border-red-500/15'
        if (value >= high.amber) return 'bg-yellow-500/8 border-yellow-500/15'
        return 'bg-green-500/8 border-green-500/15'
    }
    const good = GOOD_THRESHOLDS[key]
    if (good) {
        return value >= good ? 'bg-green-500/8 border-green-500/15' : 'bg-white/[0.03] border-white/5'
    }
    return 'bg-white/[0.03] border-white/5'
}

function NutritionCard({ nutrition }: { nutrition: any }) {
    const nutriscoreGrade = (nutrition.nutriscore_grade || '').toUpperCase()
    const novaGroup = nutrition.nova_group ? String(nutrition.nova_group) : null

    const nutrients: { key: string; label: string; unit: string; field: string }[] = [
        { key: 'energy', label: 'Energy', unit: 'kcal', field: 'energy_kcal_100g' },
        { key: 'fat', label: 'Total Fat', unit: 'g', field: 'fat_100g' },
        { key: 'saturated_fat', label: 'Saturated Fat', unit: 'g', field: 'saturated_fat_100g' },
        { key: 'sugars', label: 'Sugars', unit: 'g', field: 'sugars_100g' },
        { key: 'proteins', label: 'Protein', unit: 'g', field: 'proteins_100g' },
        { key: 'salt', label: 'Salt', unit: 'g', field: 'salt_100g' },
        { key: 'fiber', label: 'Fiber', unit: 'g', field: 'fiber_100g' },
        { key: 'carbohydrates', label: 'Carbohydrates', unit: 'g', field: 'carbohydrates_100g' },
    ]

    // Filter to only show nutrients that have data
    const available = nutrients.filter(n => {
        const val = parseFloat(nutrition[n.field])
        return !isNaN(val) && val >= 0
    })

    if (available.length === 0 && !nutriscoreGrade && !novaGroup) return null

    // Vitamins & minerals
    const vitamins: { label: string; field: string }[] = [
        { label: 'Vitamin A', field: 'vitamin_a_100g' },
        { label: 'Vitamin C', field: 'vitamin_c_100g' },
        { label: 'Vitamin D', field: 'vitamin_d_100g' },
        { label: 'Vitamin B12', field: 'vitamin_b12_100g' },
        { label: 'Calcium', field: 'calcium_100g' },
        { label: 'Iron', field: 'iron_100g' },
        { label: 'Potassium', field: 'potassium_100g' },
        { label: 'Zinc', field: 'zinc_100g' },
    ]
    const availableVitamins = vitamins.filter(v => {
        const val = parseFloat(nutrition[v.field])
        return !isNaN(val) && val > 0
    })

    const nutriscoreColors: Record<string, string> = {
        A: 'bg-green-600 text-white',
        B: 'bg-lime-500 text-black',
        C: 'bg-yellow-500 text-black',
        D: 'bg-orange-500 text-white',
        E: 'bg-red-600 text-white',
    }

    const novaLabels: Record<string, string> = {
        '1': 'Unprocessed',
        '2': 'Processed ingredients',
        '3': 'Processed food',
        '4': 'Ultra-processed',
    }

    return (
        <div className="glass-card rounded-2xl overflow-hidden animate-fade-in-up">
            <div className="p-5 sm:p-6">
                <div className="flex items-center justify-between mb-4">
                    <h3 className="text-base font-semibold text-white flex items-center gap-2">
                        <UtensilsCrossed size={18} className="text-orange-400 flex-shrink-0" />
                        {'Nutrition Facts'}
                        <span className="text-[10px] text-gray-600 font-normal uppercase">{'per 100g'}</span>
                    </h3>

                    {/* Nutri-Score + NOVA badges */}
                    <div className="flex items-center gap-2">
                        {nutriscoreGrade && nutriscoreColors[nutriscoreGrade] && (
                            <span className={`px-2.5 py-1 rounded-lg text-xs font-bold ${nutriscoreColors[nutriscoreGrade]}`}>
                                Nutri-Score {nutriscoreGrade}
                            </span>
                        )}
                        {novaGroup && novaLabels[novaGroup] && (
                            <span className={`px-2.5 py-1 rounded-lg text-xs font-bold border ${
                                novaGroup === '4' ? 'bg-red-500/15 border-red-500/25 text-red-400' :
                                novaGroup === '3' ? 'bg-yellow-500/15 border-yellow-500/25 text-yellow-400' :
                                'bg-green-500/15 border-green-500/25 text-green-400'
                            }`}>
                                NOVA {novaGroup}
                            </span>
                        )}
                    </div>
                </div>

                {/* Nutrient grid */}
                {available.length > 0 && (
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4">
                        {available.map(n => {
                            const val = parseFloat(nutrition[n.field])
                            return (
                                <div key={n.key} className={`p-3 rounded-xl border transition-all ${getNutrientBg(n.key, val)}`}>
                                    <p className="text-[10px] text-gray-500 uppercase tracking-wider font-bold mb-1">{n.label}</p>
                                    <p className={`text-lg font-bold tabular-nums ${getNutrientColor(n.key, val)}`}>
                                        {val % 1 === 0 ? val : val.toFixed(1)}
                                        <span className="text-xs font-normal text-gray-600 ml-0.5">{n.unit}</span>
                                    </p>
                                </div>
                            )
                        })}
                    </div>
                )}

                {/* Vitamins & minerals row */}
                {availableVitamins.length > 0 && (
                    <div>
                        <p className="text-[10px] text-gray-600 uppercase tracking-wider font-bold mb-2">
                            {'Vitamins & Minerals'}
                        </p>
                        <div className="flex flex-wrap gap-1.5">
                            {availableVitamins.map(v => {
                                const val = parseFloat(nutrition[v.field])
                                return (
                                    <span key={v.field} className="px-2 py-1 text-xs rounded-lg bg-white/[0.04] border border-white/8 text-gray-400">
                                        {v.label}: <span className="text-white font-medium">{val % 1 === 0 ? val : val.toFixed(2)}</span>
                                    </span>
                                )
                            })}
                        </div>
                    </div>
                )}

                {/* NOVA explanation */}
                {novaGroup && novaLabels[novaGroup] && (
                    <p className="text-[10px] text-gray-600 mt-3">
                        NOVA {novaGroup}: {novaLabels[novaGroup]}
                        {novaGroup === '4' && (' - may contain many processed additives')}
                    </p>
                )}
            </div>
        </div>
    )
}

/* ========================================
   Regulatory Status Card
   ======================================== */

function StatusCard({ flag, label, value }: { flag: string; label: string; value: string }) {
    const lower = value.toLowerCase()
    const isDanger = lower.includes('prohibit') || lower.includes('banned') || lower.includes('annex ii') || lower.includes('not permitted')
    const isWarning = lower.includes('restrict') || lower.includes('annex iii') || lower.includes('caution') || lower.includes('limited')

    const flagEmoji: Record<string, string> = {
        'IN': 'IN',
        'EU': 'EU',
        'US': 'US',
        'WHO': 'WHO',
    }

    return (
        <div className={`p-3 rounded-xl border transition-all duration-300 hover:scale-[1.02] ${
            isDanger ? 'bg-red-500/8 border-red-500/20 hover:bg-red-500/12' :
            isWarning ? 'bg-yellow-500/8 border-yellow-500/20 hover:bg-yellow-500/12' :
            'bg-white/[0.03] border-white/5 hover:bg-white/[0.06]'
        }`}>
            <div className="flex items-center gap-2 mb-1.5">
                <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
                    isDanger ? 'bg-red-500/20 text-red-400' :
                    isWarning ? 'bg-yellow-500/20 text-yellow-400' :
                    'bg-white/5 text-gray-500'
                }`}>{flagEmoji[flag] || flag}</span>
                <span className="text-xs font-semibold text-gray-400">{label}</span>
            </div>
            <p className={`text-sm leading-snug ${
                isDanger ? 'text-red-400 font-semibold' :
                isWarning ? 'text-yellow-400 font-medium' :
                'text-gray-300'
            }`}>
                {value}
            </p>
        </div>
    )
}

/* ========================================
   Per-Ingredient Feedback
   ======================================== */

function IngredientFeedback({ scanId, ingredientName, language }: { scanId: string; ingredientName: string; language: string }) {
    const [submitted, setSubmitted] = useState<'up' | 'down' | null>(null)
    const { toast } = useToast()

    const handleFeedback = async (rating: 'up' | 'down') => {
        try {
            const res = await fetch('/api/feedback', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ scan_id: scanId, rating, ingredient_name: ingredientName }),
            })
            if (res.ok) {
                setSubmitted(rating)
                toast({
                    kind: 'success',
                    message: rating === 'up' ? `Thanks — marked “${ingredientName}” as correct` : `Flagged “${ingredientName}” for review`,
                })
            }
        } catch { /* Non-blocking */ }
    }

    if (submitted) {
        return (
            <span className="text-[10px] text-gray-600">
                {submitted === 'down' ? ('Flagged') : ('Thanks')}
            </span>
        )
    }

    return (
        <div className="flex items-center gap-1">
            <span className="text-[10px] text-gray-600 mr-1">{'Accurate?'}</span>
            <button
                onClick={(e) => { e.stopPropagation(); handleFeedback('up') }}
                className="p-1 rounded hover:bg-green-500/10 text-gray-600 hover:text-green-400 transition"
                title="Correct"
            >
                <ThumbsUp size={12} />
            </button>
            <button
                onClick={(e) => { e.stopPropagation(); handleFeedback('down') }}
                className="p-1 rounded hover:bg-red-500/10 text-gray-600 hover:text-red-400 transition"
                title="Wrong verdict"
            >
                <ThumbsDown size={12} />
            </button>
        </div>
    )
}

/* ========================================
   Feedback Buttons
   ======================================== */

function FeedbackButtons({ scanId, language }: { scanId: string; language: string }) {
    const [submitted, setSubmitted] = useState<'up' | 'down' | null>(null)
    const [showComment, setShowComment] = useState(false)
    const [comment, setComment] = useState('')
    const { toast } = useToast()

    const handleFeedback = async (rating: 'up' | 'down') => {
        setSubmitted(rating)
        if (rating === 'down') {
            setShowComment(true)
        }
        try {
            await fetch('/api/feedback', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ scan_id: scanId, rating }),
            })
            if (rating === 'up') {
                toast({ kind: 'success', message: 'Thanks for the feedback!' })
            }
        } catch {
            // Non-blocking
        }
    }

    const handleCommentSubmit = async () => {
        if (!comment.trim()) return
        setShowComment(false)
        try {
            await fetch('/api/feedback', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ scan_id: scanId, rating: 'down', comment }),
            })
            toast({ kind: 'success', message: 'Feedback saved — thank you' })
        } catch {
            // Non-blocking
        }
    }

    return (
        <div className="flex flex-col items-center gap-3 py-2">
            <p className="text-xs text-gray-500">
                {'Was this report helpful?'}
            </p>
            <div className="flex gap-2">
                <button
                    onClick={() => handleFeedback('up')}
                    disabled={submitted !== null}
                    className={`flex items-center gap-1.5 px-4 py-2 rounded-xl border text-sm font-medium transition-all active:scale-95 min-h-[40px] ${
                        submitted === 'up'
                            ? 'bg-green-500/15 border-green-500/30 text-green-400'
                            : submitted !== null
                                ? 'opacity-30 cursor-not-allowed bg-white/[0.03] border-white/5 text-gray-500'
                                : 'bg-white/[0.03] border-white/5 text-gray-400 hover:bg-green-500/10 hover:border-green-500/20 hover:text-green-400'
                    }`}
                >
                    <ThumbsUp size={14} />
                    {'Yes'}
                </button>
                <button
                    onClick={() => handleFeedback('down')}
                    disabled={submitted !== null}
                    className={`flex items-center gap-1.5 px-4 py-2 rounded-xl border text-sm font-medium transition-all active:scale-95 min-h-[40px] ${
                        submitted === 'down'
                            ? 'bg-red-500/15 border-red-500/30 text-red-400'
                            : submitted !== null
                                ? 'opacity-30 cursor-not-allowed bg-white/[0.03] border-white/5 text-gray-500'
                                : 'bg-white/[0.03] border-white/5 text-gray-400 hover:bg-red-500/10 hover:border-red-500/20 hover:text-red-400'
                    }`}
                >
                    <ThumbsDown size={14} />
                    {'No'}
                </button>
            </div>
            {showComment && (
                <div className="flex gap-2 w-full max-w-sm animate-fade-in">
                    <input
                        type="text"
                        value={comment}
                        onChange={(e) => setComment(e.target.value)}
                        placeholder={'What could be better?'}
                        className="flex-1 px-3 py-2 rounded-lg bg-black/30 border border-white/8 text-white text-xs placeholder-gray-600 focus:border-red-500/40 transition-colors"
                        maxLength={500}
                    />
                    <button
                        onClick={handleCommentSubmit}
                        className="px-3 py-2 rounded-lg bg-red-500/15 border border-red-500/20 text-red-400 text-xs hover:bg-red-500/25 transition active:scale-95"
                    >
                        <Send size={12} />
                    </button>
                </div>
            )}
            {submitted && !showComment && (
                <p className="text-xs text-gray-600 animate-fade-in">
                    {'Thanks for your feedback!'}
                </p>
            )}
        </div>
    )
}

/* ========================================
   Share Modal
   ======================================== */

function ShareModal({ text, onClose, language, scanId, productName }: { text: string; onClose: () => void; language: string; scanId?: string; productName: string }) {
    const [copied, setCopied] = useState(false)
    const { toast } = useToast()

    const trackShare = (method: 'whatsapp' | 'copy' | 'native') => {
        if (!scanId) return
        // The /api/share route accepts only 'whatsapp' | 'copy' today. We map
        // 'native' to 'copy' for tracking — server validates the union.
        const tracked = method === 'native' ? 'copy' : method
        fetch('/api/share', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ scan_id: scanId, method: tracked }),
        }).catch(() => {})
    }

    const canUseNativeShare =
        typeof navigator !== 'undefined' &&
        typeof navigator.share === 'function'

    const handleNativeShare = async () => {
        try {
            await navigator.share({
                title: `Alzhal — ${productName}`,
                text,
            })
            trackShare('native')
            // No success toast on native share: the OS already shows feedback,
            // and stacking two confirmations is jarring on iOS.
            onClose()
        } catch (err) {
            // AbortError = user dismissed the share sheet. Silent.
            if ((err as Error)?.name !== 'AbortError') {
                toast({ kind: 'error', message: "Couldn't open the share sheet — copy instead?" })
            }
        }
    }

    const handleCopy = async () => {
        try {
            await navigator.clipboard.writeText(text)
            setCopied(true)
            trackShare('copy')
            toast({ kind: 'success', message: 'Report copied to clipboard' })
            setTimeout(() => setCopied(false), 2000)
        } catch {
            toast({ kind: 'error', message: 'Could not copy — your browser blocked clipboard access' })
        }
    }

    const handleWhatsApp = () => {
        trackShare('whatsapp')
        window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank', 'noopener,noreferrer')
    }

    return (
        <div className="fixed inset-0 z-[100] bg-black/80 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4 animate-fade-in" onClick={onClose} role="dialog" aria-modal="true" aria-labelledby="share-modal-title">
            <div className="glass-card rounded-t-2xl sm:rounded-2xl p-5 sm:p-6 max-w-md w-full space-y-4 animate-fade-in-scale safe-bottom" onClick={e => e.stopPropagation()}>
                {/* Drag handle for mobile */}
                <div className="w-10 h-1 rounded-full bg-white/20 mx-auto sm:hidden" aria-hidden />
                <h3 id="share-modal-title" className="text-lg font-semibold text-white">
                    {'Share Report'}
                </h3>
                <div className="p-3 rounded-xl bg-black/30 border border-white/5 text-sm text-gray-300 whitespace-pre-line max-h-40 overflow-y-auto">
                    {text}
                </div>
                <div className="flex flex-col gap-2">
                    {/* Native share is the primary on mobile (iOS / Android). On
                        desktop it's usually absent — we hide it and fall back
                        to the explicit WhatsApp + Copy buttons. */}
                    {canUseNativeShare && (
                        <button
                            onClick={handleNativeShare}
                            className="flex items-center justify-center gap-2 py-3 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-medium transition active:scale-95 min-h-[48px]"
                            aria-label="Open the system share sheet"
                        >
                            <Share2 size={18} />
                            Share via…
                        </button>
                    )}
                    <div className="flex gap-2">
                        <button
                            onClick={handleWhatsApp}
                            className="flex-1 flex items-center justify-center gap-2 py-3 rounded-xl bg-green-600 hover:bg-green-700 text-white font-medium transition active:scale-95 min-h-[48px]"
                            aria-label="Open WhatsApp share"
                        >
                            <MessageCircle size={18} />
                            WhatsApp
                        </button>
                        <button
                            onClick={handleCopy}
                            className={`flex-1 flex items-center justify-center gap-2 py-3 rounded-xl border transition active:scale-95 font-medium min-h-[48px] ${
                                copied
                                    ? 'bg-green-500/20 border-green-500/30 text-green-400'
                                    : 'bg-white/5 border-white/10 text-gray-300 hover:bg-white/10'
                            }`}
                            aria-label="Copy report to clipboard"
                        >
                            {copied ? <CheckCircle2 size={18} /> : <Copy size={18} />}
                            {copied ? ('Copied!') : ('Copy')}
                        </button>
                    </div>
                </div>
                <button onClick={onClose} className="w-full py-3 text-sm text-gray-500 hover:text-white transition min-h-[44px]">
                    {'Close'}
                </button>
            </div>
        </div>
    )
}

/* ========================================
   Follow-up Question Component
   ======================================== */

function FollowUpQuestion({ productName, language, scanId, scanToken }: { productName: string; language: string; scanId?: string; scanToken?: string }) {
    const [question, setQuestion] = useState('')
    const [conversation, setConversation] = useState<{ role: 'user' | 'assistant'; content: string }[]>([])
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const inputRef = useRef<HTMLInputElement>(null)
    const threadRef = useRef<HTMLDivElement>(null)
    const suggestedQuestions = ['Is this safe for children?', 'Are there natural alternatives?', 'Does this contain allergens?']

    const handleAsk = async (q?: string) => {
        const questionText = q || question
        if (!questionText.trim()) return

        setLoading(true)
        setError(null)
        setConversation(prev => [...prev, { role: 'user', content: questionText }])
        setQuestion('')

        try {
            const res = await fetch('/api/question', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    question: questionText,
                    context: `Product: ${productName}`,
                    language,
                    scan_id: scanId,
                    scan_token: scanToken,
                }),
            })

            const data = await res.json()
            if (!res.ok) throw new Error(data.error || 'Failed to get answer')
            const answerText = data.answer || data.response || JSON.stringify(data)
            setConversation(prev => [...prev, { role: 'assistant', content: answerText }])
            // Scroll to bottom of thread
            setTimeout(() => threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight, behavior: 'smooth' }), 100)
        } catch (err: any) {
            setError(err.message)
            // Remove the user message if failed
            setConversation(prev => prev.slice(0, -1))
        } finally {
            setLoading(false)
        }
    }

    return (
        <div className="glass-card rounded-2xl p-4 sm:p-5 md:p-6 space-y-4 animate-fade-in-up">
            <h4 className="text-base font-semibold text-white flex items-center gap-2">
                <MessageCircle size={18} className="text-blue-400 flex-shrink-0" />
                {'Ask a Follow-up Question'}
            </h4>

            {/* Suggested questions (only show if no conversation yet) */}
            {conversation.length === 0 && (
                <div className="flex flex-wrap gap-2">
                    {suggestedQuestions.map((sq, i) => (
                        <button
                            key={i}
                            onClick={() => { setQuestion(sq); handleAsk(sq) }}
                            disabled={loading}
                            className="px-3 py-2 rounded-lg bg-white/[0.04] border border-white/8 text-xs text-gray-400 hover:text-white hover:bg-white/[0.08] hover:border-white/15 transition-all duration-300 disabled:opacity-50 min-h-[36px] text-left"
                        >
                            {sq}
                        </button>
                    ))}
                </div>
            )}

            {/* Conversation Thread */}
            {conversation.length > 0 && (
                <div ref={threadRef} className="space-y-3 max-h-80 overflow-y-auto pr-1">
                    {conversation.map((msg, i) => (
                        <div
                            key={i}
                            className={`p-3 rounded-xl text-sm leading-relaxed animate-fade-in ${
                                msg.role === 'user'
                                    ? 'bg-blue-500/10 border border-blue-500/15 text-blue-300 ml-8'
                                    : 'bg-white/[0.03] border border-white/5 text-gray-300 mr-8'
                            }`}
                        >
                            <p className="whitespace-pre-line">{msg.content}</p>
                        </div>
                    ))}
                    {loading && (
                        <div className="p-3 rounded-xl bg-white/[0.03] border border-white/5 mr-8 animate-fade-in">
                            <Loader2 size={14} className="animate-spin text-gray-500" />
                        </div>
                    )}
                </div>
            )}

            {/* Input */}
            <div className="flex gap-2">
                <input
                    ref={inputRef}
                    type="text"
                    value={question}
                    onChange={(e) => setQuestion(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleAsk()}
                    placeholder={'Type your question...'}
                    disabled={loading}
                    className="flex-1 min-w-0 px-4 py-3 rounded-xl bg-black/30 border border-white/8 text-white text-sm placeholder-gray-600 focus:border-blue-500/40 transition-colors disabled:opacity-50"
                />
                <button
                    onClick={() => handleAsk()}
                    disabled={loading || !question.trim()}
                    className="px-4 py-3 rounded-xl bg-blue-500/20 border border-blue-500/30 text-blue-400 hover:bg-blue-500/30 transition-all disabled:opacity-30 disabled:cursor-not-allowed active:scale-95 min-w-[48px] min-h-[48px] flex items-center justify-center"
                >
                    {loading ? <Loader2 size={18} className="animate-spin" /> : <Send size={18} />}
                </button>
            </div>

            {/* Error */}
            {error && (
                <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-sm text-red-400">
                    {error}
                </div>
            )}
        </div>
    )
}

/* ========================================
   Main Analysis Result Component
   ======================================== */

export default function AnalysisResult({ data, language = 'English' }: AnalysisResultProps) {
    const [expandedIngredients, setExpandedIngredients] = useState<Set<string>>(new Set())
    const [showShareModal, setShowShareModal] = useState(false)
    const [filterVerdict, setFilterVerdict] = useState<'all' | 'safe' | 'warning' | 'danger'>('all')
    const [searchQuery, setSearchQuery] = useState('')
    // Allergen-profile matches are derived state from the `data` prop plus
    // the user's stored profile. useMemo is the correct hook here — using
    // useState + useEffect to compute derived state is the anti-pattern
    // react-hooks/set-state-in-effect catches, and would trigger an extra
    // render on every scan.
    const allergenMatches: AllergenMatch[] = useMemo(() => {
        if (typeof window === 'undefined') return []
        const active = loadAllergenProfile()
        if (active.length === 0 || !data?.ingredients?.length) return []
        const all: AllergenMatch[] = []
        for (const ing of data.ingredients) {
            const hits = matchAllergens(ing.name, active)
            for (const h of hits) all.push(h)
        }
        return all
    }, [data])

    const product = data.product
    const ingredients = data.ingredients || []

    const getVerdict = (item: Ingredient): 'danger' | 'warning' | 'safe' => {
        const cat = item.analysis.category?.toUpperCase() || ''
        if (cat === 'BANNED' || cat === 'AVOID') return 'danger'
        if (cat === 'CAUTION') return 'warning'
        if (cat === 'SAFE') return 'safe'
        const hasConcerns = item.analysis.concerns?.some(c => c !== 'None' && c !== 'No concerns' && !c.includes('No official'))
        return hasConcerns ? 'warning' : 'safe'
    }

    const safeCount = ingredients.filter(i => getVerdict(i) === 'safe').length
    const warningCount = ingredients.filter(i => getVerdict(i) === 'warning').length
    const dangerCount = ingredients.filter(i => getVerdict(i) === 'danger').length
    const totalCount = ingredients.length

    // Weighted score: safe=1.0, warning=0.5, danger=0.0
    const safetyScore = totalCount > 0
        ? Math.round(((safeCount * 1.0 + warningCount * 0.5) / totalCount) * 100)
        : 0

    let scoreColor = 'text-green-400'
    let scoreLabel = 'Safe'
    if (safetyScore < 70) { scoreColor = 'text-yellow-400'; scoreLabel = 'Caution' }
    if (safetyScore < 40) { scoreColor = 'text-red-400'; scoreLabel = 'Danger' }

    const toggleIngredient = (name: string) => {
        setExpandedIngredients(prev => {
            const next = new Set(prev)
            if (next.has(name)) next.delete(name)
            else next.add(name)
            return next
        })
    }

    const expandAll = () => {
        if (expandedIngredients.size === ingredients.length) {
            setExpandedIngredients(new Set())
        } else {
            setExpandedIngredients(new Set(ingredients.map(i => i.name)))
        }
    }

    const shareText = `${product.product_name} by ${product.brand}\n` +
        `Safety Score: ${safetyScore}/100 (${scoreLabel})\n\n` +
        `Total: ${totalCount} ingredients\n` +
        `Safe: ${safeCount} | Caution: ${warningCount} | Avoid: ${dangerCount}\n\n` +
        `Analyzed on Alzhal\n` +
        `Data: FDA, EU CosIng, WHO, BIS, FSSAI, EPA`

    /**
     * Build a Markdown export of the whole analysis. Used by the download
     * button and is also nicely paste-able into chat / docs / GitHub issues.
     * Stays readable as plain text too — no fancy HTML embeds.
     */
    const buildMarkdownReport = (): string => {
        const lines: string[] = []
        lines.push(`# ${product.product_name}`)
        if (product.brand) lines.push(`**Brand:** ${product.brand}`)
        if (product.category) lines.push(`**Category:** ${product.category}`)
        lines.push('')
        lines.push(`## Safety Score: ${safetyScore}/100 — ${scoreLabel}`)
        lines.push('')
        lines.push(`- Safe: **${safeCount}**`)
        lines.push(`- Caution: **${warningCount}**`)
        lines.push(`- Avoid: **${dangerCount}**`)
        lines.push(`- Total ingredients: **${totalCount}**`)
        lines.push('')
        lines.push('## Ingredients')
        for (const item of ingredients) {
            const v = getVerdict(item)
            const verdictLabel = v === 'danger' ? 'AVOID' : v === 'warning' ? 'CAUTION' : 'SAFE'
            lines.push('')
            lines.push(`### ${item.name} — ${verdictLabel}`)
            const a = item.analysis
            if (a.simple_name) lines.push(a.simple_name)
            if (a.cas_number && a.cas_number !== 'N/A') lines.push(`- CAS: ${a.cas_number}`)
            const banned = a.banned_countries || a.banned_in || []
            if (banned.length) lines.push(`- Banned in: ${banned.join(', ')}`)
            if (a.concerns && a.concerns.length > 0) {
                lines.push('- Concerns:')
                for (const c of a.concerns) lines.push(`  - ${c}`)
            }
            if (a.sources_cited && a.sources_cited.length > 0) {
                lines.push(`- Sources: ${a.sources_cited.join('; ')}`)
            }
        }
        lines.push('')
        lines.push('---')
        lines.push('_Generated by Alzhal — educational information only, not medical advice._')
        lines.push(`_Generated at ${new Date().toISOString()}_`)
        return lines.join('\n')
    }

    const handleDownload = () => {
        try {
            const md = buildMarkdownReport()
            const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' })
            const url = URL.createObjectURL(blob)
            const safeName = (product.product_name || 'report')
                .replace(/[^\w\d\-]+/g, '-')
                .replace(/^-+|-+$/g, '')
                .slice(0, 60) || 'report'
            const a = document.createElement('a')
            a.href = url
            a.download = `alzhal-${safeName}-${new Date().toISOString().slice(0, 10)}.md`
            document.body.appendChild(a)
            a.click()
            document.body.removeChild(a)
            // Revoke after a tick so Firefox actually downloads the file.
            setTimeout(() => URL.revokeObjectURL(url), 1000)
        } catch (e) {
            console.error('[AnalysisResult] download failed:', e)
        }
    }

    const filteredIngredients = ingredients.filter(i => {
        if (filterVerdict !== 'all' && getVerdict(i) !== filterVerdict) return false
        if (searchQuery) {
            const q = searchQuery.toLowerCase()
            return i.name.toLowerCase().includes(q) ||
                (i.analysis.simple_name || '').toLowerCase().includes(q)
        }
        return true
    })

    // Calculate bar widths for the summary
    const safePercent = totalCount > 0 ? (safeCount / totalCount) * 100 : 0
    const warningPercent = totalCount > 0 ? (warningCount / totalCount) * 100 : 0
    const dangerPercent = totalCount > 0 ? (dangerCount / totalCount) * 100 : 0

    // Group matches by allergen so the banner doesn't list the same
    // category twice when multiple ingredients hit it.
    const groupedAllergens = (() => {
        const map = new Map<string, { label: string; ingredients: Set<string> }>()
        for (const m of allergenMatches) {
            if (!map.has(m.allergenKey)) {
                map.set(m.allergenKey, { label: m.allergenLabel, ingredients: new Set() })
            }
            map.get(m.allergenKey)!.ingredients.add(m.ingredientName)
        }
        return [...map.entries()].map(([key, v]) => ({
            key,
            label: v.label,
            ingredients: [...v.ingredients],
        }))
    })()

    return (
        <div className="w-full max-w-5xl mx-auto pb-20 space-y-6 animate-fade-in">

            {/* ====== ALLERGEN ALERT (above everything) ====== */}
            {groupedAllergens.length > 0 && (
                <div
                    role="alert"
                    className="glass-card rounded-2xl border border-amber-500/30 bg-amber-500/[0.08] p-4 sm:p-5 animate-fade-in-up"
                >
                    <div className="flex items-start gap-3">
                        <div className="w-9 h-9 rounded-xl bg-amber-500/20 flex items-center justify-center flex-shrink-0">
                            <AlertTriangle size={18} className="text-amber-400" aria-hidden />
                        </div>
                        <div className="flex-1 min-w-0">
                            <p className="text-sm font-semibold text-amber-200 mb-1">
                                {groupedAllergens.length === 1
                                    ? `Heads up — this matches your allergen profile`
                                    : `Heads up — ${groupedAllergens.length} of your allergens are in this product`}
                            </p>
                            <ul className="space-y-1">
                                {groupedAllergens.map(g => (
                                    <li key={g.key} className="text-xs text-amber-100/90 leading-relaxed">
                                        <span className="font-semibold">{g.label}:</span>{' '}
                                        <span className="text-amber-100/70">
                                            {g.ingredients.slice(0, 4).join(', ')}
                                            {g.ingredients.length > 4 && ` (+${g.ingredients.length - 4} more)`}
                                        </span>
                                    </li>
                                ))}
                            </ul>
                            <p className="text-[10px] text-amber-200/60 mt-2 leading-relaxed">
                                Convenience filter only. Always verify the label and consult a doctor for severe allergies.
                            </p>
                        </div>
                    </div>
                </div>
            )}

            {/* ====== SAFETY REPORT HEADER ====== */}
            <div className="glass-card rounded-2xl overflow-hidden shadow-xl shadow-black/20">
                {/* Gradient accent bar at top */}
                <div className="h-1.5 w-full bg-gradient-to-r from-green-500 via-blue-500 to-purple-500" />

                <div className="p-5 sm:p-6 md:p-8">
                    <div className="flex flex-col lg:flex-row justify-between gap-6 lg:gap-10">
                        {/* Left: Product info */}
                        <div className="flex-1 space-y-3">
                            <CategoryBadge category={product.category} />

                            <h2 className="text-xl sm:text-2xl md:text-4xl font-bold text-white tracking-tight leading-tight">
                                {product.product_name}
                            </h2>
                            {product.brand && (
                                <p className="text-sm sm:text-base md:text-lg text-gray-500 font-medium">{product.brand}</p>
                            )}
                            {data.scannedCount && data.scannedCount > 1 && (
                                <p className="text-xs text-gray-600 flex items-center gap-1.5">
                                    <Eye size={12} />
                                    {`Checked ${data.scannedCount} times`}
                                </p>
                            )}

                            {/* Action buttons */}
                            <div className="flex gap-2 pt-2 flex-wrap no-print">
                                <button
                                    onClick={() => setShowShareModal(true)}
                                    className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-white/[0.05] border border-white/[0.08] hover:bg-white/[0.10] hover:border-white/15 transition-all duration-300 text-sm font-semibold text-gray-400 hover:text-white active:scale-95 min-h-[44px] group"
                                    aria-label="Share this safety report"
                                >
                                    <Share2 size={14} className="group-hover:scale-110 transition-transform" aria-hidden />
                                    {'Share Report'}
                                </button>
                                <button
                                    onClick={handleDownload}
                                    className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-white/[0.05] border border-white/[0.08] hover:bg-white/[0.10] hover:border-white/15 transition-all duration-300 text-sm font-semibold text-gray-400 hover:text-white active:scale-95 min-h-[44px]"
                                    aria-label="Download the report as a Markdown file"
                                    title="Download as .md"
                                >
                                    <Download size={14} aria-hidden />
                                    <span className="hidden sm:inline">Download</span>
                                </button>
                                {(dangerCount + warningCount) > 0 && filterVerdict === 'all' && (
                                    <button
                                        onClick={() => {
                                            setFilterVerdict(dangerCount > 0 ? 'danger' : 'warning')
                                            setExpandedIngredients(new Set(
                                                ingredients
                                                    .filter(i => {
                                                        const v = getVerdict(i)
                                                        return dangerCount > 0 ? v === 'danger' : v === 'warning'
                                                    })
                                                    .map(i => i.name),
                                            ))
                                        }}
                                        className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-red-500/[0.08] hover:bg-red-500/15 border border-red-500/25 transition text-sm font-semibold text-red-300 active:scale-95 min-h-[44px]"
                                        aria-label={`Filter the list to the ${dangerCount + warningCount} ingredients of concern`}
                                    >
                                        <AlertTriangle size={14} aria-hidden />
                                        {`Show ${dangerCount + warningCount} concern${dangerCount + warningCount === 1 ? '' : 's'}`}
                                    </button>
                                )}
                            </div>
                        </div>

                        {/* Right: Score gauge */}
                        <div className="flex items-center gap-5 p-5 md:p-6 rounded-2xl bg-black/30 border border-white/[0.06] shadow-inner">
                            <div className="space-y-1.5">
                                <p className="text-[11px] text-gray-400 uppercase tracking-widest font-bold">
                                    {'Safety Score'}
                                </p>
                                <p className="text-[10px] text-gray-600 hidden md:block leading-relaxed">
                                    {'Based on regulatory data'}
                                </p>
                            </div>
                            <ScoreGauge score={safetyScore} size={110} />
                        </div>
                    </div>

                    {/* Composition bar */}
                    <div className="mt-6 pt-6 border-t border-white/5">
                        <div className="flex items-center gap-2 mb-3">
                            <span className="text-xs font-medium text-gray-500 uppercase tracking-wider">
                                {'Ingredient Breakdown'}
                            </span>
                        </div>
                        <div className="h-2.5 rounded-full bg-white/5 overflow-hidden flex shadow-inner">
                            {safePercent > 0 && (
                                <div
                                    className="h-full bg-green-500 transition-all duration-1000 ease-out rounded-l-full"
                                    style={{ width: `${safePercent}%` }}
                                />
                            )}
                            {warningPercent > 0 && (
                                <div
                                    className="h-full bg-yellow-500 transition-all duration-1000 ease-out"
                                    style={{ width: `${warningPercent}%` }}
                                />
                            )}
                            {dangerPercent > 0 && (
                                <div
                                    className="h-full bg-red-500 transition-all duration-1000 ease-out rounded-r-full"
                                    style={{ width: `${dangerPercent}%` }}
                                />
                            )}
                        </div>

                        {/* Summary stats */}
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-3 mt-4">
                            <div className="flex items-center gap-3 p-3 rounded-xl bg-white/[0.02] border border-white/5">
                                <div className="w-8 h-8 rounded-lg bg-white/5 flex items-center justify-center text-lg font-bold text-white">
                                    {totalCount}
                                </div>
                                <span className="text-xs text-gray-500 font-medium">
                                    {'Total'}
                                </span>
                            </div>
                            <div className="flex items-center gap-3 p-3 rounded-xl bg-green-500/5 border border-green-500/10">
                                <div className="w-8 h-8 rounded-lg bg-green-500/10 flex items-center justify-center text-lg font-bold text-green-400">
                                    {safeCount}
                                </div>
                                <span className="text-xs text-green-500/70 font-medium">
                                    {'Safe'}
                                </span>
                            </div>
                            <div className="flex items-center gap-3 p-3 rounded-xl bg-yellow-500/5 border border-yellow-500/10">
                                <div className="w-8 h-8 rounded-lg bg-yellow-500/10 flex items-center justify-center text-lg font-bold text-yellow-400">
                                    {warningCount}
                                </div>
                                <span className="text-xs text-yellow-500/70 font-medium">
                                    {'Caution'}
                                </span>
                            </div>
                            <div className="flex items-center gap-3 p-3 rounded-xl bg-red-500/5 border border-red-500/10">
                                <div className="w-8 h-8 rounded-lg bg-red-500/10 flex items-center justify-center text-lg font-bold text-red-400">
                                    {dangerCount}
                                </div>
                                <span className="text-xs text-red-500/70 font-medium">
                                    {'Avoid'}
                                </span>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            {/* ====== NUTRITION CARD ====== */}
            {data.nutrition && <NutritionCard nutrition={data.nutrition} />}

            {/* ====== INGREDIENT LIST HEADER (sticky) ====== */}
            <div className="sticky top-[53px] z-30 bg-[#09090b]/95 backdrop-blur-md -mx-4 px-4 py-3 space-y-3 border-b border-white/5">
                <div className="flex items-center justify-between">
                    <h3 className="text-base sm:text-lg font-semibold text-white flex items-center gap-2">
                        <Info size={18} className="text-blue-400 flex-shrink-0" />
                        {'Detailed Analysis'}
                        <span className="text-sm text-gray-600 font-normal">({filteredIngredients.length})</span>
                    </h3>

                    {/* Expand/Collapse all */}
                    <button
                        onClick={expandAll}
                        className="px-3 py-2 rounded-lg text-xs font-medium text-gray-500 hover:text-white bg-white/[0.03] border border-white/5 hover:bg-white/[0.06] transition-all min-h-[36px] flex-shrink-0"
                    >
                        {expandedIngredients.size === ingredients.length
                            ? ('Collapse')
                            : ('Expand All')
                        }
                    </button>
                </div>

                {/* Search input - only show when 10+ ingredients */}
                {totalCount >= 10 && (
                    <div className="relative">
                        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-600" />
                        <input
                            type="text"
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            placeholder={'Search ingredients...'}
                            className="w-full pl-9 pr-3 py-2.5 rounded-xl bg-white/[0.04] border border-white/8 text-sm text-white placeholder-gray-600 focus:border-blue-500/40 transition-colors"
                        />
                    </div>
                )}

                {/* Filter buttons - horizontally scrollable on mobile */}
                <div className="overflow-x-auto no-scrollbar -mx-4 px-4 sm:mx-0 sm:px-0">
                    <div className="flex rounded-xl bg-white/[0.03] border border-white/5 p-1 gap-0.5 w-fit sm:w-full">
                        {[
                            { key: 'all' as const, label: 'All', count: totalCount },
                            { key: 'safe' as const, label: 'Safe', count: safeCount },
                            { key: 'warning' as const, label: 'Caution', count: warningCount },
                            { key: 'danger' as const, label: 'Avoid', count: dangerCount },
                        ].map(f => (
                            <button
                                key={f.key}
                                onClick={() => setFilterVerdict(f.key)}
                                className={`px-3 sm:px-4 py-2 rounded-lg text-xs font-medium transition-all whitespace-nowrap min-h-[36px] flex-1 ${
                                    filterVerdict === f.key
                                        ? 'bg-white/10 text-white shadow-sm'
                                        : 'text-gray-500 hover:text-gray-300 active:bg-white/5'
                                }`}
                            >
                                {f.label} {f.count > 0 && <span className="opacity-50">({f.count})</span>}
                            </button>
                        ))}
                    </div>
                </div>
            </div>

            {/* ====== INGREDIENT CARDS ====== */}
            <div className="space-y-2 stagger-children">
                {filteredIngredients.map((item, index) => {
                    const verdict = getVerdict(item)
                    const isExpanded = expandedIngredients.has(item.name)
                    const analysis = item.analysis
                    const regStatus = analysis.regulatory_status
                    const safetyLimits = analysis.safety_limits
                    const bannedList = analysis.banned_countries || analysis.banned_in || []

                    const verdictConfig = {
                        danger: {
                            border: 'border-red-500/20 hover:border-red-500/40',
                            bg: 'bg-red-500/[0.03]',
                            hoverBg: 'hover:bg-red-500/[0.06]',
                            badge: 'bg-red-500 text-white',
                            badgeLabel: 'AVOID',
                            text: 'text-red-400',
                            icon: <XCircle size={18} />,
                        },
                        warning: {
                            border: 'border-yellow-500/15 hover:border-yellow-500/30',
                            bg: 'bg-yellow-500/[0.02]',
                            hoverBg: 'hover:bg-yellow-500/[0.04]',
                            badge: 'bg-yellow-500 text-black',
                            badgeLabel: 'CAUTION',
                            text: 'text-yellow-400',
                            icon: <AlertTriangle size={18} />,
                        },
                        safe: {
                            border: 'border-white/5 hover:border-white/15',
                            bg: 'bg-white/[0.01]',
                            hoverBg: 'hover:bg-white/[0.03]',
                            badge: 'bg-green-500 text-white',
                            badgeLabel: 'SAFE',
                            text: 'text-white',
                            icon: <CheckCircle2 size={18} />,
                        },
                    }

                    const cfg = verdictConfig[verdict]

                    return (
                        <div key={index} className={`rounded-2xl border transition-all duration-300 overflow-hidden ${cfg.border} ${cfg.bg} ${cfg.hoverBg}`}>
                            {/* Row Header */}
                            <div
                                className="p-4 md:p-5 flex items-center justify-between cursor-pointer select-none active:bg-white/[0.02] transition-colors"
                                onClick={() => toggleIngredient(item.name)}
                            >
                                <div className="flex items-center gap-3 min-w-0 flex-1">
                                    <div className={`w-9 h-9 sm:w-10 sm:h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${cfg.badge}`}>
                                        {cfg.icon}
                                    </div>
                                    <div className="min-w-0 flex-1">
                                        <div className="flex items-center gap-2 flex-wrap">
                                            <h4 className={`font-semibold text-sm md:text-base ${cfg.text} truncate max-w-[200px] sm:max-w-none`}>
                                                {item.name}
                                            </h4>
                                            {analysis.cas_number && analysis.cas_number !== 'N/A' && (
                                                <span className="text-[10px] font-mono text-gray-600 bg-white/[0.03] px-1.5 py-0.5 rounded hidden md:inline">
                                                    CAS: {analysis.cas_number}
                                                </span>
                                            )}
                                        </div>
                                        <p className="text-xs text-gray-500 mt-0.5 line-clamp-1">
                                            {analysis.translated_text
                                                ? analysis.translated_text.split('\n')[0].replace('Explanation: ', '')
                                                : analysis.simple_name}
                                        </p>
                                    </div>
                                </div>

                                <div className="flex items-center gap-1.5 sm:gap-2 flex-shrink-0 ml-2 sm:ml-3">
                                    {bannedList.length > 0 && (
                                        <span className="hidden sm:inline-flex items-center gap-1 px-2 py-1 text-[10px] font-bold bg-red-500/15 text-red-400 rounded-lg border border-red-500/20">
                                            <Ban size={10} />
                                            {'BANNED'}
                                        </span>
                                    )}
                                    <span className={`inline-flex px-2.5 py-1 rounded-lg text-[10px] font-bold uppercase tracking-wider ${cfg.badge}`}>
                                        {cfg.badgeLabel}
                                    </span>
                                    <div className={`transform transition-transform duration-300 text-gray-600 p-1 ${isExpanded ? 'rotate-180' : ''}`}>
                                        <ChevronDown size={18} />
                                    </div>
                                </div>
                            </div>

                            {/* Expanded Content */}
                            <div className={`transition-all duration-500 ease-in-out ${
                                isExpanded ? 'max-h-[2500px] opacity-100' : 'max-h-0 opacity-0 overflow-hidden'
                            }`}>
                                <div className="border-t border-white/5 bg-black/20 p-4 sm:p-5 md:p-6 space-y-4 sm:space-y-5">

                                    {/* Description */}
                                    <p className="text-sm text-gray-300 leading-relaxed">
                                        {analysis.translated_text || analysis.simple_name}
                                    </p>

                                    {/* Plain-language guidance — shown FIRST so the user
                                        sees a clear takeaway before the regulatory detail.
                                        Renders in the user's language when a verified
                                        translation exists; otherwise falls back to English. */}
                                    <WhatThisMeans
                                        verdict={toGuidanceVerdict(verdict, bannedList)}
                                        language={language || 'English'}
                                    />

                                    {/* Critical Alerts */}
                                    {verdict !== 'safe' && analysis.concerns && analysis.concerns.length > 0 && (
                                        <div className={`p-4 rounded-xl border ${
                                            verdict === 'danger'
                                                ? 'bg-red-500/8 border-red-500/20'
                                                : 'bg-yellow-500/8 border-yellow-500/20'
                                        }`}>
                                            <div className="flex items-start gap-3">
                                                {verdict === 'danger'
                                                    ? <ShieldAlert className="text-red-400 mt-0.5 flex-shrink-0" size={18} />
                                                    : <AlertTriangle className="text-yellow-400 mt-0.5 flex-shrink-0" size={18} />}
                                                <div>
                                                    <h5 className={`text-sm font-bold mb-2 ${
                                                        verdict === 'danger' ? 'text-red-400' : 'text-yellow-400'
                                                    }`}>
                                                        {verdict === 'danger'
                                                            ? ('Critical Safety Warning')
                                                            : ('Safety Concerns')}
                                                    </h5>
                                                    <ul className="space-y-1.5">
                                                        {analysis.concerns.filter(c => c !== 'None').map((c, i) => (
                                                            <li key={i} className="text-sm text-gray-300 flex items-start gap-2">
                                                                <span className={`mt-1.5 w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                                                                    verdict === 'danger' ? 'bg-red-400' : 'bg-yellow-400'
                                                                }`} />
                                                                {c}
                                                            </li>
                                                        ))}
                                                    </ul>
                                                </div>
                                            </div>
                                        </div>
                                    )}

                                    {/* Banned Countries */}
                                    {bannedList.length > 0 && (
                                        <div className="p-4 rounded-xl bg-red-500/8 border border-red-500/20">
                                            <div className="flex items-center gap-2 mb-2">
                                                <Ban size={14} className="text-red-400" />
                                                <p className="text-red-400 font-bold text-xs uppercase tracking-wider">
                                                    {'Banned in'}
                                                </p>
                                            </div>
                                            <div className="flex flex-wrap gap-1.5">
                                                {bannedList.map((country, i) => (
                                                    <span key={i} className="px-2 py-1 text-xs rounded-lg bg-red-500/15 text-red-300 border border-red-500/20">
                                                        {country}
                                                    </span>
                                                ))}
                                            </div>
                                        </div>
                                    )}

                                    {/* Limit Exceeded Alert */}
                                    {analysis.limit_exceeded && Object.values(analysis.limit_exceeded).some((v: any) => v?.exceeded) && (
                                        <div className="p-4 rounded-xl bg-red-500/10 border border-red-500/25">
                                            <div className="flex items-center gap-2 mb-2">
                                                <TrendingUp size={14} className="text-red-400" />
                                                <p className="text-red-400 font-bold text-xs uppercase tracking-wider">
                                                    {'EXCEEDS SAFE LIMIT'}
                                                </p>
                                            </div>
                                            <div className="space-y-1.5">
                                                {analysis.limit_exceeded.fssai?.exceeded && (
                                                    <p className="text-sm text-red-300">
                                                        FSSAI: {'Max allowed'} {analysis.limit_exceeded.fssai.max_allowed}
                                                        {analysis.limit_exceeded.fssai.typical_use && ` (${'Typical'}: ${analysis.limit_exceeded.fssai.typical_use})`}
                                                    </p>
                                                )}
                                                {analysis.limit_exceeded.eu?.exceeded && (
                                                    <p className="text-sm text-red-300">
                                                        EU: {'Max allowed'} {analysis.limit_exceeded.eu.max_allowed}
                                                        {analysis.limit_exceeded.eu.typical_use && ` (${'Typical'}: ${analysis.limit_exceeded.eu.typical_use})`}
                                                    </p>
                                                )}
                                                {analysis.limit_exceeded.fda?.exceeded && (
                                                    <p className="text-sm text-red-300">
                                                        FDA: {'Max allowed'} {analysis.limit_exceeded.fda.max_allowed}
                                                        {analysis.limit_exceeded.fda.typical_use && ` (${'Typical'}: ${analysis.limit_exceeded.fda.typical_use})`}
                                                    </p>
                                                )}
                                            </div>
                                        </div>
                                    )}

                                    {/* Regional Ban Conflict Alert */}
                                    {analysis.regional_ban_conflicts && analysis.regional_ban_conflicts.length > 0 && (
                                        <div className="p-4 rounded-xl bg-orange-500/10 border border-orange-500/25">
                                            <div className="flex items-center gap-2 mb-2">
                                                <AlertTriangle size={14} className="text-orange-400" />
                                                <p className="text-orange-400 font-bold text-xs uppercase tracking-wider">
                                                    {'Regional Ban Conflict'}
                                                </p>
                                            </div>
                                            <ul className="space-y-1">
                                                {analysis.regional_ban_conflicts.map((conflict, i) => (
                                                    <li key={i} className="text-sm text-orange-300 flex items-start gap-2">
                                                        <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-orange-400 flex-shrink-0" />
                                                        {conflict}
                                                    </li>
                                                ))}
                                            </ul>
                                        </div>
                                    )}

                                    {/* Regulatory Status Grid */}
                                    <div>
                                        <h5 className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-3 flex items-center gap-2">
                                            <ShieldCheck size={14} />
                                            {'Regulatory Status'}
                                        </h5>
                                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm">
                                            {regStatus?.india_fssai && regStatus.india_fssai !== 'Data not available' && (
                                                <StatusCard flag="IN" label="FSSAI" value={regStatus.india_fssai} />
                                            )}
                                            {regStatus?.india_bis && regStatus.india_bis !== 'Data not available' && (
                                                <StatusCard flag="IN" label="BIS IS 4707" value={regStatus.india_bis} />
                                            )}
                                            {regStatus?.eu_cosing && regStatus.eu_cosing !== 'Data not available' && (
                                                <StatusCard flag="EU" label="EU CosIng" value={regStatus.eu_cosing} />
                                            )}
                                            {regStatus?.us_fda && regStatus.us_fda !== 'Data not available' && (
                                                <StatusCard flag="US" label="FDA CFR 21" value={regStatus.us_fda} />
                                            )}
                                            {regStatus?.us_epa && regStatus.us_epa !== 'Data not available' && (
                                                <StatusCard flag="US" label="EPA SCIL" value={regStatus.us_epa} />
                                            )}
                                            {regStatus?.who_iarc && regStatus.who_iarc !== 'Data not available' && (
                                                <StatusCard flag="WHO" label="WHO/IARC" value={regStatus.who_iarc} />
                                            )}
                                            {/* Fallback to old fields */}
                                            {!regStatus && analysis.fda_status && (
                                                <StatusCard flag="US" label="FDA" value={analysis.fda_status} />
                                            )}
                                            {!regStatus && analysis.eu_status && (
                                                <StatusCard flag="EU" label="EU" value={analysis.eu_status} />
                                            )}
                                            {!regStatus && analysis.who_status && (
                                                <StatusCard flag="WHO" label="WHO" value={analysis.who_status} />
                                            )}
                                        </div>
                                    </div>

                                    {/* Safety Limits */}
                                    {safetyLimits && (safetyLimits.fssai_max || safetyLimits.eu_max || safetyLimits.fda_max) && (
                                        <div>
                                            <h5 className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-3">
                                                {'Safety Limits'}
                                            </h5>
                                            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-sm">
                                                {safetyLimits.fssai_max && safetyLimits.fssai_max !== 'Not specified' && (
                                                    <div className="p-3 rounded-xl bg-white/[0.03] border border-white/5">
                                                        <p className="text-gray-600 text-[10px] font-bold uppercase tracking-wider">FSSAI Max</p>
                                                        <p className="text-gray-300 mt-1 text-sm">{safetyLimits.fssai_max}</p>
                                                    </div>
                                                )}
                                                {safetyLimits.eu_max && safetyLimits.eu_max !== 'Not specified' && (
                                                    <div className="p-3 rounded-xl bg-white/[0.03] border border-white/5">
                                                        <p className="text-gray-600 text-[10px] font-bold uppercase tracking-wider">EU Max</p>
                                                        <p className="text-gray-300 mt-1 text-sm">{safetyLimits.eu_max}</p>
                                                    </div>
                                                )}
                                                {safetyLimits.fda_max && safetyLimits.fda_max !== 'Not specified' && (
                                                    <div className="p-3 rounded-xl bg-white/[0.03] border border-white/5">
                                                        <p className="text-gray-600 text-[10px] font-bold uppercase tracking-wider">FDA Max</p>
                                                        <p className="text-gray-300 mt-1 text-sm">{safetyLimits.fda_max}</p>
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                    )}

                                    {/* Technical Details */}
                                    <div className="grid md:grid-cols-2 gap-2 text-sm">
                                        {analysis.common_uses && analysis.common_uses.length > 0 && (
                                            <div className="p-3 rounded-xl bg-white/[0.03] border border-white/5">
                                                <p className="text-gray-600 text-[10px] uppercase tracking-wider font-bold mb-1">
                                                    {'Common Uses'}
                                                </p>
                                                <p className="text-gray-300 text-sm">{analysis.common_uses.join(', ')}</p>
                                            </div>
                                        )}
                                        {analysis.chemical_formula && analysis.chemical_formula !== 'N/A' && (
                                            <div className="p-3 rounded-xl bg-white/[0.03] border border-white/5">
                                                <p className="text-gray-600 text-[10px] uppercase tracking-wider font-bold mb-1">
                                                    {'Chemical Formula'}
                                                </p>
                                                <p className="text-blue-300 font-mono text-sm">{analysis.chemical_formula}</p>
                                            </div>
                                        )}
                                    </div>

                                    {/* Sources Cited */}
                                    {analysis.sources_cited && analysis.sources_cited.length > 0 && (
                                        <div className="pt-3 border-t border-white/5">
                                            <h5 className="text-[10px] font-bold text-gray-600 uppercase tracking-wider mb-2 flex items-center gap-1">
                                                <BookOpen size={11} />
                                                {'Sources'}
                                            </h5>
                                            <div className="flex flex-wrap gap-1.5">
                                                {analysis.sources_cited.map((source, i) => (
                                                    <span key={i} className="px-2 py-1 text-[10px] rounded-lg bg-blue-500/8 text-blue-400/80 border border-blue-500/15">
                                                        {source}
                                                    </span>
                                                ))}
                                            </div>
                                        </div>
                                    )}

                                    {/* v2-grounded: per-jurisdiction records with clickable source URLs.
                                         Only renders when the grounded pipeline supplied this analysis. */}
                                    {analysis._grounded && analysis._per_jurisdiction && analysis._per_jurisdiction.length > 0 && (
                                        <div className="pt-3 border-t border-white/5">
                                            <div className="flex items-center justify-between mb-2">
                                                <h5 className="text-[10px] font-bold text-emerald-400/70 uppercase tracking-wider flex items-center gap-1">
                                                    <ShieldCheck size={11} />
                                                    {'Official records'}
                                                </h5>
                                                <span
                                                    className="text-[9px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
                                                    title="Every line here is a real regulator's text, with a link to the source. The AI did not write it."
                                                >
                                                    {'verified'}
                                                </span>
                                            </div>
                                            <div className="space-y-1">
                                                {analysis._per_jurisdiction.map((r, i) => (
                                                    <a
                                                        key={i}
                                                        href={r.source_url}
                                                        target="_blank"
                                                        rel="noopener noreferrer"
                                                        className="flex items-start gap-2 p-2 rounded-lg bg-white/[0.02] hover:bg-white/[0.05] border border-white/5 hover:border-emerald-500/30 transition group/reg"
                                                    >
                                                        <div className="flex-1 min-w-0">
                                                            <div className="flex items-center gap-2 mb-0.5">
                                                                <span className="text-[10px] font-bold text-emerald-400 uppercase tracking-wide">
                                                                    {r.jurisdiction.replace(/_/g, ' ')}
                                                                </span>
                                                                {r.regulation_ref && (
                                                                    <span className="text-[9px] font-mono text-gray-500">{r.regulation_ref}</span>
                                                                )}
                                                            </div>
                                                            <p className="text-xs text-gray-300 leading-snug">{r.status}</p>
                                                            <p className="text-[9px] text-gray-500 mt-0.5">{r.source_name}</p>
                                                        </div>
                                                        <ExternalLink size={11} className="text-gray-500 group-hover/reg:text-emerald-400 shrink-0 mt-0.5" />
                                                    </a>
                                                ))}
                                            </div>
                                        </div>
                                    )}

                                    {/* Consumer-friendly external references — every link is
                                        a free public database the user can cross-check us against. */}
                                    <LearnMoreLinks
                                        input={{
                                            name: item.name,
                                            casNumber: analysis.cas_number,
                                            pubchemCid: (analysis as any).pubchem_cid ?? null,
                                            eNumber: (analysis as any).e_number ?? null,
                                        }}
                                        language={language || 'English'}
                                    />

                                    {/* Per-ingredient feedback */}
                                    {data.scanId && (
                                        <div className="pt-3 border-t border-white/5 flex justify-end">
                                            <IngredientFeedback scanId={data.scanId} ingredientName={item.name} language={language} />
                                        </div>
                                    )}
                                </div>
                            </div>
                        </div>
                    )
                })}
            </div>

            {/* ====== PHOTO NUDGE ====== */}
            {data.isProductNameLookup && (
                <div className="glass-card rounded-2xl p-4 sm:p-5 border border-blue-500/20 bg-blue-500/[0.04] animate-fade-in-up">
                    <div className="flex items-start gap-3">
                        <div className="w-9 h-9 rounded-xl bg-blue-500/15 flex items-center justify-center flex-shrink-0">
                            <Camera size={18} className="text-blue-400" />
                        </div>
                        <div>
                            <p className="text-sm font-semibold text-blue-300 mb-1">
                                {'Want a more accurate analysis?'}
                            </p>
                            <p className="text-xs text-gray-400 leading-relaxed">
                                {'This report is based on AI-estimated ingredients. For exact results, send a photo of the ingredients list on the back of the pack.'}
                            </p>
                        </div>
                    </div>
                </div>
            )}

            {/* ====== FOLLOW-UP QUESTION ====== */}
            <FollowUpQuestion productName={product.product_name} language={language} scanId={data.scanId} scanToken={data.scanToken} />

            {/* ====== FEEDBACK ====== */}
            {data.scanId && (
                <FeedbackButtons scanId={data.scanId} language={language} />
            )}

            {/* ====== DATA SOURCE DISCLAIMER ====== */}
            <div className="glass-card rounded-2xl p-5 text-center space-y-2">
                <p className="text-gray-500 text-[11px] font-medium">
                    {'Our official sources'}
                </p>
                <div className="flex flex-wrap justify-center gap-1.5 text-[10px] text-gray-600">
                    {[
                        'FDA',
                        'FDA CFR 21',
                        'EU CosIng',
                        'EFSA',
                        'WHO/IARC',
                        'Codex',
                        'FSSAI',
                        'BIS',
                        'EPA SCIL',
                        'Health Canada',
                        'FSANZ',
                        'PubChem (NIH)',
                        'CAS',
                        'Open Food Facts',
                    ].map((src, i) => (
                        <span key={i} className="px-2 py-0.5 rounded bg-white/[0.02] border border-white/5">{src}</span>
                    ))}
                </div>
                <p className="text-gray-600 text-[10px] leading-relaxed pt-1">
                    {'Every safety claim links back to a specific regulation. This is educational information, not medical advice — consult a professional for personal health concerns.'}
                </p>
            </div>

            {/* Share Modal */}
            {showShareModal && (
                <ShareModal
                    text={shareText}
                    onClose={() => setShowShareModal(false)}
                    language={language}
                    scanId={data.scanId}
                    productName={product.product_name}
                />
            )}
        </div>
    )
}
