# Alzhal

**Know what you consume.** Snap a photo of any food, cosmetic, or household product label. Alzhal reads it, looks up every ingredient against official regulators (FDA, EU, WHO/IARC, FSSAI, Health Canada, FSANZ, EFSA, and more), and answers in plain language.

No AI guessing. Every safety claim links back to a specific regulation.

## Languages

- **English** is the primary language. All static UI text and hardcoded copy is in English.
- **12 additional languages** are exposed in the language picker: Hindi, Tamil, Telugu, Kannada, Bengali, Marathi, Gujarati, Punjabi, Malayalam, Odia, Assamese, Urdu.
- These 12 additional languages are handled uniformly as a group: when a user selects one, the dynamic content (ingredient explanations, voice replies, follow-up answers) is translated at runtime by the AI layer. Static UI labels stay in English regardless — see the translation policy in `CONTRIBUTING.md` for why we do not hardcode unverified translations.

[![CI](https://github.com/quantumsequrity/alzhal/actions/workflows/ci.yml/badge.svg)](https://github.com/quantumsequrity/alzhal/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache_2.0-blue.svg)](LICENSE)
[![Built on Cloudflare Workers](https://img.shields.io/badge/runs%20on-Cloudflare%20Workers-orange)](https://workers.cloudflare.com)
[![Next.js 16](https://img.shields.io/badge/Next.js-16-black)](https://nextjs.org)

---

## What it does

- **Snap a label.** Take a picture of the ingredient list. Alzhal reads it with three OCR engines in parallel and picks the highest-confidence result.
- **Or type it.** Paste an ingredient list. Or type a product name (e.g. "Maggi noodles") and Alzhal will find it.
- **Or ask out loud.** Record a voice note. Alzhal transcribes it, answers, and reads the answer back to you.
- **Get a plain answer.** Every ingredient gets a green / yellow / red verdict, a one-line reason, and a "what this means for you" tip.
- **See the evidence.** Every verdict has a link to the actual regulation. You can verify any claim in one click.

Works on the web, on WhatsApp, and on Telegram. Same engine, same answers.

## How safety verdicts are decided

Most "AI safety" tools are an LLM hallucinating regulations. Alzhal is the opposite: the regulator data is fetched first, the verdict is computed by deterministic rules in code, and the LLM only writes the human-readable summary.

```
1. OCR (Gemini Vision + Workers AI + Tesseract → best result wins)
2. For each ingredient:
   a. Look it up in the canonical ingredient graph (CAS / E-number / aliases)
   b. Fetch every regulatory fact attached to that canonical ID
      (FDA, EU, FSSAI, WHO/IARC, Health Canada, FSANZ, EFSA, Codex, etc.)
   c. Compute verdict deterministically:
        - Prohibited anywhere       → BANNED
        - IARC Group 1              → BANNED (carcinogenic to humans)
        - IARC Group 2A             → AVOID  (probably carcinogenic)
        - IARC Group 2B             → CAUTION (possibly carcinogenic)
        - Restricted use anywhere   → CAUTION
        - GRAS / explicitly permitted → SAFE
        - No record                 → UNKNOWN (no claim made)
   d. The LLM writes a plain-language summary of the facts.
      The prompt has no slots for inventing limits, references, or claims.
3. Render — each verdict ships with the regulation URL it came from.
```

If a regulator has no opinion on an ingredient, Alzhal says "no record" instead of guessing.

## Data sources

| Source | What we use | License / Terms |
|---|---|---|
| **U.S. FDA** (CFR Title 21, OpenFDA recalls, OpenFDA adverse events) | GRAS list, food additive limits, color additives, cosmetic regulations | Public domain |
| **EU CosIng + Regulation 1333/2008** | Cosmetic ingredient bans/restrictions; food additive Annex II/III | EU public sector data |
| **EFSA OpenFoodTox** | EU scientific risk assessments | CC BY 4.0 |
| **WHO / IARC Monographs** | Carcinogenicity classifications (Group 1, 2A, 2B, 3) | WHO Press (attribution) |
| **Codex Alimentarius (GSFA)** | International food standards | WHO/FAO public |
| **FSSAI** (India) | Indian food additive limits, permitted ingredients | Government of India |
| **BIS IS 4707** (India) | Cosmetic ingredient safety in India | Bureau of Indian Standards |
| **Health Canada Cosmetic Ingredient Hotlist** | Canadian cosmetic prohibitions/restrictions | Open Government Licence – Canada |
| **FSANZ** | Australia/New Zealand food code | CC BY 3.0 AU |
| **USDA FoodData Central** | Nutrition data | Public domain |
| **CAS Common Chemistry** | Chemical identity (CAS Registry Numbers) | Attribution, non-commercial |
| **PubChem** (NIH) | Molecular formulas, IUPAC names, CIDs | Public domain |
| **EPA CompTox Dashboard** | Chemical toxicity profiles (link-out) | Public domain |
| **Open Food Facts / Open Beauty Facts** | Global product database, additives, allergens, NOVA | ODbL 1.0 (contents under DbCL) |

See [`NOTICE`](NOTICE) and [`DATA_LICENSE.md`](DATA_LICENSE.md) for full attribution requirements.

## Tech stack

| Layer | Choice | Why |
|---|---|---|
| Framework | Next.js 16 (App Router) + TypeScript | One codebase, one deploy |
| Hosting | Cloudflare Workers via `@opennextjs/cloudflare` | Edge runtime, no servers |
| Database | Cloudflare D1 (×5: app, food, nutrition, meta, ingredients-ref) | SQLite at the edge |
| Object storage | Cloudflare R2 | TTS audio replies |
| AI (vision + text) | Google Gemini 2.0 Flash | OCR + voice + analysis |
| AI (grounded renderer) | Cloudflare Workers AI — Gemma 4 (with Gemini fallback) | Plain-language rendering of structured facts |
| OCR | Gemini Vision + Workers AI + Tesseract.js | Triple-source confidence merge |
| TTS | google-tts-api | Audio replies on WhatsApp |
| Messaging | Meta WhatsApp Cloud API + Telegram Bot API | Native bots |
| Styling | Tailwind CSS v4 | |

## Project layout

```
app/
├── api/                # Next.js route handlers
│   ├── analyze/
│   │   ├── image/      # photo → OCR → analysis
│   │   ├── nutrition/  # nutrition-panel OCR
│   │   ├── text/       # paste ingredients → analysis
│   │   └── voice/      # voice → STT → answer → TTS
│   ├── audio/[id]/     # serve TTS audio from R2
│   ├── compare/        # side-by-side product comparison
│   ├── cron/           # scheduled jobs (FDA sync)
│   ├── feedback/       # user feedback
│   ├── question/       # follow-up Q&A
│   ├── search/         # product / ingredient search
│   ├── share/          # share a result
│   ├── stats/          # live usage stats
│   ├── telegram/       # Telegram webhook + setup
│   └── whatsapp/       # Meta WhatsApp webhook
├── globals.css
├── layout.tsx
└── page.tsx            # web UI

components/
├── AnalysisResult.tsx       # main result view (legacy + grounded blend)
├── FileUpload.tsx           # drag-drop upload
├── ComparisonView.tsx       # side-by-side product compare
├── LiveStats.tsx            # real-time usage counter
├── TrendingWidget.tsx       # most-scanned products
└── grounded/                # v2-grounded UI primitives
    ├── GroundedIngredientCard.tsx
    ├── NutritionPanel.tsx
    ├── PerJurisdictionTable.tsx
    └── VerdictBadge.tsx

lib/
├── analysis.ts              # legacy heuristic pipeline
├── analysis-grounded.ts     # v2: structural no-hallucination pipeline
├── audio-store.ts           # R2 / in-memory audio storage
├── cache.ts                 # in-memory cache with TTL
├── db.ts                    # D1 client
├── external-data.ts         # CAS, FDA, EPA, PubChem, OFF + circuit breakers
├── format-response.ts       # shared bot-message formatter
├── gemini.ts                # Gemini integration + prompts
├── gemini-renderer.ts       # grounded renderer (no-hallucination prose)
├── nutrition-ocr.ts         # nutrition-panel structured extraction
├── ocr-merge.ts             # merge Gemini + Workers AI + Tesseract outputs
├── product-data.ts          # local CSV lookups (FDA / OFF)
├── security.ts              # rate limiting, sanitization, injection guards
├── telegram.ts              # Telegram Bot API client
├── tts.ts                   # text-to-speech
├── whatsapp.ts              # Meta WhatsApp Cloud API client
├── workers-ai-ocr.ts        # Workers AI OCR
└── workers-ai-renderer.ts   # Gemma renderer

scripts/                     # D1 schemas, ingestion, seeders
docs/                        # architecture and setup notes
tests/fixtures/              # sample test images
```

## Getting started

### Prerequisites

- Node.js 20 (see `.nvmrc`)
- A Cloudflare account (free tier works for dev)
- A Google AI Studio API key — [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey)
- *(Optional)* A Meta Business account with WhatsApp Cloud API access — [developers.facebook.com/apps](https://developers.facebook.com/apps/)
- *(Optional)* A Telegram bot token via [@BotFather](https://t.me/BotFather)

### 1. Install

```bash
git clone https://github.com/quantumsequrity/alzhal.git
cd alzhal
npm install
```

### 2. Environment

Copy the example file and fill in only what you need.

```bash
cp .env.example .env.local
```

Required for any deploy:
```
GEMINI_API_KEY=...
```

Optional (only if you want the bot integrations):
```
WHATSAPP_TOKEN=...
WHATSAPP_PHONE_NUMBER_ID=...
WHATSAPP_VERIFY_TOKEN=...
WHATSAPP_APP_SECRET=...
TELEGRAM_BOT_TOKEN=...
```

### 3. Run locally

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). The web UI works without WhatsApp/Telegram secrets.

### 4. Cloudflare resources (when ready to deploy)

```bash
# Create D1 databases (write down the IDs each prints)
npx wrangler d1 create alzhal-app
npx wrangler d1 create alzhal-food
npx wrangler d1 create alzhal-nutrition
npx wrangler d1 create alzhal-meta
npx wrangler d1 create alzhal-ingredients-ref

# Create R2 bucket
npx wrangler r2 bucket create alzhal-audio
```

Paste the five `database_id` values into `wrangler.toml`, replacing every `REPLACE_WITH_YOUR_D1_DATABASE_ID`.

Apply the schemas:

```bash
npx wrangler d1 execute alzhal-app                --file=scripts/d1-app-schema.sql
npx wrangler d1 execute alzhal-ingredients-ref    --file=scripts/d1-ingredients-ref-schema.sql
npx wrangler d1 execute alzhal-ingredients-ref    --file=scripts/d1-regulatory-schema.sql
# The food / nutrition / meta databases are populated by the seeder scripts
# under scripts/seed-*.py and scripts/import-*.ts (see docs/setup/).
```

### 5. Secrets (production)

```bash
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put WHATSAPP_TOKEN          # optional
npx wrangler secret put WHATSAPP_APP_SECRET     # optional
npx wrangler secret put TELEGRAM_BOT_TOKEN      # optional
```

### 6. Deploy

```bash
npm run deploy
```

### WhatsApp setup (optional)

1. In Meta for Developers, create an app → add the **WhatsApp** product.
2. Copy the test number's Phone Number ID and the temporary access token into your secrets.
3. Set the webhook URL to `https://<your-worker>.workers.dev/api/whatsapp/webhook` with the verify token you chose.
4. Subscribe to the `messages` event.
5. Add your own phone in the Meta test console and send a label photo.

Meta's free tier includes 1,000 business-initiated conversations/month; user-initiated conversations to your number are always free to receive.

### Telegram setup (optional)

```bash
curl -F "url=https://<your-worker>.workers.dev/api/telegram/webhook" \
     "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook"
```

Send a photo to your bot.

## Security posture

Alzhal handles untrusted input from three webhook surfaces. Worth knowing:

- **Webhook signature verification** — Meta WhatsApp webhooks use HMAC-SHA256 (`X-Hub-Signature-256`) verified against `WHATSAPP_APP_SECRET`. Requests without a valid signature are dropped.
- **Rate limiting** — In-memory per-IP / per-phone limits in [`lib/security.ts`](lib/security.ts). The store self-evicts so a single Worker instance cannot be memory-exhausted.
- **Input sanitization** — Ingredient names are stripped of control chars, prompt-injection delimiters, and XML tags before going to Gemini. SQL-injection patterns are rejected at the boundary.
- **Origin checks** — Browser API routes require a same-origin `Origin` / `Referer`. Webhooks (which legitimately come from third parties) are signature-verified instead.
- **SSRF protection** — All outbound HTTP fetches go through allowlist hosts; user-supplied URLs are not directly followed.
- **Circuit breakers** — CAS / FDA / PubChem auto-pause after 3 consecutive failures (5-minute cooldown).
- **Determinism over guessing** — The pipeline cannot fabricate a regulatory claim. If no fact exists, the UI says "no record". This is a security property as much as a UX one.
- **No telemetry to third parties** — Alzhal does not ship analytics to anyone outside your Cloudflare account. Logs go to your Workers logs only.

Reporting a vulnerability: please open a private security advisory on GitHub rather than a public issue.

## Architecture highlights

- **Two-layer verification** — Deterministic external-API data fetched first, then Gemini sees only structured context. See [`Architecture.md`](Architecture.md).
- **Grounded renderer** — Behind a `USE_GROUNDED_RENDERER` flag, ingredient analysis is served from indexed regulatory facts with mandatory source URLs. The LLM is a renderer, not an oracle.
- **Multi-source OCR merge** — Gemini Vision + Workers AI + client Tesseract. Best-confidence result per field wins; orphaned E-numbers are rejoined.
- **Batched analysis** — 8 ingredients per Gemini call, 3-second gap between batches to respect rate limits.
- **Edge nutrition OCR** — Nutrition-panel extraction is structured (transcribed, not inferred) and surfaces the source label format separately from the values.

## Roadmap

- [ ] ANVISA (Brazil) and MFDS (Korea) regulatory ingesters
- [ ] First-party allergen-profile mode (set your allergens once, every scan warns you)
- [ ] Offline ingredient lookup for the most-scanned 50K substances
- [ ] Native mobile (Android first) wrapping the same Workers backend

## Contributing

Contributions are welcome — especially regulatory ingesters for jurisdictions we don't yet cover, and translations of UI strings.

1. Open an issue describing the change.
2. Fork → branch → PR. Keep PRs focused.
3. Run `npm run typecheck` and `npm run lint` before pushing.
4. By contributing, you agree your contribution is licensed under Apache 2.0.

## License

Source code: **Apache License 2.0** — see [`LICENSE`](LICENSE).
Third-party data: **see each source's terms**, summarised in [`NOTICE`](NOTICE) and [`DATA_LICENSE.md`](DATA_LICENSE.md).
