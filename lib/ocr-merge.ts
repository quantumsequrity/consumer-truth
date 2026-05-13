// Multi-source OCR merge: union-dedup ingredients from Gemini, Workers AI, and Tesseract

export interface OcrSource {
  name: 'gemini' | 'workersai' | 'tesseract'
  ingredients: string[]
  productName?: string
  brand?: string
  category?: string
}

export interface MergeResult {
  product_name: string
  brand: string
  category: string
  ingredients: { name: string; percentage: string }[]
  ocrSources: string[]
  primarySource: string
}

// Noise patterns for raw Tesseract OCR text
const TESSERACT_NOISE_PATTERNS = [
  /^net\s*w[te]/i,
  /^mfg/i,
  /^exp/i,
  /^best\s*before/i,
  /^use\s*by/i,
  /^batch/i,
  /^lot/i,
  /^pkg/i,
  /^mrp/i,
  /^price/i,
  /^rs\.?/i,
  /^ingredients\s*:?\s*$/i,
  /^contains\s*:?\s*$/i,
  /^allergen/i,
  /^may\s*contain/i,
  /^store\s*(in|at|below)/i,
  /^manufactured\s*by/i,
  /^marketed\s*by/i,
  /^packed\s*by/i,
  /^fssai/i,
  /^lic\s*no/i,
  /^\d+\s*(g|kg|ml|l|oz|lb|mg)\b/i,
  /^serving\s*size/i,
  /^nutrition/i,
  /^energy/i,
  /^protein/i,
  /^total\s*(fat|carb)/i,
  /^calories/i,
]

// Junk tokens that ALL sources (including Gemini) may produce —
// these are label notes, warnings, or purpose descriptions, NOT ingredients
const JUNK_INGREDIENT_PATTERNS = [
  /^preserves?\s+(freshness|color|colour|flavor|flavour)/i,
  /^to\s+(protect|preserve|maintain|prevent|improve|enhance)\s/i,
  /^for\s+(color|colour|freshness|flavor|flavour|texture)/i,
  /^added\s+(to|for|as)\s/i,
  /^as\s+a?\s*(preservative|stabilizer|emulsifier|thickener|antioxidant)$/i,
  /^contains\s+/i,
  /^phenylketonurics/i,
  /^phenylalanine\s*source/i,
  /^see\s+(cap|lid|label|pack)/i,
  /^keep\s+(refrigerated|frozen|cool|dry)/i,
  /^shake\s+well/i,
  /^serve\s+(chilled|cold|warm)/i,
  /^best\s+served/i,
  /^not\s+a\s+significant/i,
  /^percent\s+daily/i,
  /^daily\s+value/i,
  /^\*?\s*percent\s/i,
  /^produced\s+(in|at|by)/i,
  /^distributed\s+by/i,
  /^imported\s+by/i,
  /^warning/i,
  /^caution/i,
  /^disclaimer/i,
]

/**
 * Check if a token is a junk/noise ingredient name (label note, not a real ingredient).
 */
function isJunkIngredient(name: string): boolean {
  const trimmed = name.trim()
  if (trimmed.length < 2) return true
  for (const pattern of JUNK_INGREDIENT_PATTERNS) {
    if (pattern.test(trimmed)) return true
  }
  return false
}

/**
 * Parse raw OCR text (from Tesseract) into an ingredient list.
 * Splits on commas, semicolons, newlines. Filters noise and junk tokens.
 */
export function parseRawOcrToIngredients(rawText: string): string[] {
  if (!rawText || rawText.trim().length < 3) return []

  // Try to find the ingredients section
  const ingredientsMatch = rawText.replace(/\n/g, ' ').match(/ingredients\s*:?\s*(.+)/i)
  const textToProcess = ingredientsMatch ? ingredientsMatch[1] : rawText

  // Split on commas, semicolons, newlines
  const tokens = textToProcess
    .split(/[,;\n]+/)
    .map(t => t.trim())
    .map(t => t.replace(/\(.*?\)/g, match => match)) // preserve parenthetical content
    .filter(t => t.length >= 2)
    .filter(t => !/^\d+\.?\d*$/.test(t)) // pure numbers
    .filter(t => !/^\d+\s*%$/.test(t))   // pure percentages
    .filter(t => {
      for (const pattern of TESSERACT_NOISE_PATTERNS) {
        if (pattern.test(t)) return false
      }
      return true
    })
    .map(t => {
      // Clean up leading/trailing special chars
      return t.replace(/^[\s\-•*]+/, '').replace(/[\s\-•*.]+$/, '').trim()
    })
    .filter(t => t.length >= 2)

  return tokens
}

/**
 * Case-insensitive dedup.
 *
 * Previously this used a substring "dominator" rule: if one name was a
 * substring of another, drop the shorter. That collapsed real ingredient
 * pairs like ["Salt", "Sea Salt"] into ["Sea Salt"] and made "Salt" vanish
 * from the analysis, which is wrong — they are different ingredients with
 * different regulatory profiles.
 *
 * The replacement is the boring, correct version: exact (case-insensitive,
 * whitespace-collapsed) match drops the duplicate; everything else is kept.
 * Order of first appearance is preserved.
 */
