#!/usr/bin/env npx tsx
/**
 * Import nutrition data from Open Food Facts CSV into D1 SQL file.
 * Links to FOOD_DB via `code` (barcode).
 *
 * Usage:  npx tsx scripts/import-nutrition.ts
 * Import: npx wrangler d1 execute alzhal-nutrition --remote --file=scripts/d1-nutrition.sql
 */

import { createReadStream, createWriteStream, existsSync } from 'fs'
import { createInterface } from 'readline'
import path from 'path'

const BATCH_SIZE = 20
const PRODS_DIR = path.join(process.cwd(), 'prods')
const OUTPUT_FILE = path.join(process.cwd(), 'scripts', 'd1-nutrition.sql')

const CSV_CANDIDATES = [
  'en.openfoodfacts.org.products.csv',
  'en.openfoodfacts.org.products.tsv',
]

// Columns for the nutrition database
const COLUMN_MAP: Record<string, string> = {
  'code': 'code',
  'serving_size': 'serving_size',
  'serving_quantity': 'serving_quantity',
  'energy-kcal_100g': 'energy_kcal_100g',
  'energy-kj_100g': 'energy_kj_100g',
  'fat_100g': 'fat_100g',
  'saturated-fat_100g': 'saturated_fat_100g',
  'trans-fat_100g': 'trans_fat_100g',
  'cholesterol_100g': 'cholesterol_100g',
  'carbohydrates_100g': 'carbohydrates_100g',
  'sugars_100g': 'sugars_100g',
  'added-sugars_100g': 'added_sugars_100g',
  'fiber_100g': 'fiber_100g',
  'proteins_100g': 'proteins_100g',
  'salt_100g': 'salt_100g',
  'sodium_100g': 'sodium_100g',
  'vitamin-a_100g': 'vitamin_a_100g',
  'vitamin-c_100g': 'vitamin_c_100g',
  'vitamin-d_100g': 'vitamin_d_100g',
  'vitamin-e_100g': 'vitamin_e_100g',
  'vitamin-b1_100g': 'vitamin_b1_100g',
  'vitamin-b2_100g': 'vitamin_b2_100g',
  'vitamin-b6_100g': 'vitamin_b6_100g',
  'vitamin-b9_100g': 'vitamin_b9_100g',
  'vitamin-b12_100g': 'vitamin_b12_100g',
  'calcium_100g': 'calcium_100g',
  'iron_100g': 'iron_100g',
  'magnesium_100g': 'magnesium_100g',
  'potassium_100g': 'potassium_100g',
  'zinc_100g': 'zinc_100g',
  'phosphorus_100g': 'phosphorus_100g',
  'iodine_100g': 'iodine_100g',
  'caffeine_100g': 'caffeine_100g',
  'alcohol_100g': 'alcohol_100g',
  'nutriscore_score': 'nutriscore_score',
  'nutrition-score-fr_100g': 'nutrition_score_fr_100g',
}

const DB_COLUMNS = [
  'code', 'serving_size', 'serving_quantity',
  'energy_kcal_100g', 'energy_kj_100g', 'fat_100g', 'saturated_fat_100g',
  'trans_fat_100g', 'cholesterol_100g', 'carbohydrates_100g', 'sugars_100g',
  'added_sugars_100g', 'fiber_100g', 'proteins_100g', 'salt_100g', 'sodium_100g',
  'vitamin_a_100g', 'vitamin_c_100g', 'vitamin_d_100g', 'vitamin_e_100g',
  'vitamin_b1_100g', 'vitamin_b2_100g', 'vitamin_b6_100g', 'vitamin_b9_100g',
  'vitamin_b12_100g', 'calcium_100g', 'iron_100g', 'magnesium_100g',
  'potassium_100g', 'zinc_100g', 'phosphorus_100g', 'iodine_100g',
  'caffeine_100g', 'alcohol_100g', 'nutriscore_score', 'nutrition_score_fr_100g',
]

function findCsvFile(): string | null {
  const arg = process.argv[2]
  if (arg) {
    const resolved = path.resolve(arg)
    if (existsSync(resolved)) return resolved
    process.exit(1)
  }
  for (const name of CSV_CANDIDATES) {
    const full = path.join(PRODS_DIR, name)
    if (existsSync(full)) return full
  }
  return null
}

function detectSeparator(line: string): string {
  return (line.match(/\t/g) || []).length > (line.match(/,/g) || []).length ? '\t' : ','
}

function splitLine(line: string, sep: string): string[] {
  const fields: string[] = []
  let current = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      if (inQuotes && i + 1 < line.length && line[i + 1] === '"') { current += '"'; i++ }
      else inQuotes = !inQuotes
    } else if (ch === sep && !inQuotes) { fields.push(current); current = '' }
    else current += ch
  }
  fields.push(current)
  return fields
}

