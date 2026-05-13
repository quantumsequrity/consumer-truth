import { analyzeImage, analyzeIngredientBatch, translateContent } from './gemini'
import { query, queryOne, execute, generateId, parseJsonColumn } from './db'
import { getEnrichedDataForBatch, formatEnrichedDataForPrompt, EnrichedIngredientData } from './external-data'
import { lookupIngredientsContext, lookupProductContext } from './product-data'
import { mergeOcrResults } from './ocr-merge'
import { extractWithWorkersAI } from './workers-ai-ocr'
import { tryGroundedAsLegacyShape, groundedEnabled } from './analysis-grounded'

/**
 * Rule-based verdict escalation using regulatory data.
 * Overrides Gemini's verdict when definitive hazard signals are present.
 *
 * Escalation rules (in priority order):
 * 1. IARC Group 1 (Carcinogenic to humans) → BANNED
 * 2. banned_in countries → BANNED
 * 3. IARC Group 2A (Probably carcinogenic) + high FDA events (>100) → AVOID
 * 4. EFSA critical hazards (Carcinogenicity, Genotoxicity, Reprotoxicity) → AVOID
 * 5. IARC Group 2B + EFSA hazard → CAUTION minimum
 * 6. FDA events >100 → CAUTION minimum
 * 7. Natural ingredients with no regulatory red flags → preserve Gemini verdict
 */
export function escalateVerdictFromRegulatoryData(
  ingredientName: string,
  geminiVerdict: string,
  enrichedData: EnrichedIngredientData | null,
  concerns: string[]
): { verdict: string; concerns: string[]; autoEscalated: boolean } {
  if (!enrichedData) {
    return { verdict: geminiVerdict, concerns, autoEscalated: false }
  }

  const originalVerdict = geminiVerdict.toUpperCase()
  let escalatedVerdict = originalVerdict
  let autoEscalated = false
  const newConcerns = [...concerns]

  // Extract regulatory signals
  const iarcGroup = enrichedData.iarc?.group || null
  // EFSAData.hazard is a single string; wrap in array for uniform processing
  const efsaHazard = enrichedData.efsa?.hazard || null
  const efsaHazards: string[] = efsaHazard ? [efsaHazard] : []
  const bannedCountries = enrichedData.banned_in || []
  const fdaEvents = enrichedData.fda_reports || 0

  // Critical EFSA hazards that warrant AVOID
  const criticalEfsaHazards = ['Carcinogenicity', 'Genotoxicity', 'Reprotoxicity', 'Mutagenicity']
  const hasCriticalEfsaHazard = efsaHazards.some((h: string) =>
    criticalEfsaHazards.some(critical => h.includes(critical))
  )

  // Rule 1: IARC Group 1 → BANNED
  if (iarcGroup === 'Group 1' && escalatedVerdict !== 'BANNED') {
    escalatedVerdict = 'BANNED'
    autoEscalated = true
    newConcerns.push('WHO/IARC: Classified as carcinogenic to humans (Group 1)')
    console.log(`[AutoEscalation] ${ingredientName}: ${originalVerdict} → BANNED (IARC Group 1)`)
  }

  // Rule 2: banned_in countries → BANNED
  if (bannedCountries.length > 0 && escalatedVerdict !== 'BANNED') {
    escalatedVerdict = 'BANNED'
    autoEscalated = true
    newConcerns.push(`Banned in: ${bannedCountries.join(', ')}`)
    console.log(`[AutoEscalation] ${ingredientName}: ${originalVerdict} → BANNED (banned in ${bannedCountries.length} countries)`)
  }

  // Rule 3: IARC Group 2A + high FDA events → AVOID
  if (iarcGroup === 'Group 2A' && fdaEvents > 100) {
    const targetVerdict = 'AVOID'
    if (escalatedVerdict === 'SAFE' || escalatedVerdict === 'CAUTION') {
      escalatedVerdict = targetVerdict
      autoEscalated = true
      newConcerns.push(`WHO/IARC: Probably carcinogenic (Group 2A) + ${fdaEvents} FDA adverse events`)
      console.log(`[AutoEscalation] ${ingredientName}: ${originalVerdict} → ${targetVerdict} (IARC 2A + FDA events)`)
    }
  }

  // Rule 4: EFSA critical hazards → AVOID
  if (hasCriticalEfsaHazard && escalatedVerdict !== 'BANNED') {
    const targetVerdict = 'AVOID'
    if (escalatedVerdict === 'SAFE' || escalatedVerdict === 'CAUTION') {
      escalatedVerdict = targetVerdict
      autoEscalated = true
      const criticalFound = efsaHazards.filter((h: string) =>
        criticalEfsaHazards.some(critical => h.includes(critical))
      )
      newConcerns.push(`EFSA: Critical hazards identified - ${criticalFound.join(', ')}`)
      console.log(`[AutoEscalation] ${ingredientName}: ${originalVerdict} → ${targetVerdict} (EFSA critical hazards)`)
    }
  }

  // Rule 5: IARC Group 2B + EFSA hazard → CAUTION minimum
  if (iarcGroup === 'Group 2B' && efsaHazards.length > 0) {
    const targetVerdict = 'CAUTION'
    if (escalatedVerdict === 'SAFE') {
      escalatedVerdict = targetVerdict
      autoEscalated = true
      newConcerns.push(`WHO/IARC: Possibly carcinogenic (Group 2B) + EFSA hazards: ${efsaHazards.slice(0, 2).join(', ')}`)
      console.log(`[AutoEscalation] ${ingredientName}: ${originalVerdict} → ${targetVerdict} (IARC 2B + EFSA)`)
    }
  }

  // Rule 6: High FDA events → CAUTION minimum
  if (fdaEvents > 100 && escalatedVerdict === 'SAFE') {
    escalatedVerdict = 'CAUTION'
    autoEscalated = true
    newConcerns.push(`FDA: ${fdaEvents} adverse event reports filed`)
    console.log(`[AutoEscalation] ${ingredientName}: ${originalVerdict} → CAUTION (${fdaEvents} FDA events)`)
  }

  return {
    verdict: escalatedVerdict,
    concerns: newConcerns,
    autoEscalated,
  }
}

