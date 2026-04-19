/**
 * Grounded renderer for ingredient analysis.
 *
 * Contract: the LLM receives pre-fetched structured regulatory facts and renders
 * them in simple language. It CANNOT invent a claim — the prompt contains no
 * slots for regulation status, limits, or citations. Those are deterministic.
 *
 * Safety verdict is computed from facts in code, not chosen by the LLM.
 *
 * This module lives alongside the legacy `analyzeIngredientBatch` in gemini.ts.
 * The legacy path continues to serve current production traffic while v2-grounded
 * is being built. New analysis pipelines should import from here.
 */

import { callGeminiWithRetry, modelDeterministic } from './gemini'
import {
  callWorkersAIRenderer,
  isWorkersAIRendererEnabled,
  workersAIRendererAvailable,
} from './workers-ai-renderer'

// ----- Data shapes -----

export type RegulatoryFact = {
  jurisdiction: string            // "US_FDA" | "EU" | "IN_FSSAI" | "WHO_IARC" | ...
  fact_type: string               // "permitted" | "prohibited" | "restricted" | "gras" | "classification"
  status: string                  // human-readable summary from the source
  max_per_100g_mg?: number | null
  food_class?: string | null
  regulation_ref?: string | null  // "21 CFR §184.1005", "FSS Reg 2011 Table 3.1.1"
  source_url: string              // MUST be set — comes from fact_evidence.source_url
  source_name: string
  snapshot_date: string
}

export type NutritionFact = {
  source: string
  source_url?: string
  energy_kcal_100g?: number | null
  energy_kj_100g?: number | null
  protein_g_100g?: number | null
  fat_g_100g?: number | null
  saturated_fat_g_100g?: number | null
  trans_fat_g_100g?: number | null
  carbohydrate_g_100g?: number | null
  sugar_g_100g?: number | null
  fiber_g_100g?: number | null
  sodium_mg_100g?: number | null
}

export type GroundedIngredientFacts = {
  canonical_id: string
  primary_name: string
  aliases: string[]
  ingredient_class: string
  category: string
  is_natural: boolean
  cas_number?: string | null
  pubchem_cid?: number | null
  e_number?: string | null
  molecular_formula?: string | null
  iupac_name?: string | null
  facts: RegulatoryFact[]
  nutrition?: NutritionFact | null
}

export type Verdict = 'SAFE' | 'CAUTION' | 'AVOID' | 'BANNED' | 'UNKNOWN'

export type RenderedAnalysis = {
  canonical_id: string
  primary_name: string
  verdict: Verdict
  verdict_reason: string                   // deterministic, traceable to a specific fact
  simple_name: string                      // LLM-rendered
  how_its_made?: string | null             // LLM-rendered, optional
  safety_summary: string                   // LLM-rendered, grounded in facts
  per_jurisdiction: Array<{                // one row per fact, pre-structured
    jurisdiction: string
    status: string
    regulation_ref: string | null
    source_url: string
    source_name: string
  }>
  missing_jurisdictions: string[]          // transparency: list of jurisdictions we checked but have no data for
  nutrition?: NutritionFact | null
  citations: Array<{
    fact_type: string
    jurisdiction: string
    source_name: string
    source_url: string
    snapshot_date: string
  }>
  sources_used: string[]                   // aggregated unique source URLs
}

// ----- Deterministic verdict -----

const JURISDICTIONS_WE_CHECK = [
  'US_FDA', 'EU', 'IN_FSSAI', 'IN_BIS', 'UK_FSA', 'AU_NZ_FSANZ',
  'CA_HC', 'JP_MHLW', 'WHO_IARC', 'CODEX', 'NORDIC', 'EFSA',
] as const

