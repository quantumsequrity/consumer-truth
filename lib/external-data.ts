// OFFICIAL DATA SOURCES - DETERMINISTIC LAYER
// 1. OpenFoodFacts / OpenBeautyFacts (Global Product DB)
// 2. CAS Common Chemistry (Chemical Identity)
// 3. OpenFDA (Adverse Events + Recalls)
// 4. EPA CompTox (Chemical Safety)
// 5. PubChem (Chemical Identity & Properties)
// 6. D1 Ingredients Reference (local cache of 1-5)

import { cacheExternalData, getCachedExternalData } from './cache'

// Public APIs ask callers to identify themselves so they can rate-limit and
// contact maintainers if a client misbehaves. Override APP_CONTACT_EMAIL at
// deploy time to point operators at you rather than the upstream project.
const CONTACT = process.env.APP_CONTACT_EMAIL || 'maintainers@alzhal.app'
const HEADERS = { 'User-Agent': `Alzhal/1.0 (+${CONTACT})` }

// Timeout for external API calls (8 seconds)
const FETCH_TIMEOUT = 8000

// Circuit breaker: stop calling APIs after consecutive failures
const CIRCUIT_BREAKER_THRESHOLD = 3
const CIRCUIT_BREAKER_RESET_MS = 5 * 60 * 1000 // 5 minutes

interface CircuitBreakerState {
  failCount: number
  isOpen: boolean
  openedAt: number
}

const circuits: Record<string, CircuitBreakerState> = {
  cas: { failCount: 0, isOpen: false, openedAt: 0 },
  fda: { failCount: 0, isOpen: false, openedAt: 0 },
  pubchem: { failCount: 0, isOpen: false, openedAt: 0 },
  off: { failCount: 0, isOpen: false, openedAt: 0 },
}

function isCircuitOpen(name: string): boolean {
  const cb = circuits[name]
  if (!cb || !cb.isOpen) return false
  const elapsed = Date.now() - cb.openedAt
  if (elapsed > CIRCUIT_BREAKER_RESET_MS) {
    // Full reset after cooldown
    cb.isOpen = false
    cb.failCount = 0
    console.log(`[${name.toUpperCase()}] Circuit breaker reset - retrying API calls`)
    return false
  }
  // Half-open: allow one probe request every 60s to check if API is back
  if (elapsed > 60000 && (Date.now() % 60000) < 1000) {
    console.log(`[${name.toUpperCase()}] Circuit breaker half-open - allowing probe request`)
    return false
  }
  return true
}

function recordFailure(name: string): void {
  const cb = circuits[name]
  if (!cb) return
  cb.failCount++
  if (cb.failCount >= CIRCUIT_BREAKER_THRESHOLD && !cb.isOpen) {
    cb.isOpen = true
    cb.openedAt = Date.now()
    console.warn(`[${name.toUpperCase()}] Circuit breaker OPEN after ${cb.failCount} failures. Pausing for 5 min.`)
  }
}

function recordSuccess(name: string): void {
  const cb = circuits[name]
  if (cb) cb.failCount = 0
}

// PubChem types
export interface PubChemData {
  cid: number | null
  molecular_formula: string | null
  molecular_weight: string | null
  iupac_name: string | null
  pubchem_url: string | null
}

// FDA Recalls types
export interface FDARecallData {
  total_recalls: number
  recent_recalls: Array<{
    reason: string
    classification: string
    status: string
  }>
}

// EFSA toxicology data
export interface EFSAData {
  adi: string | null            // Acceptable Daily Intake
  noael: string | null          // No Observable Adverse Effect Level
  hazard: string | null         // Hazard assessment
  evaluation_year: number | null
}

// IARC carcinogen classification
export interface IARCData {
  group: string | null           // "Group 1", "Group 2A", "Group 2B", "Group 3"
  description: string | null     // Classification description
  agent_name: string | null      // IARC agent name (may differ from ingredient name)
}

