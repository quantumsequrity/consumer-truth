/**
 * Grounded ingredient analysis — the feature-flagged v2 pipeline.
 *
 * On `USE_GROUNDED_RENDERER=true` AND when the REGULATORY_DB D1 binding is
 * present, this module resolves an ingredient name to its canonical row,
 * fetches all active regulatory facts with their source URLs, calls the
 * grounded renderer, and runs the jurisdiction-leak validator.
 *
 * Safe to import in any environment. If the flag is off, the binding is
 * missing, or the ingredient is unknown, returns null. Callers must fall
 * back to the legacy pipeline in that case.
 *
 * Integration point (in lib/analysis.ts): before the existing Gemini call,
 * call `maybeAnalyzeIngredientGrounded(name, language)`. If it returns
 * non-null, use that result and skip the legacy call.
 */

import {
  renderGroundedFacts,
  validateNoJurisdictionLeak,
  type GroundedIngredientFacts,
  type NutritionFact,
  type RegulatoryFact,
  type RenderedAnalysis,
} from './gemini-renderer'

// --- D1 types (mirror lib/db.ts) ---

interface D1Database {
  prepare(query: string): D1PreparedStatement
}
interface D1PreparedStatement {
  bind(...values: any[]): D1PreparedStatement
  all<T = Record<string, unknown>>(): Promise<{ results: T[]; success: boolean }>
  first<T = Record<string, unknown>>(): Promise<T | null>
  run(): Promise<{ success: boolean }>
}

function getRegulatoryDb(): D1Database | null {
  try {
    const { getCloudflareContext } = require('@opennextjs/cloudflare')
    const { env } = getCloudflareContext()
    // CIG tables coexist with legacy ingredient_reference in the same D1.
    // Prefer a dedicated REGULATORY_DB binding if present, else use INGREDIENTS_REF_DB.
    return env?.REGULATORY_DB || env?.INGREDIENTS_REF_DB || null
  } catch {
    return null
  }
}

function cfVar(name: string): string | undefined {
  // On Workers the wrangler [vars] block and secrets live on the Cloudflare
  // env binding, not always on Node's process.env. Read both and prefer the
  // binding when present.
  try {
    const { getCloudflareContext } = require('@opennextjs/cloudflare')
    const { env } = getCloudflareContext()
    if (env && typeof env[name] === 'string') return env[name] as string
  } catch {
    // Cloudflare context not available (local dev / build-time) — fall through.
  }
  return process.env[name]
}

export function groundedEnabled(): boolean {
  return cfVar('USE_GROUNDED_RENDERER') === 'true'
}

function normalizeAliasClientSide(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim()
}

// --- DB row shapes ---

interface IngredientRow {
  canonical_id: string
  primary_name: string
  ingredient_class: string
  cas_number: string | null
  pubchem_cid: number | null
  e_number: string | null
  molecular_formula: string | null
  molecular_weight: number | null
  iupac_name?: string | null
  category: string
  is_natural: number
}

interface FactRow {
  jurisdiction: string
  fact_type: string
  status: string
  max_per_100g_mg: number | null
  food_class: string | null
  product_category: string | null
  regulation_ref: string | null
  source_url: string
  source_name: string
  snapshot_date: string
}

interface NutritionRow {
  source: string
  source_food_id: string | null
  energy_kcal_100g: number | null
  energy_kj_100g: number | null
  protein_g_100g: number | null
  fat_g_100g: number | null
  saturated_fat_g_100g: number | null
  carbohydrate_g_100g: number | null
  sugar_g_100g: number | null
  fiber_g_100g: number | null
  sodium_mg_100g: number | null
  source_url: string | null
}

// --- Lookups ---

async function resolveCanonicalId(db: D1Database, name: string): Promise<string | null> {
  const normalized = normalizeAliasClientSide(name)
  if (!normalized) return null

  const row = await db
    .prepare('SELECT canonical_id FROM ingredient_alias WHERE alias_normalized = ? LIMIT 1')
    .bind(normalized)
    .first<{ canonical_id: string }>()

  if (row?.canonical_id) return row.canonical_id

  // Fallback: exact primary_name match (case-insensitive)
  const ingr = await db
    .prepare('SELECT canonical_id FROM ingredient WHERE LOWER(primary_name) = LOWER(?) LIMIT 1')
    .bind(name.trim())
    .first<{ canonical_id: string }>()

  return ingr?.canonical_id ?? null
}

