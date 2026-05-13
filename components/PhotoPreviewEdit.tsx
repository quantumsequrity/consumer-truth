'use client'

import { useState, useRef } from 'react'
import { X, Plus, ArrowRight, ArrowLeft, RotateCcw } from 'lucide-react'

export interface PreviewPayload {
    product_name: string
    brand: string
    category: string
    ingredients: string[]
    ocrSources: string[]
    primarySource: string
}

/**
 * The screen the user sees AFTER OCR but BEFORE analysis.
 *
 * Purpose: give the user a chance to fix OCR mistakes (mis-read words,
 * hallucinated extras, missing items) before the full analysis pays the
 * Gemini + DB-write cost. Today an OCR error means the whole report is
 * wrong and the user has to re-take the photo with no recourse.
 *
 * The chip UI accepts:
 *   - Type a name + Enter / comma → add chip
 *   - Click X on a chip → remove
 *   - "Reset to OCR" → restore original list
 *   - "Analyze" → bubble the (edited) list up to the parent
 *
 * Product name + brand are editable inline so the user can correct
 * those too without re-typing.
 */
export function PhotoPreviewEdit({
    preview,
    onAnalyze,
    onBack,
    isAnalyzing,
}: {
    preview: PreviewPayload
    onAnalyze: (edited: { productName: string; ingredients: string[] }) => void
    onBack: () => void
    isAnalyzing: boolean
}) {
    const [productName, setProductName] = useState(preview.product_name || '')
    const [ingredients, setIngredients] = useState<string[]>(preview.ingredients)
    const [draft, setDraft] = useState('')
    const draftInputRef = useRef<HTMLInputElement>(null)
    // Note: the parent forces a remount with a `key` prop whenever a new
    // OCR preview lands, so we DON'T need a syncing effect here — the
    // initial-state arguments above run again on every fresh mount.

    const commitDraft = () => {
        // Allow comma-separated paste — split on commas + newlines + semicolons.
        const additions = draft
            .split(/[,;\n]+/)
            .map(s => s.trim())
            .filter(s => s.length >= 2 && s.length <= 200)
        if (additions.length === 0) {
            setDraft('')
            return
        }
        setIngredients(prev => {
            const lower = new Set(prev.map(p => p.toLowerCase()))
            const merged = [...prev]
            for (const a of additions) {
                if (!lower.has(a.toLowerCase())) {
                    merged.push(a)
                    lower.add(a.toLowerCase())
                }
            }
            return merged
        })
        setDraft('')
    }

    const removeAt = (idx: number) => {
        setIngredients(prev => prev.filter((_, i) => i !== idx))
    }

    const resetToOcr = () => {
        setIngredients(preview.ingredients)
        setProductName(preview.product_name || '')
    }

    const handleAnalyze = () => {
        if (ingredients.length === 0) return
        onAnalyze({
            productName: productName.trim() || 'Photo analysis',
            ingredients,
        })
    }

    const ocrLabel =
        preview.ocrSources.length > 1
            ? `Read from ${preview.ocrSources.length} OCR engines · primary: ${preview.primarySource}`
            : `Read from ${preview.primarySource}`

    return (
        <div className="w-full max-w-xl mx-auto animate-fade-in">
            <button
                onClick={onBack}
                disabled={isAnalyzing}
                className="mb-4 flex items-center gap-1.5 text-sm text-zinc-500 hover:text-zinc-300 transition group disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-green-500/50 rounded px-1"
                aria-label="Go back to the photo upload"
            >
                <ArrowLeft size={14} className="group-hover:-translate-x-0.5 transition-transform" aria-hidden />
                Re-upload photo
            </button>

            <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 sm:p-5 space-y-4">
                <div>
                    <h2 className="text-base font-semibold text-white">Review what we read</h2>
                    <p className="text-xs text-zinc-500 mt-0.5">
                        Fix anything OCR got wrong before we analyse. {ocrLabel}.
                    </p>
                </div>

                {/* Product name */}
                <div className="space-y-1.5">
                    <label htmlFor="preview-product-name" className="text-[11px] uppercase tracking-wider text-zinc-500 font-medium">
                        Product
                    </label>
                    <input
                        id="preview-product-name"
                        type="text"
                        value={productName}
                        onChange={(e) => setProductName(e.target.value)}
                        placeholder="Product name (optional)"
                        maxLength={200}
                        disabled={isAnalyzing}
                        className="w-full px-3 py-2 rounded-md bg-zinc-950 border border-zinc-800 focus:border-zinc-600 focus:outline-none text-sm text-white placeholder-zinc-600 transition disabled:opacity-50"
                    />
                </div>

                {/* Ingredient chips */}
                <div className="space-y-1.5">
                    <div className="flex items-baseline justify-between">
                        <label className="text-[11px] uppercase tracking-wider text-zinc-500 font-medium">
                            Ingredients ({ingredients.length})
                        </label>
                        {(ingredients.length !== preview.ingredients.length ||
                            productName !== preview.product_name) && (
                            <button
                                onClick={resetToOcr}
                                disabled={isAnalyzing}
                                className="text-[11px] text-zinc-500 hover:text-zinc-300 flex items-center gap-1 transition disabled:opacity-50"
                                aria-label="Reset edits and restore the original OCR result"
                            >
                                <RotateCcw size={10} aria-hidden />
                                Reset to OCR
                            </button>
                        )}
                    </div>

                    {ingredients.length === 0 ? (
                        <p className="text-xs text-zinc-600 italic px-1 py-2">
                            No ingredients yet. Add some below to analyse.
                        </p>
                    ) : (
                        <div className="flex flex-wrap gap-1.5">
                            {ingredients.map((ing, idx) => (
                                <span
                                    key={`${ing}-${idx}`}
                                    className="inline-flex items-center gap-1 pl-2 pr-1 py-1 rounded-md bg-zinc-800 border border-zinc-700 text-xs text-zinc-200"
                                >
                                    <span className="max-w-[180px] truncate" title={ing}>{ing}</span>
                                    <button
                                        onClick={() => removeAt(idx)}
                                        disabled={isAnalyzing}
                                        aria-label={`Remove ${ing}`}
                                        className="p-0.5 rounded hover:bg-zinc-700 text-zinc-500 hover:text-zinc-200 transition disabled:opacity-50"
                                    >
                                        <X size={11} aria-hidden />
                                    </button>
                                </span>
                            ))}
                        </div>
                    )}

                    {/* Add input */}
                    <div className="flex gap-1.5 pt-1">
                        <input
                            ref={draftInputRef}
                            type="text"
                            value={draft}
                            onChange={(e) => setDraft(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter' || e.key === ',') {
                                    e.preventDefault()
                                    commitDraft()
                                }
                            }}
                            placeholder="Add ingredient (Enter to add)"
                            maxLength={200}
                            disabled={isAnalyzing}
                            className="flex-1 px-3 py-2 rounded-md bg-zinc-950 border border-zinc-800 focus:border-zinc-600 focus:outline-none text-sm text-white placeholder-zinc-600 transition disabled:opacity-50"
                            aria-label="Add an ingredient to the list"
                        />
                        <button
                            onClick={commitDraft}
                            disabled={isAnalyzing || !draft.trim()}
                            className="px-3 py-2 rounded-md bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40 text-zinc-200 text-sm transition active:scale-95"
                            aria-label="Add the typed ingredient"
                        >
                            <Plus size={14} aria-hidden />
                        </button>
                    </div>
                </div>

                <button
                    onClick={handleAnalyze}
                    disabled={isAnalyzing || ingredients.length === 0}
                    className="w-full py-2.5 rounded-md bg-green-600 hover:bg-green-700 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium transition active:scale-[0.98] flex items-center justify-center gap-2"
                    aria-label="Analyze these ingredients now"
                >
                    Analyze {ingredients.length} ingredient{ingredients.length === 1 ? '' : 's'}
                    <ArrowRight size={14} aria-hidden />
                </button>

                <p className="text-[10px] text-zinc-600 text-center leading-relaxed">
                    Tip: paste a comma-separated list to add several at once.
                </p>
            </div>
        </div>
    )
}