// Enriched data per ingredient from all external APIs
export interface EnrichedIngredientData {
  cas_number: string
  fda_reports: number
  epa_link: string | null
  pubchem: PubChemData | null
  fda_recalls: FDARecallData | null
  efsa?: EFSAData | null
  iarc?: IARCData | null
  e_number?: string | null
  is_banned_anywhere?: boolean
  banned_in?: string[]
  safety_concerns?: string[]
  sources_checked: string[]
}

// D1 row shape from ingredient_reference table
interface IngredientRefRow {
  id: number
  name: string
  name_original: string | null
  cas_number: string | null
  pubchem_cid: number | null
  molecular_formula: string | null
  molecular_weight: string | null
  iupac_name: string | null
  fda_adverse_event_count: number
  fda_recall_count: number
  fda_recent_recalls: string // JSON text
  last_fda_sync_at: string | null
  efsa_adi: string | null
  efsa_noael: string | null
  efsa_hazard: string | null
  efsa_evaluation_year: number | null
  iarc_group: string | null
  iarc_description: string | null
  iarc_agent_name: string | null
  e_number: string | null
  eu_approved: number
  eu_max_level: string | null
  eu_food_categories: string // JSON text
  eu_restrictions: string | null
  is_banned_anywhere: number
  banned_in: string // JSON text
  safety_concerns: string // JSON text
  created_at: string
  updated_at: string
}

// D1 database interface (same as product-data.ts)
interface D1Database {
  prepare(query: string): D1PreparedStatement
}

interface D1PreparedStatement {
  bind(...values: any[]): D1PreparedStatement
  all<T = Record<string, unknown>>(): Promise<{ results: T[]; success: boolean }>
  first<T = Record<string, unknown>>(): Promise<T | null>
  run(): Promise<{ success: boolean }>
}

// --- D1 INGREDIENTS REFERENCE DB ---

function getIngredientsRefDb(): D1Database | null {
  try {
    const { getCloudflareContext } = require('@opennextjs/cloudflare')
    const { env } = getCloudflareContext()
    return env?.INGREDIENTS_REF_DB || null
  } catch {
    return null
  }
}

/**
 * Batch lookup ingredients from D1 reference database.
 * Single query for all names — much faster than per-ingredient API calls.
 */
async function lookupIngredientsFromD1(names: string[]): Promise<Map<string, IngredientRefRow>> {
  const result = new Map<string, IngredientRefRow>()
  const db = getIngredientsRefDb()
  if (!db || names.length === 0) return result

  try {
    // D1 WHERE IN is case-sensitive, so use LOWER() with lowercased params
    const lowered = names.map(n => n.toLowerCase())
    const placeholders = lowered.map(() => '?').join(', ')
    const query = `SELECT * FROM ingredient_reference WHERE LOWER(name) IN (${placeholders})`

    const res = await db.prepare(query).bind(...lowered).all<IngredientRefRow>()

    if (res.success && res.results) {
      for (const row of res.results) {
        result.set(row.name, row)
      }
    }
  } catch (e) {
    console.error('[D1-IngRef] Batch lookup failed:', e)
  }

  return result
}

/**
 * Convert a D1 ingredient_reference row to the EnrichedIngredientData interface.
 * Produces the exact same shape as the API-based enrichment.
 */
