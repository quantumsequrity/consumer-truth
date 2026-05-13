'use client'

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { CheckCircle2, AlertCircle, Info, X } from 'lucide-react'

/**
 * Tiny toast notification system.
 *
 * The codebase used to either alert() (terrible UX, blocks the page) or
 * silently swallow user-visible events ("copied!", "feedback saved").
 * This component is the unified surface — a stacking, auto-dismissing,
 * dismissible-by-tap card that announces itself via aria-live for screen
 * readers. No external dependency.
 */

export type ToastKind = 'success' | 'error' | 'info'
export interface ToastInput {
    kind?: ToastKind
    message: string
    /** Auto-dismiss in ms. Default 3500. Set to 0 to require manual dismiss. */
    durationMs?: number
}
interface ToastEntry extends ToastInput {
    id: string
    createdAt: number
}

interface ToastContextValue {
    toast: (input: ToastInput) => void
}

const ToastContext = createContext<ToastContextValue | null>(null)

export function useToast(): ToastContextValue {
    const ctx = useContext(ToastContext)
    if (!ctx) {
        // Render-safe no-op fallback so components don't crash if the provider
        // isn't mounted (e.g. during SSR snapshot, tests).
        return { toast: () => {} }
    }
    return ctx
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
    const [toasts, setToasts] = useState<ToastEntry[]>([])
    const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

    const dismiss = useCallback((id: string) => {
        setToasts(prev => prev.filter(t => t.id !== id))
        const timer = timersRef.current.get(id)
        if (timer) {
            clearTimeout(timer)
            timersRef.current.delete(id)
        }
    }, [])

    const toast = useCallback((input: ToastInput) => {
        const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
        const entry: ToastEntry = {
            id,
            kind: input.kind || 'info',
            message: input.message,
            durationMs: input.durationMs ?? 3500,
            createdAt: Date.now(),
        }

        setToasts(prev => {
            // Cap visible stack at 4; oldest falls off.
            const next = [...prev, entry]
            return next.length > 4 ? next.slice(-4) : next
        })

        if (entry.durationMs && entry.durationMs > 0) {
            const timer = setTimeout(() => dismiss(id), entry.durationMs)
            timersRef.current.set(id, timer)
        }
    }, [dismiss])

    useEffect(() => {
        const timers = timersRef.current
        return () => { timers.forEach(t => clearTimeout(t)); timers.clear() }
    }, [])

    return (
        <ToastContext.Provider value={{ toast }}>
            {children}
            {/* Live region for assistive tech. Visually invisible. */}
            <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
                {toasts.length > 0 && toasts[toasts.length - 1].message}
            </div>

            <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[200] flex flex-col gap-2 pointer-events-none px-4 w-full max-w-sm">
                {toasts.map(t => {
                    const tone =
                        t.kind === 'success' ? 'bg-green-500/15 border-green-500/30 text-green-300'
                        : t.kind === 'error' ? 'bg-red-500/15 border-red-500/30 text-red-300'
                        : 'bg-zinc-800 border-zinc-700 text-zinc-200'
                    const Icon = t.kind === 'success' ? CheckCircle2 : t.kind === 'error' ? AlertCircle : Info
                    return (
                        <div
                            key={t.id}
                            className={`pointer-events-auto flex items-start gap-2.5 px-3.5 py-2.5 rounded-xl border backdrop-blur-md text-sm shadow-lg animate-fade-in ${tone}`}
                        >
                            <Icon size={16} className="flex-shrink-0 mt-0.5" />
                            <span className="flex-1 leading-snug">{t.message}</span>
                            <button
                                onClick={() => dismiss(t.id)}
                                aria-label="Dismiss notification"
                                className="opacity-60 hover:opacity-100 transition flex-shrink-0"
                            >
                                <X size={14} />
                            </button>
                        </div>
                    )
                })}
            </div>
        </ToastContext.Provider>
    )
}