function deduplicateIngredients(allNames: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []

  for (const raw of allNames) {
    const original = raw.trim()
    if (!original) continue

    // Normalize for matching: lowercase, collapse internal whitespace.
    const key = original.toLowerCase().replace(/\s+/g, ' ')
    if (seen.has(key)) continue

    seen.add(key)
    result.push(original)
  }

  return result
}

// Parent ingredient names that precede E-number/INS codes
const CODE_PARENT_PATTERNS = [
  /^(flavou?r\s*enhancer)$/i,
  /^(thickener)$/i,
  /^(acidity\s*regulator)$/i,
  /^(colou?r)$/i,
  /^(emulsifier)$/i,
  /^(stabiliser|stabilizer)$/i,
  /^(preservative)$/i,
  /^(antioxidant)$/i,
  /^(raising\s*agent)$/i,
  /^(humectant)$/i,
  /^(gelling\s*agent)$/i,
  /^(anti[- ]?caking\s*agent)$/i,
  /^(sequestrant)$/i,
  /^(firming\s*agent)$/i,
  /^(glazing\s*agent)$/i,
  /^(mineral)s?$/i,
  /^(vitamin)s?$/i,
]

/**
 * Rejoin orphaned E-numbers/INS codes with their preceding parent ingredient.
 * e.g. ["Flavour enhancer", "635", "Palm oil"] → ["Flavour enhancer (635)", "Palm oil"]
 */
function rejoinOrphanedCodes(names: string[]): string[] {
  const result: string[] = []

  for (let i = 0; i < names.length; i++) {
    const current = names[i].trim()

    // Check if current is a bare code (pure number or E-number like "E150d", "150d", "635")
    const isCode = /^[Ee]?\d{3,4}[a-z]?$/i.test(current)

    if (isCode && result.length > 0) {
      const prev = result[result.length - 1]
      const isParent = CODE_PARENT_PATTERNS.some(p => p.test(prev))

      if (isParent) {
        // Merge: "Flavour enhancer" + "635" → "Flavour enhancer (635)"
        result[result.length - 1] = `${prev} (${current})`
        continue
      }
    }

    result.push(current)
  }

  return result
}

/**
 * Merge OCR results from up to 3 sources using union strategy.
 * Priority for metadata: Gemini > Workers AI > Tesseract
 * Ingredients: union of all sources, deduplicated.
 */
export function mergeOcrResults({
  gemini,
  workersAI,
  tesseractRaw,
}: {
  gemini: { product_name: string; brand: string; category: string; ingredients: { name: string; percentage: string }[] } | null
  workersAI: { product_name: string; brand: string; category: string; ingredients: string[] } | null
  tesseractRaw: string
}): MergeResult {
  const sources: OcrSource[] = []
  const allIngredientNames: string[] = []

  // Collect Gemini ingredients
  if (gemini && gemini.ingredients && gemini.ingredients.length > 0) {
    const names = gemini.ingredients.map(i => i.name)
    sources.push({
      name: 'gemini',
      ingredients: names,
      productName: gemini.product_name,
      brand: gemini.brand,
      category: gemini.category,
    })
    allIngredientNames.push(...names)
  }

  // Collect Workers AI ingredients
  if (workersAI && workersAI.ingredients && workersAI.ingredients.length > 0) {
    sources.push({
      name: 'workersai',
      ingredients: workersAI.ingredients,
      productName: workersAI.product_name,
      brand: workersAI.brand,
      category: workersAI.category,
    })
    allIngredientNames.push(...workersAI.ingredients)
  }

  // Collect Tesseract ingredients
  const tesseractIngredients = parseRawOcrToIngredients(tesseractRaw)
  if (tesseractIngredients.length > 0) {
    sources.push({
      name: 'tesseract',
      ingredients: tesseractIngredients,
    })
    allIngredientNames.push(...tesseractIngredients)
  }

  if (sources.length === 0) {
    throw new Error('All OCR sources failed — no ingredients extracted')
  }

  // Determine primary source for metadata
  const primarySource = sources[0] // first available in priority order (gemini > workersai > tesseract)

  // Product metadata: prefer Gemini > Workers AI > Tesseract first-line
  const product_name = sources.find(s => s.productName)?.productName || 'Unknown Product'
  const brand = sources.find(s => s.brand)?.brand || ''
  const category = sources.find(s => s.category)?.category || 'food'

  // Rejoin orphaned E-numbers/INS codes with their parent ingredient
  // e.g. ["Flavour enhancer", "635"] → ["Flavour enhancer (635)"]
  const rejoined = rejoinOrphanedCodes(allIngredientNames)

  // Union-deduplicate ingredients, then filter junk from ALL sources
  const mergedNames = deduplicateIngredients(rejoined)
    .filter(name => !isJunkIngredient(name))

  // Build final ingredients list, preserving percentages from Gemini where available
  const geminiPercentageMap = new Map<string, string>()
  if (gemini?.ingredients) {
    for (const ing of gemini.ingredients) {
      geminiPercentageMap.set(ing.name.toLowerCase(), ing.percentage || '')
    }
  }

  const ingredients = mergedNames.map(name => ({
    name,
    percentage: geminiPercentageMap.get(name.toLowerCase()) || '',
  }))

  return {
    product_name,
    brand,
    category,
    ingredients,
    ocrSources: sources.map(s => s.name),
    primarySource: primarySource.name,
  }
}