function d1RowToEnrichedData(row: IngredientRefRow): EnrichedIngredientData {
  const casNumber = row.cas_number || 'Unknown'

  let pubchem: PubChemData | null = null
  if (row.pubchem_cid) {
    pubchem = {
      cid: row.pubchem_cid,
      molecular_formula: row.molecular_formula,
      molecular_weight: row.molecular_weight,
      iupac_name: row.iupac_name,
      pubchem_url: `https://pubchem.ncbi.nlm.nih.gov/compound/${row.pubchem_cid}`,
    }
  }

  let fdaRecalls: FDARecallData | null = null
  if (row.fda_recall_count > 0) {
    let recentRecalls: Array<{ reason: string; classification: string; status: string }> = []
    try {
      recentRecalls = JSON.parse(row.fda_recent_recalls || '[]')
    } catch {
      recentRecalls = []
    }
    fdaRecalls = {
      total_recalls: row.fda_recall_count,
      recent_recalls: recentRecalls,
    }
  }

  let efsa: EFSAData | null = null
  if (row.efsa_adi || row.efsa_noael || row.efsa_hazard) {
    efsa = {
      adi: row.efsa_adi,
      noael: row.efsa_noael,
      hazard: row.efsa_hazard,
      evaluation_year: row.efsa_evaluation_year,
    }
  }

  let iarc: IARCData | null = null
  if (row.iarc_group) {
    iarc = {
      group: row.iarc_group,
      description: row.iarc_description,
      agent_name: row.iarc_agent_name,
    }
  }

  let bannedIn: string[] = []
  try {
    bannedIn = JSON.parse(row.banned_in || '[]')
  } catch {
    bannedIn = []
  }

  let safetyConcerns: string[] = []
  try {
    safetyConcerns = JSON.parse(row.safety_concerns || '[]')
  } catch {
    safetyConcerns = []
  }

  const sources: string[] = ['D1 Ingredients Reference']
  if (row.cas_number) sources.push('CAS Common Chemistry')
  if (row.pubchem_cid) sources.push('PubChem')
  if (row.fda_adverse_event_count > 0 || row.fda_recall_count > 0) sources.push('OpenFDA')
  if (efsa) sources.push('EFSA OpenFoodTox')
  if (iarc) sources.push('WHO/IARC Monographs')

  return {
    cas_number: casNumber,
    fda_reports: row.fda_adverse_event_count,
    epa_link: getEPALink(row.cas_number),
    pubchem,
    fda_recalls: fdaRecalls,
    efsa,
    iarc,
    e_number: row.e_number || null,
    is_banned_anywhere: row.is_banned_anywhere === 1,
    banned_in: bannedIn,
    safety_concerns: safetyConcerns,
    sources_checked: sources,
  }
}

/**
 * Write-through: upsert enriched API data back into D1 for future cache hits.
 * Uses COALESCE to preserve existing data when new data is null.
 */
async function upsertIngredientRef(name: string, data: EnrichedIngredientData): Promise<void> {
  const db = getIngredientsRefDb()
  if (!db) return

  try {
    const loweredName = name.toLowerCase()
    const casNumber = data.cas_number !== 'Unknown' ? data.cas_number : null
    const pubchemCid = data.pubchem?.cid || null
    const molecularFormula = data.pubchem?.molecular_formula || null
    const molecularWeight = data.pubchem?.molecular_weight || null
    const iupacName = data.pubchem?.iupac_name || null
    const fdaAdverseEventCount = data.fda_reports || 0
    const fdaRecallCount = data.fda_recalls?.total_recalls || 0
    const fdaRecentRecalls = data.fda_recalls ? JSON.stringify(data.fda_recalls.recent_recalls) : '[]'

    await db.prepare(`
      INSERT INTO ingredient_reference (name, name_original, cas_number, pubchem_cid, molecular_formula, molecular_weight, iupac_name, fda_adverse_event_count, fda_recall_count, fda_recent_recalls, last_fda_sync_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, datetime('now'))
      ON CONFLICT(name) DO UPDATE SET
        cas_number = COALESCE(?3, ingredient_reference.cas_number),
        pubchem_cid = COALESCE(?4, ingredient_reference.pubchem_cid),
        molecular_formula = COALESCE(?5, ingredient_reference.molecular_formula),
        molecular_weight = COALESCE(?6, ingredient_reference.molecular_weight),
        iupac_name = COALESCE(?7, ingredient_reference.iupac_name),
        fda_adverse_event_count = ?8,
        fda_recall_count = ?9,
        fda_recent_recalls = ?10,
        last_fda_sync_at = datetime('now'),
        updated_at = datetime('now')
    `).bind(
      loweredName, name, casNumber, pubchemCid, molecularFormula,
      molecularWeight, iupacName, fdaAdverseEventCount, fdaRecallCount, fdaRecentRecalls
    ).run()
  } catch (e) {
    // Non-critical: log but don't fail the enrichment
    console.error(`[D1-IngRef] Upsert failed for ${name}:`, e)
  }
}