async function fetchIngredient(db: D1Database, canonicalId: string): Promise<IngredientRow | null> {
  return db
    .prepare('SELECT canonical_id, primary_name, ingredient_class, cas_number, pubchem_cid, e_number, molecular_formula, molecular_weight, category, is_natural FROM ingredient WHERE canonical_id = ? LIMIT 1')
    .bind(canonicalId)
    .first<IngredientRow>()
}

async function fetchAliases(db: D1Database, canonicalId: string): Promise<string[]> {
  const result = await db
    .prepare('SELECT alias FROM ingredient_alias WHERE canonical_id = ? ORDER BY confidence DESC LIMIT 15')
    .bind(canonicalId)
    .all<{ alias: string }>()
  return (result.results || []).map(r => r.alias)
}

async function fetchFacts(db: D1Database, canonicalId: string): Promise<RegulatoryFact[]> {
  const result = await db
    .prepare(`
      SELECT
        rf.jurisdiction, rf.fact_type, rf.status, rf.max_per_100g_mg,
        rf.food_class, rf.product_category, rf.regulation_ref,
        fe.source_url, fe.source_name, fe.snapshot_date
      FROM regulatory_fact rf
      JOIN fact_evidence fe ON rf.evidence_id = fe.id
      WHERE rf.canonical_id = ? AND rf.superseded_by IS NULL
      ORDER BY rf.jurisdiction, rf.fact_type
    `)
    .bind(canonicalId)
    .all<FactRow>()

  return (result.results || []).map(r => ({
    jurisdiction: r.jurisdiction,
    fact_type: r.fact_type,
    status: r.status,
    max_per_100g_mg: r.max_per_100g_mg,
    food_class: r.food_class,
    regulation_ref: r.regulation_ref,
    source_url: r.source_url,
    source_name: r.source_name,
    snapshot_date: r.snapshot_date,
  }))
}

async function fetchNutrition(db: D1Database, canonicalId: string): Promise<NutritionFact | null> {
  const row = await db
    .prepare(`
      SELECT
        nf.source, nf.source_food_id,
        nf.energy_kcal_100g, nf.energy_kj_100g, nf.protein_g_100g,
        nf.fat_g_100g, nf.saturated_fat_g_100g, nf.carbohydrate_g_100g,
        nf.sugar_g_100g, nf.fiber_g_100g, nf.sodium_mg_100g,
        fe.source_url
      FROM nutrition_fact nf
      LEFT JOIN fact_evidence fe ON nf.evidence_id = fe.id
      WHERE nf.canonical_id = ?
      LIMIT 1
    `)
    .bind(canonicalId)
    .first<NutritionRow>()

  if (!row) return null
  return {
    source: row.source,
    source_url: row.source_url ?? undefined,
    energy_kcal_100g: row.energy_kcal_100g,
    energy_kj_100g: row.energy_kj_100g,
    protein_g_100g: row.protein_g_100g,
    fat_g_100g: row.fat_g_100g,
    saturated_fat_g_100g: row.saturated_fat_g_100g,
    carbohydrate_g_100g: row.carbohydrate_g_100g,
    sugar_g_100g: row.sugar_g_100g,
    fiber_g_100g: row.fiber_g_100g,
    sodium_mg_100g: row.sodium_mg_100g,
  }
}

// --- Public entry point ---

export type GroundedResult =
  | { status: 'disabled' }
  | { status: 'unavailable'; reason: string }
  | { status: 'unknown'; name: string }
  | { status: 'ok'; analysis: RenderedAnalysis; leak_check: { ok: boolean; leaks: string[] } }

/**
 * Attempt grounded analysis. Returns null when the feature is off / binding
 * missing / schema not applied / ingredient not indexed. Callers should fall
 * back to the legacy pipeline on null.
 *
 * The structured return form is provided when callers want visibility into
 * which branch was taken (useful for logs, A/B metrics, UI badges).
 */
export async function maybeAnalyzeIngredientGrounded(
  name: string,
  language: string = 'English',
): Promise<RenderedAnalysis | null> {
  const result = await analyzeIngredientGrounded(name, language)
  return result.status === 'ok' ? result.analysis : null
}

/**
 * Adapter: run the grounded pipeline and return its output shaped like the
 * legacy `preFilteredResults` entries in lib/analysis.ts. Returns null on
 * any non-ok status so the caller can fall through to the legacy Gemini
 * batch path unchanged.
 *
 * The shape returned here is intentionally compatible with the existing
 * legacy pipeline — it plugs in as a pre-filter entry, no other changes
 * needed in analysis.ts.
 */