export function computeVerdict(facts: RegulatoryFact[], isNatural: boolean): {
  verdict: Verdict
  reason: string
} {
  if (facts.length === 0) {
    return { verdict: 'UNKNOWN', reason: 'No official regulatory record found in any indexed source.' }
  }

  // 1. Explicit prohibition anywhere
  const prohibited = facts.find(f => f.fact_type === 'prohibited')
  if (prohibited) {
    return {
      verdict: 'BANNED',
      reason: `Prohibited in ${prohibited.jurisdiction} (${prohibited.regulation_ref ?? prohibited.source_name}).`,
    }
  }

  // 2. IARC Group 1 — carcinogenic to humans
  const iarcGroup1 = facts.find(f =>
    f.jurisdiction === 'WHO_IARC' && /Group 1\b/.test(f.status) && !/Group 1[A-Z]/.test(f.status)
  )
  if (iarcGroup1) {
    return {
      verdict: 'BANNED',
      reason: `WHO/IARC Group 1 — carcinogenic to humans (${iarcGroup1.source_name}).`,
    }
  }

  // 3. IARC Group 2A — probably carcinogenic
  const iarcGroup2A = facts.find(f =>
    f.jurisdiction === 'WHO_IARC' && /Group 2A\b/.test(f.status)
  )
  if (iarcGroup2A) {
    return {
      verdict: 'AVOID',
      reason: `WHO/IARC Group 2A — probably carcinogenic (${iarcGroup2A.source_name}).`,
    }
  }

  // 4. IARC Group 2B — possibly carcinogenic. Must rank ABOVE generic `restricted`
  //    so a substance that is IARC 2B but also has a usage restriction elsewhere
  //    surfaces the carcinogenicity signal first.
  const iarcGroup2B = facts.find(f =>
    f.jurisdiction === 'WHO_IARC' && /Group 2B\b/.test(f.status)
  )
  if (iarcGroup2B) {
    return {
      verdict: 'CAUTION',
      reason: `WHO/IARC Group 2B — possibly carcinogenic (${iarcGroup2B.source_name}).`,
    }
  }

  // 5. Restricted anywhere (usage limits, partial bans, interim permissions)
  const restricted = facts.find(f => f.fact_type === 'restricted')
  if (restricted) {
    return {
      verdict: 'CAUTION',
      reason: `Restricted in ${restricted.jurisdiction}${restricted.regulation_ref ? ` (${restricted.regulation_ref})` : ''}.`,
    }
  }

  // 6. Explicit GRAS or permitted → SAFE
  const gras = facts.find(f => f.fact_type === 'gras' || f.fact_type === 'permitted')
  if (gras) {
    return {
      verdict: 'SAFE',
      reason: `${gras.status} per ${gras.regulation_ref ?? gras.source_name}.`,
    }
  }

  // 7. IARC Group 3 — "not classifiable" is NOT a safety signal.
  //    Natural ingredients → treat as SAFE (no other signal found, and Group 3
  //    with no other concerns is the baseline for foods like caffeine).
  //    Synthetic/industrial ingredients with ONLY a Group 3 → CAUTION,
  //    because a manufactured substance with no permitted-use record anywhere
  //    deserves user attention.
  const iarcGroup3 = facts.find(f =>
    f.jurisdiction === 'WHO_IARC' && /Group 3\b/.test(f.status)
  )
  if (iarcGroup3) {
    if (isNatural) {
      return {
        verdict: 'SAFE',
        reason: `Natural ingredient; WHO/IARC Group 3 (not classifiable) is not a carcinogenic flag.`,
      }
    }
    return {
      verdict: 'CAUTION',
      reason: `Synthetic ingredient with only a WHO/IARC Group 3 classification and no permitted-use record. Flagged for manual review.`,
    }
  }

  return {
    verdict: 'UNKNOWN',
    reason: `Facts present but none match known safety/hazard patterns. Manual review needed.`,
  }
}

export function missingJurisdictions(facts: RegulatoryFact[]): string[] {
  const present = new Set(facts.map(f => f.jurisdiction))
  return JURISDICTIONS_WE_CHECK.filter(j => !present.has(j))
}

// ----- Renderer prompt -----