// Helper function to fetch with timeout
async function fetchWithTimeout(url: string, options: RequestInit = {}, timeout = FETCH_TIMEOUT): Promise<Response> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeout)

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    })
    clearTimeout(timeoutId)
    return response
  } catch (error) {
    clearTimeout(timeoutId)
    throw error
  }
}

// --- 1. OPEN FOOD/BEAUTY FACTS (The "Everything" Engine) ---
export async function searchOpenWebFacts(query: string, type: 'food' | 'beauty' = 'food') {
    if (isCircuitOpen('off')) return null

    try {
        const subdomain = type === 'beauty' ? 'world.openbeautyfacts.org' : 'world.openfoodfacts.org';
        const url = `https://${subdomain}/cgi/search.pl?search_terms=${encodeURIComponent(query)}&search_simple=1&action=process&json=1`;

        const res = await fetchWithTimeout(url, { headers: HEADERS });
        if (!res.ok) {
            recordFailure('off')
            return null
        }
        recordSuccess('off')
        const data = await res.json();

        if (data.products && data.products.length > 0) {
            const product = data.products[0];
            return {
                found: true,
                allergens: product.allergens_tags || [],
                additives: product.additives_tags || [], // e.g., "en:e330"
                ingredients_text: product.ingredients_text,
                ecoscore: product.ecoscore_grade,
                nova_group: product.nova_group, // Processing level (1-4)
                brand: product.brands
            };
        }
        return null;
    } catch (e) {
        recordFailure('off')
        console.error(`Open${type}Facts lookup failed:`, e);
        return null;
    }
}

// --- 2. CAS COMMON CHEMISTRY (The Identity Source) ---
// Maps names to CAS Registry Numbers for 100% accurate lookups
export async function getCASNumber(ingredientName: string): Promise<string | null> {
    if (isCircuitOpen('cas')) return null

    const cacheKey = `cas:${ingredientName}`
    const cached = getCachedExternalData(cacheKey)
    if (cached !== undefined) {
        return cached === '__FAILED__' ? null : cached
    }

    try {
        const url = `https://commonchemistry.cas.org/api/search?q=${encodeURIComponent(ingredientName)}`
        const res = await fetchWithTimeout(url, {
            headers: { ...HEADERS, 'Accept': 'application/json' }
        })

        if (!res.ok) {
            recordFailure('cas')
            cacheExternalData(cacheKey, '__FAILED__')
            return null
        }

        recordSuccess('cas')
        const data = await res.json()

        if (data.count > 0 && data.results[0]) {
            const casNumber = data.results[0].rn
            cacheExternalData(cacheKey, casNumber)
            return casNumber
        }

        cacheExternalData(cacheKey, null)
        return null
    } catch (e) {
        recordFailure('cas')
        cacheExternalData(cacheKey, '__FAILED__')
        return null
    }
}

// --- 3. OPEN FDA (Adverse Events) ---
// Supports multiple product types: food, drug, device
export async function getOpenFDACount(ingredientName: string, productType: string = 'food'): Promise<number> {
    if (isCircuitOpen('fda')) return 0

    const cacheKey = `fda:${productType}:${ingredientName}`
    const cached = getCachedExternalData(cacheKey)
    if (cached !== undefined) {
        return cached
    }

    try {
        let endpoint: string
        let searchField: string

        let url: string
        switch (productType) {
            case 'cosmetic':
            case 'household':
                endpoint = 'drug/event'
                searchField = 'patient.drug.openfda.substance_name'
                url = `https://api.fda.gov/${endpoint}.json?search=${searchField}:${encodeURIComponent(`"${ingredientName}"`)}&limit=1`
                break
            case 'pharma':
                endpoint = 'drug/event'
                searchField = 'patient.drug.openfda.substance_name'
                url = `https://api.fda.gov/${endpoint}.json?search=${searchField}:${encodeURIComponent(`"${ingredientName}"`)}&limit=1`
                break
            default:
                // For food: search by ingredient name across both products.industry_name AND reactions
                endpoint = 'food/event'
                const encodedName = encodeURIComponent(`"${ingredientName}"`)
                url = `https://api.fda.gov/${endpoint}.json?search=products.industry_name:${encodedName}+reactions:${encodedName}&limit=1`
                break
        }

        const res = await fetchWithTimeout(url, { headers: HEADERS })

        if (!res.ok) {
            recordFailure('fda')
            cacheExternalData(cacheKey, 0)
            return 0
        }

        recordSuccess('fda')
        const data = await res.json()

        const count = data.meta?.results?.total || 0
        cacheExternalData(cacheKey, count)
        return count
    } catch (e) {
        recordFailure('fda')
        cacheExternalData(cacheKey, 0)
        return 0
    }
}

