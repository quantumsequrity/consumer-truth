'use client'

import { useState } from 'react'
import { X, AlertTriangle, Heart } from 'lucide-react'
import { COMMON_ALLERGENS, loadAllergenProfile, saveAllergenProfile } from '@/lib/allergens'

/**
 * Settings modal where the user picks which allergens to be alerted about.
 *
 * Stored in localStorage only — Alzhal never sends this list to the server.
 * The alert that appears on a scan result is computed entirely client-side
 * by matching against the analyzed ingredient names.
 */
export function AllergenSettings({ onClose }: { onClose: () => void }) {
    // Lazy initial state — `loadAllergenProfile` touches localStorage, which
    // is browser-only. The lazy form runs during the first client render of
    // this 'use client' component (never on the server), which both avoids
    // the setState-in-effect anti-pattern and skips a wasted re-render.
    const [selected, setSelected] = useState<Set<string>>(() => {
        if (typeof window === 'undefined') return new Set()
        return new Set(loadAllergenProfile())
    })

    const toggle = (key: string) => {
        setSelected(prev => {
            const next = new Set(prev)
            if (next.has(key)) next.delete(key)
            else next.add(key)
            return next
        })
    }

    const handleSave = () => {
        saveAllergenProfile([...selected])
        onClose()
    }

    const handleClear = () => {
        setSelected(new Set())
    }

    return (
        <div
            className="fixed inset-0 z-[100] bg-black/80 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4 animate-fade-in"
            onClick={onClose}
            role="dialog"
            aria-modal="true"
            aria-labelledby="allergen-modal-title"
        >
            <div
                className="relative bg-zinc-900 border border-zinc-800 rounded-t-2xl sm:rounded-2xl p-5 sm:p-6 max-w-md w-full max-h-[90vh] overflow-y-auto safe-bottom"
                onClick={e => e.stopPropagation()}
            >
                <div className="w-10 h-1 rounded-full bg-white/20 mx-auto sm:hidden mb-3" aria-hidden />
                <button
                    onClick={onClose}
                    aria-label="Close allergen settings"
                    className="absolute top-3 right-3 p-1.5 rounded-md text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-green-500/50"
                >
                    <X size={16} aria-hidden />
                </button>

                <div className="flex items-start gap-3 mb-4">
                    <div className="w-9 h-9 rounded-lg bg-amber-500/15 flex items-center justify-center flex-shrink-0">
                        <Heart size={18} className="text-amber-400" aria-hidden />
                    </div>
                    <div>
                        <h2 id="allergen-modal-title" className="text-base font-semibold text-white">
                            Your allergens
                        </h2>
                        <p className="text-xs text-zinc-500 mt-0.5 leading-relaxed">
                            Pick what you want flagged. Every scan will highlight matching ingredients at the top of the report.
                        </p>
                    </div>
                </div>

                <div className="bg-amber-500/[0.04] border border-amber-500/20 rounded-lg p-3 mb-4 flex items-start gap-2.5">
                    <AlertTriangle size={14} className="text-amber-400 flex-shrink-0 mt-0.5" aria-hidden />
                    <p className="text-[11px] text-amber-200/90 leading-relaxed">
                        This is a convenience filter, not a medical safety device.
                        Always cross-check the actual label and consult a doctor for severe allergies.
                    </p>
                </div>

                <fieldset className="space-y-1.5 mb-4">
                    <legend className="sr-only">Choose allergens to flag</legend>
                    {COMMON_ALLERGENS.map(allergen => {
                        const isActive = selected.has(allergen.key)
                        return (
                            <label
                                key={allergen.key}
                                className={`flex items-center justify-between p-2.5 rounded-lg border cursor-pointer transition ${
                                    isActive
                                        ? 'bg-amber-500/10 border-amber-500/30'
                                        : 'bg-zinc-950 border-zinc-800 hover:border-zinc-700'
                                }`}
                            >
                                <span className="text-sm text-zinc-200">{allergen.label}</span>
                                <input
                                    type="checkbox"
                                    checked={isActive}
                                    onChange={() => toggle(allergen.key)}
                                    className="w-4 h-4 accent-amber-500 cursor-pointer"
                                    aria-label={`Toggle ${allergen.label}`}
                                />
                            </label>
                        )
                    })}
                </fieldset>

                <div className="flex gap-2">
                    {selected.size > 0 && (
                        <button
                            onClick={handleClear}
                            className="px-4 py-2.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-sm text-zinc-300 transition active:scale-95"
                        >
                            Clear
                        </button>
                    )}
                    <button
                        onClick={handleSave}
                        className="flex-1 px-4 py-2.5 rounded-lg bg-green-600 hover:bg-green-700 text-white font-medium text-sm transition active:scale-95"
                        aria-label={selected.size > 0 ? `Save profile with ${selected.size} allergens` : 'Save (no allergens selected)'}
                    >
                        Save profile {selected.size > 0 && <span className="opacity-80">({selected.size})</span>}
                    </button>
                </div>
            </div>
        </div>
    )
}