export async function tryGroundedAsLegacyShape(
  name: string,
  language: string = 'English',
): Promise<Record<string, unknown> | null> {
  const result = await analyzeIngredientGrounded(name, language)
  if (result.status !== 'ok') return null

  const a = result.analysis

  // Build banned_countries from facts (jurisdiction whose fact_type = prohibited).
  const bannedJurisdictions = a.per_jurisdiction
    .filter(f => /prohibited/i.test(f.status))
    .map(f => f.jurisdiction)

  // Map the per_jurisdiction rows into the legacy regulatory_status shape
  // keyed by jurisdiction slug. The legacy UI keys are lowercase with
  // underscore separators, which matches our internal jurisdiction format
  // already (US_FDA → us_fda), so just lowercase.
  const reg: Record<string, string> = {}
  for (const f of a.per_jurisdiction) {
    reg[f.jurisdiction.toLowerCase()] = f.status
  }

  // Citations: prefer regulation_ref (short, human-readable), fall back to source_name.
  const sourcesCited = a.per_jurisdiction
    .map(f => f.regulation_ref || f.source_name)
    .filter((v, i, arr) => arr.indexOf(v) === i)

  return {
    simple_name: a.simple_name,
    safety_verdict: a.verdict,            // 'SAFE' | 'CAUTION' | 'AVOID' | 'BANNED' | 'UNKNOWN'
    concerns: [a.verdict_reason, ...a.missing_jurisdictions.map(j => `No ${j} record`)].filter(Boolean),
    banned_countries: bannedJurisdictions,
    sources_cited: sourcesCited,
    regulatory_status: reg,
    safety_limits_per_100g: a.per_jurisdiction.reduce((acc, f) => {
      if (f.jurisdiction === 'US_FDA') acc.us_fda = f.status
      if (f.jurisdiction === 'IN_FSSAI') acc.india_fssai = f.status
      if (f.jurisdiction === 'EU') acc.eu = f.status
      return acc
    }, {} as Record<string, string>),
    how_its_made: a.how_its_made ?? undefined,
    // extras that make the UI richer when this path is used
    _grounded: true,
    _citations: a.citations,
    _per_jurisdiction: a.per_jurisdiction,
    _leak_check: result.leak_check,
  }
}

export async function analyzeIngredientGrounded(
  name: string,
  language: string = 'English',
): Promise<GroundedResult> {
  if (!groundedEnabled()) {
    return { status: 'disabled' }
  }

  const db = getRegulatoryDb()
  if (!db) {
    return { status: 'unavailable', reason: 'REGULATORY_DB binding not present' }
  }

  try {
    const canonicalId = await resolveCanonicalId(db, name)
    if (!canonicalId) {
      return { status: 'unknown', name }
    }

    const [ingredient, facts, aliases, nutrition] = await Promise.all([
      fetchIngredient(db, canonicalId),
      fetchFacts(db, canonicalId),
      fetchAliases(db, canonicalId),
      fetchNutrition(db, canonicalId),
    ])

    if (!ingredient) {
      return { status: 'unknown', name }
    }

    const groundedInput: GroundedIngredientFacts = {
      canonical_id: ingredient.canonical_id,
      primary_name: ingredient.primary_name,
      aliases: aliases.length > 0 ? aliases : [ingredient.primary_name],
      ingredient_class: ingredient.ingredient_class,
      category: ingredient.category,
      is_natural: ingredient.is_natural === 1,
      cas_number: ingredient.cas_number,
      pubchem_cid: ingredient.pubchem_cid,
      e_number: ingredient.e_number,
      molecular_formula: ingredient.molecular_formula,
      iupac_name: ingredient.iupac_name ?? null,
      facts,
      nutrition,
    }

    const rendered = await renderGroundedFacts(groundedInput, language)
    const allowedJurisdictions = new Set(facts.map(f => f.jurisdiction))
    const leakCheck = validateNoJurisdictionLeak(rendered, allowedJurisdictions)

    if (!leakCheck.ok) {
      // ENFORCE: never deliver hallucinated jurisdiction claims to users.
      // Replace the prose fields with deterministic, verdict-reason-based text
      // and keep the structured per_jurisdiction array (which is sourced from DB).
      console.warn(`[Grounded] Jurisdiction leak stripped for "${name}": ${leakCheck.leaks.join(', ')}`)
      rendered.simple_name = ingredient.primary_name
      rendered.how_its_made = null
      rendered.safety_summary = rendered.verdict_reason
    }

    return { status: 'ok', analysis: rendered, leak_check: leakCheck }
  } catch (err) {
    console.error(`[Grounded] analysis failed for "${name}":`, (err as Error).message)
    return { status: 'unavailable', reason: (err as Error).message }
  }
}