export async function processImageAndAnalyze(imageBuffer: Buffer, mimeType: string, language: string = 'English', clientOcrText: string = '') {
    // 1. Multi-source OCR: Gemini Vision + Workers AI in parallel (Tesseract already ran client-side)
    console.log('[Analysis] Starting multi-source OCR...')

    const [geminiResult, workersAIResult] = await Promise.allSettled([
        analyzeImage(imageBuffer, mimeType),
        extractWithWorkersAI(imageBuffer, mimeType),
    ])

    const geminiData = geminiResult.status === 'fulfilled' ? geminiResult.value : null
    const workersAIData = workersAIResult.status === 'fulfilled' ? workersAIResult.value : null

    if (geminiResult.status === 'rejected') {
        console.warn('[Analysis] Gemini Vision failed:', geminiResult.reason?.message || geminiResult.reason)
    }
    if (workersAIResult.status === 'rejected') {
        console.warn('[Analysis] Workers AI OCR failed:', workersAIResult.reason?.message || workersAIResult.reason)
    }

    // Merge all OCR sources
    const merged = mergeOcrResults({
        gemini: geminiData,
        workersAI: workersAIData,
        tesseractRaw: clientOcrText,
    })

    console.log(`[Analysis] OCR sources: [${merged.ocrSources.join(', ')}], primary: ${merged.primarySource}, ${merged.ingredients.length} ingredients`)

    const productData = {
        product_name: merged.product_name,
        brand: merged.brand,
        category: merged.category,
        ingredients: merged.ingredients,
    }
    const ocrSources = merged.ocrSources
    const productCategory = productData.category || 'food'
    console.log(`[Analysis] Product: ${productData.product_name} (${productCategory}), ${productData.ingredients.length} ingredients`)

    // 2. Upsert Product in DB (atomic to prevent race conditions)
    let productId: string | undefined
    let existingScannedCount = 0
    try {
        const newId = generateId()
        await execute(
            `INSERT INTO products (id, product_name, brand, category, total_ingredients, last_scanned_at)
             VALUES (?, ?, ?, ?, ?, datetime('now'))
             ON CONFLICT(product_name) DO UPDATE SET
               brand = excluded.brand,
               category = excluded.category,
               total_ingredients = excluded.total_ingredients,
               last_scanned_at = datetime('now')`,
            [newId, productData.product_name, productData.brand, productData.category, productData.ingredients.length]
        )
        const product = await queryOne<{ id: string; scanned_count: number }>(
            'SELECT id, scanned_count FROM products WHERE product_name = ?',
            [productData.product_name]
        )
        if (product) {
            productId = product.id
            existingScannedCount = product.scanned_count || 0
            // Atomic increment — single SQL statement, no RPC needed
            await execute('UPDATE products SET scanned_count = scanned_count + 1 WHERE id = ?', [product.id])
        }
    } catch (e) {
        console.error('[Analysis] Product upsert failed:', e)
    }

    // 3. Analyze Ingredients (BATCH MODE)
    const analyzedIngredients = []

    // A. Identify which ingredients need analysis (case-insensitive lookup)
    // Deduplicate ingredients (case-insensitive) to avoid redundant Gemini/DB calls
    const deduped = new Map<string, (typeof productData.ingredients)[number]>()
    for (const item of productData.ingredients) {
        const lower = item.name.toLowerCase()
        if (!deduped.has(lower)) deduped.set(lower, item)
    }
    productData.ingredients = [...deduped.values()]

    const ingredientNames = productData.ingredients.map((i: { name: string }) => i.name)
    const lowerNames = ingredientNames.map((n: string) => n.toLowerCase())
    const placeholders = lowerNames.map(() => '?').join(',')
    const cachedIngredients = lowerNames.length > 0
        ? await query<any>(`SELECT * FROM ingredients WHERE LOWER(name) IN (${placeholders})`, lowerNames)
        : []

    const cachedMap = new Map(cachedIngredients.map((i: any) => {
        // Parse JSON text columns from D1
        i.concerns = parseJsonColumn(i.concerns, [])
        i.banned_in = parseJsonColumn(i.banned_in, [])
        return [i.name.toLowerCase(), i]
    }))
    const needsAnalysis: string[] = []

    for (const item of productData.ingredients) {
        if (!cachedMap.has(item.name.toLowerCase())) {
            needsAnalysis.push(item.name)
        }
    }

    // B. Fetch CSV + external API data in PARALLEL (before Gemini)
    let csvContext = ''
    let enrichedData: Record<string, EnrichedIngredientData> = {}
    let externalApiContext = ''

    if (needsAnalysis.length > 0) {
        const [csvResult, enrichedResult] = await Promise.allSettled([
            // CSV lookup
            (async () => {
                const [productCsvContext, ingredientCsvContext] = await Promise.all([
                    lookupProductContext(productData.product_name),
                    lookupIngredientsContext(needsAnalysis),
                ])
                const parts: string[] = []
                if (productCsvContext) parts.push(productCsvContext)
                if (ingredientCsvContext) parts.push(ingredientCsvContext)
                return parts.length > 0 ? parts.join('\n\n') : ''
            })(),
            // External API enrichment (PubChem, CAS, FDA adverse events + recalls)
            getEnrichedDataForBatch(needsAnalysis, productCategory),
        ])

        if (csvResult.status === 'fulfilled' && csvResult.value) {
            csvContext = csvResult.value
            console.log(`[Analysis] CSV data found: ${csvContext.length} chars of additional context`)
        } else if (csvResult.status === 'rejected') {
            console.warn('[Analysis] CSV lookup failed (non-blocking):', csvResult.reason)
        }

        if (enrichedResult.status === 'fulfilled') {
            enrichedData = enrichedResult.value
            externalApiContext = formatEnrichedDataForPrompt(enrichedData)
            console.log(`[Analysis] External API data: ${Object.keys(enrichedData).length} ingredients enriched`)
        } else {
            console.warn('[Analysis] External API enrichment failed (non-blocking):', enrichedResult.reason)
        }
    }

    // C. Pre-filter optimization: Skip Gemini for ingredients with hard regulatory signals
    const preFilteredResults: Record<string, any> = {}
    const stillNeedsGemini: string[] = []

    // C0. v2-grounded path: if the feature flag is on and the ingredient has
    // regulatory facts in the CIG, use the deterministic renderer and skip
    // Gemini for that ingredient. Falls through gracefully when the flag is
    // off, the DB binding is missing, or the ingredient is not indexed.
    const groundedHits = new Set<string>()
    if (groundedEnabled() && needsAnalysis.length > 0) {
        await Promise.all(needsAnalysis.map(async (name) => {
            try {
                const grounded = await tryGroundedAsLegacyShape(name, language)
                if (grounded) {
                    preFilteredResults[name.toLowerCase()] = grounded
                    groundedHits.add(name)
                    console.log(`[Grounded] Used CIG facts for ${name} → ${grounded.safety_verdict}`)
                }
            } catch (e) {
                // Non-blocking — grounded is strictly additive to the existing pipeline.
                console.warn(`[Grounded] Lookup failed for ${name}:`, (e as Error).message)
            }
        }))
        if (groundedHits.size > 0) {
            console.log(`[Grounded] Resolved ${groundedHits.size}/${needsAnalysis.length} ingredients from CIG, ${needsAnalysis.length - groundedHits.size} remain for enriched+Gemini path`)
        }
    }

    for (const name of needsAnalysis) {
        if (groundedHits.has(name)) continue  // already handled by grounded path
        const enriched = enrichedData[name]
        if (!enriched) {
            stillNeedsGemini.push(name)
            continue
        }

        // Hard signals that allow deterministic verdict without AI
        const iarcGroup1 = enriched.iarc?.group === 'Group 1'
        const isBanned = (enriched.banned_in || []).length > 0
        const criticalEfsaHazards = ['Carcinogenicity', 'Genotoxicity', 'Reprotoxicity']
        const efsaHazardStr = enriched.efsa?.hazard || ''
        const hasCriticalEfsa = criticalEfsaHazards.some(critical => efsaHazardStr.includes(critical))

        if (iarcGroup1 || isBanned || hasCriticalEfsa) {
            // Generate deterministic verdict from regulatory data
            const verdict = (iarcGroup1 || isBanned) ? 'BANNED' : 'AVOID'
            const concerns: string[] = []

            if (iarcGroup1) concerns.push('WHO/IARC: Carcinogenic to humans (Group 1)')
            if (isBanned) concerns.push(`Banned in: ${enriched.banned_in!.join(', ')}`)
            if (hasCriticalEfsa) {
                concerns.push(`EFSA: ${efsaHazardStr}`)
            }

            preFilteredResults[name.toLowerCase()] = {
                simple_name: `Regulatory-flagged substance`,
                safety_verdict: verdict,
                concerns,
                banned_countries: enriched.banned_in || [],
                sources_cited: ['WHO/IARC', 'EFSA', 'FDA'].filter(s =>
                    (iarcGroup1 && s === 'WHO/IARC') ||
                    (hasCriticalEfsa && s === 'EFSA') ||
                    (isBanned && s === 'FDA')
                ),
                regulatory_status: {
                    who_iarc: enriched.iarc?.group || 'Data not available',
                    eu_efsa: hasCriticalEfsa ? 'Critical hazards identified' : 'Data not available',
                },
            }

            console.log(`[PreFilter] Skipped Gemini for ${name} (hard signal: ${verdict})`)
        } else {
            stillNeedsGemini.push(name)
        }
    }

    if (preFilteredResults && Object.keys(preFilteredResults).length > 0) {
        console.log(`[PreFilter] Skipped ${Object.keys(preFilteredResults).length} ingredients (hard signals), calling Gemini for ${stillNeedsGemini.length}`)
    }

    // D. Call Gemini in ONE Batch with enriched context (only for ingredients without hard signals)
    let batchResults: Record<string, any> = {}
    if (stillNeedsGemini.length > 0) {
        console.log(`[Analysis] Batch analyzing ${stillNeedsGemini.length} new ingredients for ${productCategory} product...`)
        const rawBatchResults = await analyzeIngredientBatch(stillNeedsGemini, productCategory, csvContext, externalApiContext)

        // Build case-insensitive lookup: map lowercase key to first matching result
        for (const [key, value] of Object.entries(rawBatchResults)) {
            const lowerKey = key.toLowerCase().trim()
            if (!(lowerKey in batchResults)) {
                batchResults[lowerKey] = value
            }
        }

        // Match Gemini's returned keys against the requested names.
        //
        // Gemini occasionally returns keys with cosmetic differences (trailing
        // punctuation, doubled whitespace, mixed case). We tolerate those.
        //
        // We do NOT tolerate substring overlap: "Salt" and "Sea Salt" are
        // different ingredients, and matching one to the other's analysis
        // text would silently mislabel safety. The previous code did exactly
        // that via `includes()` checks — fixed here to require a normalized
        // exact match only.
        const normalizeKey = (s: string) =>
            s.toLowerCase().replace(/[.,;:!?]+$/g, '').replace(/\s+/g, ' ').trim()

        const normalizedBatchIndex = new Map<string, string>()
        for (const batchKey of Object.keys(batchResults)) {
            const norm = normalizeKey(batchKey)
            if (!normalizedBatchIndex.has(norm)) {
                normalizedBatchIndex.set(norm, batchKey)
            }
        }

        for (const name of stillNeedsGemini) {
            const lowerName = name.toLowerCase()
            if (lowerName in batchResults) continue

            const normalizedName = normalizeKey(name)
            const hit = normalizedBatchIndex.get(normalizedName)
            if (hit && hit !== lowerName) {
                batchResults[lowerName] = batchResults[hit]
            }
        }
    }

    // Merge pre-filtered results with Gemini batch results
    batchResults = { ...preFilteredResults, ...batchResults }

    // E. Merge Results — use pre-fetched enriched data (no per-ingredient API calls)
    for (const item of productData.ingredients) {
        const name = item.name
        const lowerName = name.toLowerCase()
        let analysis

        // 1. Get Base Analysis (Cache or Batch)
        if (cachedMap.has(lowerName)) {
            console.log(`Using cache for: ${name}`)
            analysis = cachedMap.get(lowerName)
        } else {
            // Get from batch result using lowercase key
            const analysisData = batchResults[lowerName]

            // Check if we actually got data. If not, use fallback but DO NOT SAVE to DB.
            const isValidAnalysis = !!analysisData
            const finalAnalysisData = analysisData || {
                simple_name: "Analysis pending",
                safety_verdict: "Caution",
                concerns: ["Could not verify in batch"]
            }

            // 2. Use pre-fetched enriched data (already fetched in parallel before Gemini)
            const officialData = enrichedData[name] || {
                cas_number: "Unknown",
                fda_reports: 0,
                epa_link: null,
                pubchem: null,
                fda_recalls: null,
                sources_checked: [],
            }

            let concerns = finalAnalysisData.concerns || []
            let safetyVerdict = finalAnalysisData.safety_verdict || "Caution"
            const geminiVerdict = safetyVerdict.toUpperCase()

            // FDA data is INFO-ONLY — added to concerns for transparency but
            // NEVER directly changes the safety verdict. FDA recalls are mostly about
            // batch contamination or labeling errors, not ingredient safety.
            if (officialData.fda_reports > 0) {
                concerns.push(`FDA Adverse Events: ${officialData.fda_reports} reports filed.`)
            }
            if (officialData.fda_recalls && officialData.fda_recalls.total_recalls > 0) {
                concerns.push(`FDA Recalls: ${officialData.fda_recalls.total_recalls} recall(s) found.`)
            }
            if (officialData.cas_number !== "Unknown") {
                 finalAnalysisData.chemical_formula = `${finalAnalysisData.chemical_formula || ''} (CAS: ${officialData.cas_number})`
            }

            // Apply rule-based verdict escalation using regulatory data
            const escalationResult = escalateVerdictFromRegulatoryData(
                name,
                geminiVerdict,
                enrichedData[name] || null,
                concerns
            )

            safetyVerdict = escalationResult.verdict
            concerns = escalationResult.concerns

            // Populate banned_in from enriched data
            const bannedCountries = Array.isArray(finalAnalysisData.banned_countries) ? finalAnalysisData.banned_countries : []

            // Flat fields for DB storage
            const analysisToSave: any = {
                name,
                analyzed_count: 1,
                simple_name: finalAnalysisData.simple_name || "Analysis unavailable",
                chemical_formula: finalAnalysisData.chemical_formula,
                raw_materials: finalAnalysisData.raw_materials,
                common_uses: finalAnalysisData.common_uses,
                fda_status: finalAnalysisData.regulatory_status?.us_fda || "N/A",
                eu_status: finalAnalysisData.regulatory_status?.eu_efsa || finalAnalysisData.regulatory_status?.eu_cosing || "N/A",
                who_status: finalAnalysisData.regulatory_status?.who_iarc || "N/A",
                banned_in: bannedCountries.length > 0 ? bannedCountries : [],
                safe_limit: finalAnalysisData.regulatory_status?.india_fssai || "N/A",
                concerns: concerns,
                category: safetyVerdict
            }

            // ONLY Save to DB if we actually got a valid analysis from Gemini
            if (isValidAnalysis) {
                const ingId = generateId()
                try {
                    // Check for existing entry (case-insensitive) before inserting
                    const existing = await queryOne<{ id: string }>('SELECT id FROM ingredients WHERE LOWER(name) = LOWER(?)', [analysisToSave.name])
                    if (existing) {
                        console.log(`[Analysis] Skipping DB save for ${name} (case-insensitive match exists)`)
                    } else {
                    await execute(
                        `INSERT INTO ingredients (id, name, analyzed_count, simple_name, chemical_formula, raw_materials, common_uses, fda_status, eu_status, who_status, banned_in, safe_limit, concerns, category)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                         ON CONFLICT(name) DO NOTHING`,
                        [ingId, analysisToSave.name, analysisToSave.analyzed_count, analysisToSave.simple_name,
                         analysisToSave.chemical_formula,
                         typeof analysisToSave.raw_materials === 'string' ? analysisToSave.raw_materials : JSON.stringify(analysisToSave.raw_materials || null),
                         typeof analysisToSave.common_uses === 'string' ? analysisToSave.common_uses : JSON.stringify(analysisToSave.common_uses || null),
                         analysisToSave.fda_status, analysisToSave.eu_status, analysisToSave.who_status,
                         JSON.stringify(analysisToSave.banned_in), analysisToSave.safe_limit,
                         JSON.stringify(analysisToSave.concerns), analysisToSave.category]
                    )
                    }
                } catch (e) {
                    console.error(`[Analysis] DB save failed for ${name}:`, e)
                }
                analysis = analysisToSave
            } else {
                console.warn(`Skipping DB save for ${name} (Batch analysis failed)`)
                analysis = analysisToSave
            }

            // Enrich with Gemini's structured data for rich UI display
            analysis.regulatory_status = finalAnalysisData.regulatory_status
            analysis.safety_limits = finalAnalysisData.safety_limits
            analysis.safety_limits_per_100g = finalAnalysisData.safety_limits_per_100g
            analysis.how_its_made = finalAnalysisData.how_its_made
            analysis.sources_cited = finalAnalysisData.sources_cited || []
            analysis.banned_countries = finalAnalysisData.banned_countries || []
            analysis.restricted_countries = finalAnalysisData.restricted_countries || []
            analysis.epa_link = officialData.epa_link
            analysis.pubchem_url = officialData.pubchem?.pubchem_url || null
            analysis.limit_exceeded = finalAnalysisData.limit_exceeded || null
            analysis.regional_ban_conflicts = finalAnalysisData.regional_ban_conflicts || []
            analysis.sources_checked = officialData.sources_checked || []
        }

        analyzedIngredients.push({
            ...item,
            analysis,
        })
    }

    // Batch translate all ingredients in ONE Gemini call instead of per-ingredient
    if (language.toLowerCase() !== 'english' && analyzedIngredients.length > 0) {
        try {
            const translationInput = analyzedIngredients
                .filter(item => item.analysis)
                .map((item, i) => `[${i}] ${item.analysis.simple_name || ''} | ${Array.isArray(item.analysis.concerns) ? item.analysis.concerns.join(', ') : (item.analysis.concerns || '')}`)
                .join('\n')

            const translated = await translateContent(translationInput, language)
            const lines = translated.split('\n')

            for (const line of lines) {
                const match = line.match(/^\[(\d+)\]\s*(.*)/)
                if (match) {
                    const idx = parseInt(match[1])
                    if (idx >= 0 && idx < analyzedIngredients.length && analyzedIngredients[idx].analysis) {
                        analyzedIngredients[idx].analysis.translated_text = match[2].trim()
                    }
                }
            }
            console.log(`[Analysis] Batch translated ${lines.length} ingredients to ${language}`)
        } catch (e) {
            console.warn('[Analysis] Batch translation failed, returning English:', (e as Error).message)
        }
    }

    return {
        productId,
        productData,
        ingredients: analyzedIngredients,
        scannedCount: existingScannedCount + 1,
        ocrSources,
    }
}