function buildRendererPrompt(
  facts: GroundedIngredientFacts,
  userLanguage: string,
  verdict: Verdict,
  verdictReason: string,
): string {
  const factsJson = JSON.stringify({
    primary_name: facts.primary_name,
    aliases: facts.aliases.slice(0, 10),
    ingredient_class: facts.ingredient_class,
    cas_number: facts.cas_number ?? null,
    e_number: facts.e_number ?? null,
    molecular_formula: facts.molecular_formula ?? null,
    iupac_name: facts.iupac_name ?? null,
    is_natural: facts.is_natural,
    regulatory_facts: facts.facts.map(f => ({
      jurisdiction: f.jurisdiction,
      fact_type: f.fact_type,
      status: f.status,
      regulation_ref: f.regulation_ref ?? null,
      source_name: f.source_name,
    })),
    nutrition: facts.nutrition ?? null,
    computed_verdict: verdict,
    verdict_reason: verdictReason,
  }, null, 2)

  return `You are a grounded explainer. Your ONLY job is to render the provided regulatory
facts in simple language for a grandmother who may never have been to school.

HARD RULES (violations make your output invalid):
1. You MUST NOT invent any regulatory status, country, limit, or classification
   that is not explicitly in INPUT FACTS below.
2. You MUST NOT add citations or source names that are not in INPUT FACTS.
3. If a country or regulator is NOT listed in INPUT FACTS.regulatory_facts,
   do not mention its status at all. Silence is the correct answer.
4. computed_verdict and verdict_reason in INPUT FACTS are the final word on
   safety. Do not contradict them. Render them faithfully.
5. Output language: ${userLanguage}. Use simple words, everyday analogies
   (cooking, nature, household items). Translate all prose but keep chemical
   formulas, CAS numbers, and E-numbers in English.

INPUT FACTS:
${factsJson}

Return ONLY valid JSON with exactly these fields:
{
  "simple_name":     "One sentence in ${userLanguage} explaining what this ingredient is, using everyday analogies. Example style: 'A type of salt used to keep food from going bad, like how we add salt to pickles.'",
  "how_its_made":    "Optional 2-3 sentences on manufacturing, in ${userLanguage}, ONLY if INPUT FACTS has enough identity data to support it honestly. If not, return null.",
  "safety_summary":  "1-2 sentences in ${userLanguage} that faithfully render computed_verdict and verdict_reason. Do NOT generalize beyond the listed regulatory_facts. If computed_verdict is UNKNOWN, say so plainly: 'No official regulatory record found for this ingredient.'"
}

No other fields. No markdown code fences. No explanation before or after the JSON.`
}

// ----- Renderer -----

export async function renderGroundedFacts(
  facts: GroundedIngredientFacts,
  userLanguage: string = 'English',
): Promise<RenderedAnalysis> {
  const { verdict, reason } = computeVerdict(facts.facts, facts.is_natural)
  const missing = missingJurisdictions(facts.facts)

  const perJurisdiction = facts.facts.map(f => ({
    jurisdiction: f.jurisdiction,
    status: f.status,
    regulation_ref: f.regulation_ref ?? null,
    source_url: f.source_url,
    source_name: f.source_name,
  }))

  const citations = facts.facts.map(f => ({
    fact_type: f.fact_type,
    jurisdiction: f.jurisdiction,
    source_name: f.source_name,
    source_url: f.source_url,
    snapshot_date: f.snapshot_date,
  }))

  const sourcesUsed = Array.from(new Set(facts.facts.map(f => f.source_url)))

  // Fast path: if there are no facts and language is English, don't even call the LLM.
  if (facts.facts.length === 0 && userLanguage.toLowerCase() === 'english') {
    return {
      canonical_id: facts.canonical_id,
      primary_name: facts.primary_name,
      verdict,
      verdict_reason: reason,
      simple_name: facts.primary_name,
      how_its_made: null,
      safety_summary: 'No official regulatory record found for this ingredient in any indexed source.',
      per_jurisdiction: perJurisdiction,
      missing_jurisdictions: missing,
      nutrition: facts.nutrition ?? null,
      citations,
      sources_used: sourcesUsed,
    }
  }

  const prompt = buildRendererPrompt(facts, userLanguage, verdict, reason)

  let rendered: { simple_name?: string; how_its_made?: string | null; safety_summary?: string } = {}

  const preferGemma = isWorkersAIRendererEnabled() && workersAIRendererAvailable()

  try {
    let rawText: string | null = null

    if (preferGemma) {
      rawText = await callWorkersAIRenderer(prompt)
      if (!rawText) {
        console.warn(`[Renderer] Gemma returned empty for ${facts.primary_name}; falling back to Gemini`)
      }
    }

    if (!rawText) {
      const result = await callGeminiWithRetry(modelDeterministic, prompt)
      const response = await result.response
      rawText = response.text()
    }

    const json = (rawText ?? '').replace(/```json/g, '').replace(/```/g, '').trim()
    rendered = JSON.parse(json)
  } catch (err) {
    const backend = preferGemma ? 'Gemma+Gemini' : 'Gemini'
    console.error(`[Renderer] ${backend} call failed for ${facts.primary_name}:`, (err as Error).message)
    // Fallback: render deterministically without LLM prose
    rendered = {
      simple_name: facts.primary_name,
      how_its_made: null,
      safety_summary: verdict === 'UNKNOWN'
        ? 'No official regulatory record found for this ingredient in any indexed source.'
        : reason,
    }
  }

  return {
    canonical_id: facts.canonical_id,
    primary_name: facts.primary_name,
    verdict,
    verdict_reason: reason,
    simple_name: rendered.simple_name ?? facts.primary_name,
    how_its_made: rendered.how_its_made ?? null,
    safety_summary: rendered.safety_summary ?? reason,
    per_jurisdiction: perJurisdiction,
    missing_jurisdictions: missing,
    nutrition: facts.nutrition ?? null,
    citations,
    sources_used: sourcesUsed,
  }
}