// --- 4. EPA COMPTOX (via CAS Number) ---
export function getEPALink(casNumber: string | null) {
    if (!casNumber) return null;
    return `https://comptox.epa.gov/dashboard/chemical/details/${casNumber}`;
}

// --- 5. PUBCHEM (Chemical Identity & Properties) ---
// No API key needed; 5 requests/second limit
export async function getPubChemData(ingredientName: string): Promise<PubChemData | null> {
    if (isCircuitOpen('pubchem')) return null

    const cacheKey = `pubchem:${ingredientName}`
    const cached = getCachedExternalData(cacheKey)
    if (cached !== undefined) {
        return cached === '__FAILED__' ? null : cached
    }

    try {
        const encodedName = encodeURIComponent(ingredientName)
        const url = `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/${encodedName}/property/MolecularFormula,MolecularWeight,IUPACName/JSON`

        const res = await fetchWithTimeout(url, { headers: HEADERS })

        if (!res.ok) {
            recordFailure('pubchem')
            cacheExternalData(cacheKey, '__FAILED__')
            return null
        }

        recordSuccess('pubchem')
        const data = await res.json()
        const props = data?.PropertyTable?.Properties?.[0]

        if (!props) {
            cacheExternalData(cacheKey, null)
            return null
        }

        const result: PubChemData = {
            cid: props.CID || null,
            molecular_formula: props.MolecularFormula || null,
            molecular_weight: props.MolecularWeight ? String(props.MolecularWeight) : null,
            iupac_name: props.IUPACName || null,
            pubchem_url: props.CID ? `https://pubchem.ncbi.nlm.nih.gov/compound/${props.CID}` : null,
        }

        cacheExternalData(cacheKey, result)
        return result
    } catch (e) {
        recordFailure('pubchem')
        cacheExternalData(cacheKey, '__FAILED__')
        return null
    }
}

// --- 6. FDA RECALLS (Food Enforcement) ---
// No API key needed
export async function getFDARecalls(ingredientName: string): Promise<FDARecallData | null> {
    if (isCircuitOpen('fda')) return null

    const cacheKey = `fda_recalls:${ingredientName}`
    const cached = getCachedExternalData(cacheKey)
    if (cached !== undefined) {
        return cached === '__FAILED__' ? null : cached
    }

    try {
        const encodedName = encodeURIComponent(`"${ingredientName}"`)
        const url = `https://api.fda.gov/food/enforcement.json?search=reason_for_recall:${encodedName}&limit=3`

        const res = await fetchWithTimeout(url, { headers: HEADERS })

        if (!res.ok) {
            // 404 means no results, not a failure
            if (res.status === 404) {
                const empty: FDARecallData = { total_recalls: 0, recent_recalls: [] }
                cacheExternalData(cacheKey, empty)
                return empty
            }
            recordFailure('fda')
            cacheExternalData(cacheKey, '__FAILED__')
            return null
        }

        recordSuccess('fda')
        const data = await res.json()

        const result: FDARecallData = {
            total_recalls: data.meta?.results?.total || 0,
            recent_recalls: (data.results || []).slice(0, 3).map((r: any) => ({
                reason: r.reason_for_recall || 'Unknown',
                classification: r.classification || 'Unknown',
                status: r.status || 'Unknown',
            })),
        }

        cacheExternalData(cacheKey, result)
        return result
    } catch (e) {
        recordFailure('fda')
        cacheExternalData(cacheKey, '__FAILED__')
        return null
    }
}

