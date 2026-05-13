import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

// `initOpenNextCloudflareForDev` wires up local Cloudflare bindings (D1, R2,
// AI) for `next dev`. It must NOT run during production builds — it tries to
// open a remote-proxy session to Cloudflare which requires `wrangler login`
// and fails in unauthenticated CI environments.
if (process.env.NODE_ENV !== 'production' && !process.env.CI) {
  initOpenNextCloudflareForDev();
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    unoptimized: false,
  },
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          // X-XSS-Protection is deprecated and has been removed from modern
          // browsers; the legacy XSS auditor has shipped its own bugs.
          // CSP (below) is the actual XSS defense.
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'geolocation=(), microphone=(), camera=()' },
          { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
          {
            key: 'Content-Security-Policy',
            value: "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self' https:; frame-ancestors 'none'",
          },
        ],
      },
    ]
  },
}

export default nextConfig
