import { ImageResponse } from 'next/og'

/**
 * Dynamic app icon — rendered as a 512×512 PNG by Next.js at build time so
 * we don't need to check binary icon files into the repo. Used by:
 *   - Browser tab favicon
 *   - PWA home-screen icon (manifest.ts points at /icon)
 *   - iOS apple-touch-icon equivalent
 *
 * The mark itself is a stylised "A" in the brand terracotta on the dark
 * background that matches the app's navbar — the goal is for the OS to
 * pick up a contrast-friendly icon without the user noticing.
 */
export const size = { width: 512, height: 512 }
export const contentType = 'image/png'

export default function Icon() {
    return new ImageResponse(
        (
            <div
                style={{
                    width: '100%',
                    height: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    background: '#09090b',
                    color: '#D97757',
                    fontSize: 340,
                    fontWeight: 700,
                    letterSpacing: '-0.04em',
                    fontFamily: 'system-ui, sans-serif',
                }}
            >
                A
            </div>
        ),
        { ...size },
    )
}