// --- BATCH ENRICHMENT (D1-first with API fallback) ---
export async function getEnrichedDataForBatch(
    ingredientNames: string[],
    productType: string = 'food'
): Promise<Record<string, EnrichedIngredientData>> {
    const results: Record<string, EnrichedIngredientData> = {}

    // Step 1: Check in-memory cache first
    const uncachedNames: string[] = []
    for (const name of ingredientNames) {
        const cacheKey = `enriched:${productType}:${name}`
        const cached = getCachedExternalData(cacheKey)
        if (cached !== undefined && cached !== '__FAILED__') {
            results[name] = cached
        } else {
            uncachedNames.push(name)
        }
    }

    if (uncachedNames.length === 0) return results

    // Step 2: Batch D1 lookup (single query for all uncached names)
    const d1Results = await lookupIngredientsFromD1(uncachedNames)
    const apiMisses: string[] = []

    for (const name of uncachedNames) {
        const row = d1Results.get(name.toLowerCase())
        if (row) {
            const enriched = d1RowToEnrichedData(row)
            results[name] = enriched
            // Warm in-memory cache from D1 hit
            cacheExternalData(`enriched:${productType}:${name}`, enriched)
        } else {
            apiMisses.push(name)
        }
    }

    if (apiMisses.length > 0) {
        console.log(`[EnrichedData] D1 hits: ${uncachedNames.length - apiMisses.length}, API fallback: ${apiMisses.length}`)
    }

    // Step 3: API fallback for D1 misses only
    // Process in batches of 4 to stay under Cloudflare Workers subrequest limit (~50)
    const ENRICHMENT_BATCH_SIZE = 4
    for (let i = 0; i < apiMisses.length; i += ENRICHMENT_BATCH_SIZE) {
        const batch = apiMisses.slice(i, i + ENRICHMENT_BATCH_SIZE)
        const promises = batch.map(async (name) => {
            try {
                const [cas, fdaCount, pubchem, fdaRecalls] = await Promise.all([
                    getCASNumber(name),
                    getOpenFDACount(name, productType),
                    getPubChemData(name),
                    getFDARecalls(name),
                ])

                const enriched: EnrichedIngredientData = {
                    cas_number: cas || "Unknown",
                    fda_reports: fdaCount,
                    epa_link: getEPALink(cas),
                    pubchem,
                    fda_recalls: fdaRecalls,
                    sources_checked: [
                        "CAS Common Chemistry",
                        "OpenFDA Adverse Events",
                        "EPA CompTox",
                        ...(pubchem ? ["PubChem"] : []),
                        ...(fdaRecalls ? ["FDA Recalls"] : []),
                    ],
                }

                cacheExternalData(`enriched:${productType}:${name}`, enriched)
                results[name] = enriched

                // Step 4: Write-through — upsert API result into D1 for future hits
                upsertIngredientRef(name, enriched).catch(() => {})
            } catch (error) {
                console.error(`[EnrichedData] Failed for ${name}:`, error)
                results[name] = {
                    cas_number: "Unknown",
                    fda_reports: 0,
                    epa_link: null,
                    pubchem: null,
                    fda_recalls: null,
                    sources_checked: ["CAS Common Chemistry", "OpenFDA Adverse Events", "EPA CompTox"],
                }
            }
        })
        await Promise.all(promises)
    }
    return results
}

