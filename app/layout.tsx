import type { Metadata, Viewport } from 'next'
import { Inter, Fraunces } from 'next/font/google'
import './globals.css'
import { ToastProvider } from '@/components/Toast'

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
    title: 'Alzhal - What is actually in it?',
    description: 'Scan a product label. Get a grounded safety read backed by FDA, EU, WHO, FSSAI, and IARC - not AI guesses. Photo, text, or voice.',
    keywords: ['ingredient analysis', 'label scanner', 'food safety', 'cosmetic safety', 'FDA', 'FSSAI', 'IARC', 'product ingredients'],
    authors: [{ name: 'Alzhal' }],
    applicationName: 'Alzhal',
    appleWebApp: {
        capable: true,
        title: 'Alzhal',
        statusBarStyle: 'black-translucent',
    },
    formatDetection: {
        telephone: false,
    },
    openGraph: {
        title: 'Alzhal - What is actually in it?',
        description: 'A grounded ingredient read against real regulators. No wellness guesswork.',
        type: 'website',
    },
}

export const viewport: Viewport = {
    width: 'device-width',
    initialScale: 1,
    // Theme color matches the dark navbar so the iOS / Android status bar
    // blends in when the app is installed to the home screen.
    themeColor: '#09090b',
    // viewportFit=cover lets the safe-bottom utility actually reach the
    // home-indicator area on notched iPhones.
    viewportFit: 'cover',
}

export default function RootLayout({
    children,
}: {
    children: React.ReactNode
}) {
    return (
        <html lang="en" className={`${inter.variable} ${fraunces.variable}`}>
            <body className={inter.className}>
                <ToastProvider>{children}</ToastProvider>
            </body>
        </html>
    )
}
