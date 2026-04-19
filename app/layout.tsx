import type { Metadata, Viewport } from 'next'
import { Inter, Fraunces } from 'next/font/google'
import './globals.css'

const inter = Inter({
    subsets: ['latin'],
    display: 'swap',
    variable: '--font-inter',
})

const fraunces = Fraunces({
    subsets: ['latin'],
    display: 'swap',
    variable: '--font-fraunces',
    axes: ['opsz'],
})

export const metadata: Metadata = {
    title: 'Alzhal — What is actually in it?',
    description: 'Scan a product label. Get a grounded safety read backed by FDA, EU, WHO, FSSAI, and IARC — not AI guesses. Photo, text, or voice.',
    keywords: ['ingredient analysis', 'label scanner', 'food safety', 'cosmetic safety', 'FDA', 'FSSAI', 'IARC', 'product ingredients'],
    authors: [{ name: 'Alzhal' }],
    openGraph: {
        title: 'Alzhal — What is actually in it?',
        description: 'A grounded ingredient read against real regulators. No wellness guesswork.',
        type: 'website',
    },
}

export const viewport: Viewport = {
    width: 'device-width',
    initialScale: 1,
    maximumScale: 1,
    themeColor: '#FAF9F5',
}

export default function RootLayout({
    children,
}: {
    children: React.ReactNode
}) {
    return (
        <html lang="en" className={`${inter.variable} ${fraunces.variable}`}>
            <body className={inter.className}>{children}</body>
        </html>
    )
}