function sqlEscape(s: string): string {
  return s ? s.replace(/'/g, "''") : ''
}

async function main() {
  const csvPath = findCsvFile()
  if (!csvPath) { console.error('No CSV file found'); process.exit(1) }

  console.log(`Reading: ${csvPath}`)
  console.log(`Output:  ${OUTPUT_FILE}`)

  const rl = createInterface({ input: createReadStream(csvPath, { encoding: 'utf-8' }), crlfDelay: Infinity })
  const out = createWriteStream(OUTPUT_FILE, { encoding: 'utf-8' })

  // Schema
  out.write(`-- Nutrition data from Open Food Facts
-- Generated: ${new Date().toISOString()}

CREATE TABLE IF NOT EXISTS food_nutrition (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT,
  serving_size TEXT,
  serving_quantity TEXT,
  energy_kcal_100g TEXT,
  energy_kj_100g TEXT,
  fat_100g TEXT,
  saturated_fat_100g TEXT,
  trans_fat_100g TEXT,
  cholesterol_100g TEXT,
  carbohydrates_100g TEXT,
  sugars_100g TEXT,
  added_sugars_100g TEXT,
  fiber_100g TEXT,
  proteins_100g TEXT,
  salt_100g TEXT,
  sodium_100g TEXT,
  vitamin_a_100g TEXT,
  vitamin_c_100g TEXT,
  vitamin_d_100g TEXT,
  vitamin_e_100g TEXT,
  vitamin_b1_100g TEXT,
  vitamin_b2_100g TEXT,
  vitamin_b6_100g TEXT,
  vitamin_b9_100g TEXT,
  vitamin_b12_100g TEXT,
  calcium_100g TEXT,
  iron_100g TEXT,
  magnesium_100g TEXT,
  potassium_100g TEXT,
  zinc_100g TEXT,
  phosphorus_100g TEXT,
  iodine_100g TEXT,
  caffeine_100g TEXT,
  alcohol_100g TEXT,
  nutriscore_score TEXT,
  nutrition_score_fr_100g TEXT
);

CREATE INDEX IF NOT EXISTS idx_nutrition_code ON food_nutrition(code);

`)

  let lineNum = 0
  let headers: string[] = []
  let separator = '\t'
  const columnMapping: { srcIndex: number; destColumn: string }[] = []
  let batch: string[][] = []
  let totalWritten = 0
  let skipped = 0

  for await (const line of rl) {
    lineNum++

    if (lineNum === 1) {
      separator = detectSeparator(line)
      headers = splitLine(line, separator).map(h => h.trim().replace(/^"|"$/g, '').toLowerCase())
      for (let i = 0; i < headers.length; i++) {
        const dest = COLUMN_MAP[headers[i]]
        if (dest) columnMapping.push({ srcIndex: i, destColumn: dest })
      }
      console.log(`Mapped ${columnMapping.length} nutrition columns`)
      continue
    }

    const fields = splitLine(line, separator)
    const row: Record<string, string> = {}
    let hasNutrition = false

    for (const { srcIndex, destColumn } of columnMapping) {
      const value = (fields[srcIndex] || '').replace(/^"|"$/g, '').trim().slice(0, 200)
      if (value && (!row[destColumn] || row[destColumn] === '')) {
        row[destColumn] = value
        if (destColumn !== 'code' && destColumn !== 'serving_size' && destColumn !== 'serving_quantity') {
          hasNutrition = true
        }
      } else if (!row[destColumn]) {
        row[destColumn] = ''
      }
    }

    // Skip if no code or no nutrition data at all
    if (!row.code || !hasNutrition) { skipped++; continue }

    const values = DB_COLUMNS.map(col => sqlEscape(row[col] || ''))
    batch.push(values)

    if (batch.length >= BATCH_SIZE) {
      writeBatch(out, batch)
      totalWritten += batch.length
      batch = []
      if (totalWritten % 50000 === 0) {
        console.log(`  ... ${totalWritten.toLocaleString()} rows (line ${lineNum.toLocaleString()})`)
      }
    }
  }

  if (batch.length > 0) { writeBatch(out, batch); totalWritten += batch.length }
  out.end()

  console.log(`\nDone! Wrote ${totalWritten.toLocaleString()} rows. Skipped ${skipped.toLocaleString()}.`)
  console.log(`  npx wrangler d1 execute alzhal-nutrition --remote --file=scripts/d1-nutrition.sql`)
}

function writeBatch(out: ReturnType<typeof createWriteStream>, batch: string[][]) {
  const colList = DB_COLUMNS.join(', ')
  const rows = batch.map(v => `('${v.join("','")}')`).join(',\n')
  out.write(`INSERT INTO food_nutrition (${colList}) VALUES\n${rows};\n\n`)
}

main().catch(err => { console.error('Failed:', err); process.exit(1) })
