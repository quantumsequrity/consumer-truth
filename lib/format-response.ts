// Shared response formatter for WhatsApp and Telegram webhooks.
// Extracts duplicated formatting logic into a single module.

interface IngredientAnalysis {
  name: string
  analysis: {
    category?: string
    safety_verdict?: string
    simple_name?: string
    concerns?: string[]
    banned_in?: string[]
    banned_countries?: string[]
    safety_limits_per_100g?: {
      plain_english?: string
      india_fssai?: string
      eu?: string
      [key: string]: string | undefined
    }
    how_its_made?: string
    [key: string]: any
  }
}

interface AnalysisResult {
  productData: {
    product_name: string
    brand?: string
  }
  ingredients: IngredientAnalysis[]
}

interface FormatOptions {
  showHowItsMade?: boolean // Only for single-ingredient deep-dive
  isProductNameLookup?: boolean // Show photo nudge when ingredients are AI-estimated
}

interface FormattedReport {
  responseText: string
  voiceSummary: string
  safeCount: number
  cautionCount: number
  avoidCount: number
}

export function formatIngredientReport(result: AnalysisResult, options: FormatOptions = {}): FormattedReport {
  const { showHowItsMade = false, isProductNameLookup = false } = options
  const product = result.productData

  let safeCount = 0
  let cautionCount = 0
  let avoidCount = 0
  const topConcerns: string[] = []

  // Count ALL ingredients for summary
  for (const item of result.ingredients) {
    const verdict = getVerdict(item)
    if (verdict === 'BANNED' || verdict === 'AVOID') {
      avoidCount++
      if (topConcerns.length < 3) topConcerns.push(`${item.name} (${verdict})`)
    } else if (verdict === 'CAUTION') {
      cautionCount++
      if (topConcerns.length < 3) topConcerns.push(`${item.name} (${verdict})`)
    } else {
      safeCount++
    }
  }

  // Build header
  let responseText = `*${product.product_name}* - ${product.brand || 'Unknown Brand'}\n\n`
  responseText += `Found ${result.ingredients.length} ingredients.\n`
  responseText += `---\n\n`

  // Build ALL ingredient entries — no truncation
  for (const item of result.ingredients) {
    const analysis = item.analysis
    const verdict = getVerdict(item)
    const icon = getIcon(verdict)

    responseText += `[${icon}] *${item.name}*\n`

    // simple_name shown for ALL ingredients
    if (analysis.simple_name) {
      responseText += `${analysis.simple_name}\n`
    }

    // safety_limits_per_100g.plain_english shown for CAUTION/AVOID/BANNED only
    const hasConcerns = verdict === 'CAUTION' || verdict === 'AVOID' || verdict === 'BANNED'

    if (hasConcerns && analysis.safety_limits_per_100g?.plain_english) {
      responseText += `Limit: ${analysis.safety_limits_per_100g.plain_english}\n`
    }

    if (hasConcerns && analysis.concerns && analysis.concerns.length > 0) {
      responseText += `Concerns: ${analysis.concerns.slice(0, 2).join(', ')}\n`
    }

    if (analysis.banned_in && analysis.banned_in.length > 0) {
      responseText += `Banned in: ${analysis.banned_in.join(', ')}\n`
    } else if (analysis.banned_countries && analysis.banned_countries.length > 0) {
      responseText += `Banned in: ${analysis.banned_countries.join(', ')}\n`
    }

    // how_its_made only shown on single-ingredient deep-dive
    if (showHowItsMade && analysis.how_its_made) {
      responseText += `How it's made: ${analysis.how_its_made}\n`
    }

    responseText += `\n`
  }

  responseText += `---\n`
  responseText += `*Summary* (${result.ingredients.length} total):\n`
  responseText += `Safe: ${safeCount} | Caution: ${cautionCount} | Avoid: ${avoidCount}\n\n`
  responseText += `Reply with an ingredient name for more details.\n`
  if (isProductNameLookup) {
    responseText += `\n_Note: These are AI-estimated ingredients. For exact results, send a photo of the ingredients list on the back of the pack._\n`
  }
  responseText += `\n_Disclaimer: Educational info only. Sources: FDA/EU/WHO/BIS/FSSAI/PubChem. Consult a professional for health advice._`

  // Build voice summary — richer version with per-ingredient details
  const safetyScore = result.ingredients.length > 0
    ? Math.round((safeCount / Math.max(result.ingredients.length, 1)) * 10)
    : 0
  const concernsList = topConcerns.length > 0
    ? `Top concerns: ${topConcerns.join(', ')}.`
    : 'No major concerns found.'

  let voiceSummary = `${product.product_name}. Safety score: ${safetyScore} out of 10. Found ${result.ingredients.length} ingredients. ${safeCount} safe, ${cautionCount} caution, ${avoidCount} avoid. ${concernsList}`

  // Add per-ingredient details for non-safe ingredients (up to ~3000 chars total)
  const flaggedIngredients = result.ingredients.filter(item => {
    const v = getVerdict(item)
    return v === 'BANNED' || v === 'AVOID' || v === 'CAUTION'
  })
  if (flaggedIngredients.length > 0) {
    voiceSummary += ' Here are the details.'
    for (const item of flaggedIngredients) {
      if (voiceSummary.length > 3200) break
      const v = getVerdict(item)
      const simpleName = item.analysis.simple_name ? `, also known as ${item.analysis.simple_name}` : ''
      const concerns = item.analysis.concerns?.filter(c => c !== 'None' && c !== 'No concerns')?.slice(0, 2) || []
      const concernText = concerns.length > 0 ? ` Concerns: ${concerns.join('. ')}.` : ''
      const bannedIn = item.analysis.banned_in || item.analysis.banned_countries || []
      const bannedText = bannedIn.length > 0 ? ` Banned in ${bannedIn.slice(0, 3).join(', ')}.` : ''
      voiceSummary += ` ${item.name}${simpleName}. Verdict: ${v.toLowerCase()}.${concernText}${bannedText}`
    }
  }

  return { responseText, voiceSummary, safeCount, cautionCount, avoidCount }
}

function getVerdict(item: IngredientAnalysis): string {
  return (item.analysis.category || item.analysis.safety_verdict || 'CAUTION').toUpperCase()
}

function getIcon(verdict: string): string {
  if (verdict === 'BANNED') return 'BANNED'
  if (verdict === 'AVOID') return 'DANGER'
  if (verdict === 'CAUTION') return 'CAUTION'
  return 'SAFE'
}