// --- MASTER AGGREGATOR (single ingredient, includes PubChem + FDA Recalls) ---
export async function getOfficialData(ingredientName: string, productType: string = 'food'): Promise<EnrichedIngredientData> {
    const cacheKey = `official:${productType}:${ingredientName}`
    const cached = getCachedExternalData(cacheKey)
    if (cached !== undefined) {
        return cached
    }

    // Try D1 first
    const d1Results = await lookupIngredientsFromD1([ingredientName])
    const row = d1Results.get(ingredientName.toLowerCase())
    if (row) {
        const enriched = d1RowToEnrichedData(row)
        cacheExternalData(cacheKey, enriched)
        return enriched
    }

    // API fallback
    try {
        const [cas, fdaCount, pubchem, fdaRecalls] = await Promise.all([
            getCASNumber(ingredientName),
            getOpenFDACount(ingredientName, productType),
            getPubChemData(ingredientName),
            getFDARecalls(ingredientName),
        ])

        const result: EnrichedIngredientData = {
            cas_number: cas || "Unknown",
            fda_reports: fdaCount,
            epa_link: getEPALink(cas),
            pubchem,
            fda_recalls: fdaRecalls,
            sources_checked: [
                "CAS Common Chemistry",
                "OpenFDA Adverse Events",
                "EPA CompTox",
                ...(pubchem ? ["PubChem"] : []),
                ...(fdaRecalls ? ["FDA Recalls"] : []),
            ],
        }

        cacheExternalData(cacheKey, result)
        // Write-through to D1
        upsertIngredientRef(ingredientName, result).catch(() => {})
        return result
    } catch (error) {
        console.error('Official data aggregation failed:', error)
        const fallback: EnrichedIngredientData = {
            cas_number: "Unknown",
            fda_reports: 0,
            epa_link: null,
            pubchem: null,
            fda_recalls: null,
            sources_checked: ["CAS Common Chemistry", "OpenFDA Adverse Events", "EPA CompTox"],
        }
        cacheExternalData(cacheKey, fallback)
        return fallback
    }
}

// Format enriched data as context string for Gemini prompts
export function formatEnrichedDataForPrompt(enrichedData: Record<string, EnrichedIngredientData>): string {
    const lines: string[] = []

    for (const [name, data] of Object.entries(enrichedData)) {
        const parts: string[] = [`--- ${name} ---`]

        if (data.cas_number !== "Unknown") {
            parts.push(`CAS Number: ${data.cas_number}`)
        }

        if (data.e_number) {
            parts.push(`E Number: ${data.e_number}`)
        }

        if (data.pubchem) {
            if (data.pubchem.molecular_formula) parts.push(`Molecular Formula (PubChem): ${data.pubchem.molecular_formula}`)
            if (data.pubchem.molecular_weight) parts.push(`Molecular Weight: ${data.pubchem.molecular_weight}`)
            if (data.pubchem.iupac_name) parts.push(`IUPAC Name: ${data.pubchem.iupac_name}`)
            if (data.pubchem.pubchem_url) parts.push(`PubChem: ${data.pubchem.pubchem_url}`)
        }

        if (data.fda_reports > 0) {
            parts.push(`FDA Adverse Event Reports: ${data.fda_reports}`)
        }

        if (data.fda_recalls && data.fda_recalls.total_recalls > 0) {
            parts.push(`FDA Recalls: ${data.fda_recalls.total_recalls} total`)
            for (const recall of data.fda_recalls.recent_recalls) {
                parts.push(`  - ${recall.reason} (${recall.classification}, ${recall.status})`)
            }
        }

        if (data.efsa) {
            if (data.efsa.adi) parts.push(`EFSA ADI (Acceptable Daily Intake): ${data.efsa.adi}`)
            if (data.efsa.noael) parts.push(`EFSA NOAEL: ${data.efsa.noael}`)
            if (data.efsa.hazard) parts.push(`EFSA Hazard: ${data.efsa.hazard}`)
            if (data.efsa.evaluation_year) parts.push(`EFSA Evaluation Year: ${data.efsa.evaluation_year}`)
        }

        if (data.iarc) {
            parts.push(`WHO/IARC Classification: ${data.iarc.group}${data.iarc.description ? ` — ${data.iarc.description}` : ''}`)
            if (data.iarc.agent_name && data.iarc.agent_name.toLowerCase() !== name.toLowerCase()) {
                parts.push(`IARC Agent Name: ${data.iarc.agent_name}`)
            }
        }

        if (data.is_banned_anywhere && data.banned_in && data.banned_in.length > 0) {
            parts.push(`BANNED IN: ${data.banned_in.join(', ')}`)
        }

        if (data.safety_concerns && data.safety_concerns.length > 0) {
            parts.push(`Safety Concerns: ${data.safety_concerns.join('; ')}`)
        }

        if (data.epa_link) {
            parts.push(`EPA CompTox: ${data.epa_link}`)
        }

        lines.push(parts.join('\n'))
    }

    return lines.join('\n\n')
}
