/**
 * Allergen-profile matching.
 *
 * The user sets a list of allergens once (stored in localStorage, never
 * sent to the server). On every result we surface any matching ingredients
 * at the top of the report. Matching is intentionally lenient: lowercase
 * substring with a small alias map, because real labels write the same
 * allergen 4 different ways (peanut / peanuts / groundnut / arachis).
 *
 * Important: this is a CONVENIENCE filter, not a medical safety device.
 * The disclaimer on the UI must make that clear.
 */

export const COMMON_ALLERGENS: ReadonlyArray<{
    key: string
    label: string
    aliases: string[]
}> = [
    { key: 'milk',     label: 'Milk / dairy',      aliases: ['milk', 'dairy', 'lactose', 'whey', 'casein', 'butter', 'cream', 'ghee', 'cheese', 'yogurt', 'curd', 'paneer'] },
    { key: 'egg',      label: 'Egg',               aliases: ['egg', 'eggs', 'albumen', 'albumin', 'ovalbumin', 'lecithin (egg)'] },
    { key: 'peanut',   label: 'Peanut',            aliases: ['peanut', 'peanuts', 'groundnut', 'groundnuts', 'arachis'] },
    { key: 'treenut',  label: 'Tree nuts',         aliases: ['almond', 'almonds', 'cashew', 'cashews', 'walnut', 'walnuts', 'pistachio', 'pistachios', 'pecan', 'pecans', 'hazelnut', 'hazelnuts', 'macadamia', 'brazil nut', 'pine nut'] },
    { key: 'soy',      label: 'Soy / soya',        aliases: ['soy', 'soya', 'soybean', 'soya bean', 'tofu', 'edamame', 'tempeh'] },
    { key: 'wheat',    label: 'Wheat / gluten',    aliases: ['wheat', 'gluten', 'atta', 'maida', 'durum', 'semolina', 'spelt', 'farro', 'barley', 'rye'] },
    { key: 'fish',     label: 'Fish',              aliases: ['fish', 'cod', 'salmon', 'tuna', 'anchovy', 'sardine', 'mackerel', 'tilapia'] },
    { key: 'shellfish',label: 'Shellfish',         aliases: ['shrimp', 'prawn', 'lobster', 'crab', 'crayfish', 'shellfish'] },
    { key: 'sesame',   label: 'Sesame',            aliases: ['sesame', 'til', 'tahini', 'gingelly'] },
    { key: 'mustard',  label: 'Mustard',           aliases: ['mustard', 'mustard seed', 'mustard powder', 'rai', 'sarson'] },
    { key: 'sulphites',label: 'Sulphites',         aliases: ['sulphite', 'sulfite', 'sulphur dioxide', 'sulfur dioxide', 'e220', 'e221', 'e222', 'e223', 'e224', 'e225', 'e226', 'e227', 'e228'] },
    { key: 'msg',      label: 'MSG',               aliases: ['monosodium glutamate', 'msg', 'e621'] },
    { key: 'aspartame',label: 'Aspartame',         aliases: ['aspartame', 'phenylalanine', 'e951'] },
    { key: 'caffeine', label: 'Caffeine',          aliases: ['caffeine', 'coffee', 'guarana'] },
    { key: 'alcohol',  label: 'Alcohol',           aliases: ['alcohol', 'ethanol', 'wine', 'beer'] },
] as const

export interface AllergenMatch {
    allergenKey: string
    allergenLabel: string
    ingredientName: string
    matchedAlias: string
}

/**
 * Match an ingredient name against the user's selected allergens. Returns
 * one entry per (allergen, alias) hit so the UI can render them grouped.
 *
 * Matching rules:
 *   - case-insensitive
 *   - whole-word with optional plural-s tolerance
 *   - the alias must be a complete token, not a substring of a longer word
 *     ("oat milk" matches "milk", but "almond" does NOT match the alias
 *     "milk" even though "alm" contains "m")
 *
 * Performance: O(active_allergens * aliases). With the default 15 categories
 * × ~6 aliases each, that's <100 substring checks per ingredient, well below
 * any noticeable cost even for a 50-ingredient list.
 */
export function matchAllergens(
    ingredientName: string,
    activeAllergenKeys: ReadonlyArray<string>,
): AllergenMatch[] {
    if (!ingredientName || activeAllergenKeys.length === 0) return []
    const haystack = ` ${ingredientName.toLowerCase()} `

    const hits: AllergenMatch[] = []
    for (const allergen of COMMON_ALLERGENS) {
        if (!activeAllergenKeys.includes(allergen.key)) continue
        for (const alias of allergen.aliases) {
            // Whole-token match with word boundaries. We use a regex literal
            // so plural-s ("peanuts", "almonds") matches "peanut" / "almond".
            // \b is fine here because aliases are ASCII.
            const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
            const re = new RegExp(`\\b${escaped}s?\\b`, 'i')
            if (re.test(haystack)) {
                hits.push({
                    allergenKey: allergen.key,
                    allergenLabel: allergen.label,
                    ingredientName,
                    matchedAlias: alias,
                })
                break // one hit per allergen per ingredient is plenty for the UI
            }
        }
    }
    return hits
}

const STORAGE_KEY = 'ct_allergen_profile_v1'

/** Load the user's allergen keys from localStorage. Safe on SSR. */
export function loadAllergenProfile(): string[] {
    if (typeof window === 'undefined') return []
    try {
        const raw = window.localStorage.getItem(STORAGE_KEY)
        if (!raw) return []
        const parsed = JSON.parse(raw)
        if (!Array.isArray(parsed)) return []
        const valid = new Set(COMMON_ALLERGENS.map(a => a.key))
        return parsed.filter((k: unknown) => typeof k === 'string' && valid.has(k))
    } catch {
        return []
    }
}

/** Save the user's allergen keys. Idempotent. */
export function saveAllergenProfile(keys: string[]): void {
    if (typeof window === 'undefined') return
    try {
        const valid = new Set(COMMON_ALLERGENS.map(a => a.key))
        const clean = keys.filter(k => valid.has(k))
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(clean))
    } catch {
        // Quota / private-mode failure — non-blocking.
    }
}