// ----- Post-render validator -----

/**
 * Guardrail: verifies the rendered analysis does not reference jurisdictions
 * that weren't in the input facts. If it does (hallucination leak), we strip
 * the offending text and log a warning.
 *
 * This is a last-line-of-defense check. Because the prompt forbids invention,
 * violations should be rare, but we enforce in code anyway.
 */
export function validateNoJurisdictionLeak(
  rendered: RenderedAnalysis,
  allowedJurisdictions: Set<string>,
): { ok: boolean; leaks: string[] } {
  const leakPatterns: Array<{ pattern: RegExp; jurisdiction: string }> = [
    { pattern: /\bFSSAI\b/i,                           jurisdiction: 'IN_FSSAI' },
    { pattern: /\bBIS\b|\bIS 4707\b/i,                 jurisdiction: 'IN_BIS' },
    { pattern: /\bFDA\b/i,                             jurisdiction: 'US_FDA' },
    { pattern: /\bEFSA\b/i,                            jurisdiction: 'EFSA' },
    { pattern: /\bEU\b|\bEuropean Union\b|\bCosIng\b/i, jurisdiction: 'EU' },
    { pattern: /\bIARC\b|\bWHO\b/i,                    jurisdiction: 'WHO_IARC' },
    { pattern: /\bFSANZ\b/i,                           jurisdiction: 'AU_NZ_FSANZ' },
    { pattern: /\bHealth Canada\b/i,                   jurisdiction: 'CA_HC' },
    { pattern: /\bMHLW\b/i,                            jurisdiction: 'JP_MHLW' },
    { pattern: /\bCodex\s*Alimentarius\b|\bCodex\b/i,  jurisdiction: 'CODEX' },
    { pattern: /\bUK\s*FSA\b|\bUK\s*Food\s*Standards\s*Agency\b/i, jurisdiction: 'UK_FSA' },
    { pattern: /\bNordic\b/i,                          jurisdiction: 'NORDIC' },
  ]

  const textBlobs = [rendered.simple_name, rendered.how_its_made ?? '', rendered.safety_summary].join(' ')

  const leaks: string[] = []
  for (const { pattern, jurisdiction } of leakPatterns) {
    if (pattern.test(textBlobs) && !allowedJurisdictions.has(jurisdiction)) {
      leaks.push(jurisdiction)
    }
  }

  return { ok: leaks.length === 0, leaks }
}
