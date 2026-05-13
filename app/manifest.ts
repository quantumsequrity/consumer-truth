import type { MetadataRoute } from 'next'

/**
 * PWA web manifest.
 *
 * Lets users install Alzhal to their home screen on iOS, Android, and
 * desktop Chrome/Edge. Once installed it opens in a standalone window
 * with no browser chrome — closer to a native app feel for a tool people
 * use while standing in a supermarket aisle.
 *
 * Icons are generated dynamically by app/icon.tsx so we don't need to
 * check binary files into the repo. Theme color matches the dark navbar
 * so the OS status bar blends in.
 */
export default function manifest(): MetadataRoute.Manifest {
    return {
        name: 'Alzhal — what is actually in it?',
        short_name: 'Alzhal',
        description: 'Regulation-grounded ingredient safety. Scan a label, get a plain-language verdict backed by FDA, EU, WHO/IARC and more.',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'portrait-primary',
        background_color: '#09090b',
        theme_color: '#09090b',
        categories: ['health', 'food', 'lifestyle', 'utilities'],
        // Icons are served by app/icon.tsx via Next.js's file-based icon
        // convention; we point at the same SVG-derived URL for each size.
        icons: [
            { src: '/icon', sizes: '192x192', type: 'image/png', purpose: 'any' },
            { src: '/icon', sizes: '512x512', type: 'image/png', purpose: 'any' },
            { src: '/icon', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
        ],
    }
}
