#!/usr/bin/env npx tsx
/**
 * Import Open Food Facts CSV into a SQL file for Cloudflare D1.
 *
 * Streams the 12GB CSV line-by-line, filters to rows with product_name +
 * ingredients_text, extracts only the 10 columns we need, and writes
 * batched INSERT statements to a .sql file.
 *
 * Usage:
 *   npx tsx scripts/import-csv.ts [path-to-csv]
 *
 * Output: scripts/d1-import.sql (ready for `wrangler d1 execute`)
 *
 * Then import into D1:
 *   npx wrangler d1 execute alzhal-food --remote --file=scripts/d1-import.sql
 */

import { createReadStream, createWriteStream, existsSync } from 'fs'
import { createInterface } from 'readline'
import path from 'path'

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const BATCH_SIZE = 20 // rows per INSERT statement (keep small to avoid SQLITE_TOOBIG)
const PRODS_DIR = path.join(process.cwd(), 'prods')
const OUTPUT_FILE = path.join(process.cwd(), 'scripts', 'd1-import.sql')

const CSV_CANDIDATES = [
  'en.openfoodfacts.org.products.csv',
  'en.openfoodfacts.org.products.tsv',
  'openfoodfacts.csv',
  'products.csv',
  'food_products.csv',
]

// Column mapping: CSV header name → our DB column name
const WANTED_COLUMNS: Record<string, string> = {
  code: 'code',
  product_name: 'product_name',
  product_name_en: 'product_name',
  brands: 'brands',
  brand: 'brands',
  categories: 'categories',
  categories_en: 'categories',
  ingredients_text: 'ingredients_text',
  ingredients_text_en: 'ingredients_text',
  nutriscore_grade: 'nutriscore_grade',
  nutrition_grade_fr: 'nutriscore_grade',
  nova_group: 'nova_group',
  nova_groups: 'nova_group',
  countries: 'countries',
  countries_en: 'countries',
  additives_tags: 'additives_tags',
  additives: 'additives_tags',
  additives_en: 'additives_tags',
  allergens: 'allergens',
  allergens_en: 'allergens',
}

const DB_COLUMNS = [
  'code', 'product_name', 'brands', 'categories', 'ingredients_text',
  'nutriscore_grade', 'nova_group', 'countries', 'additives_tags', 'allergens',
]

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findCsvFile(): string | null {
  const arg = process.argv[2]
  if (arg) {
    const resolved = path.resolve(arg)
    if (existsSync(resolved)) return resolved
    console.error(`File not found: ${resolved}`)
    process.exit(1)
  }

  if (!existsSync(PRODS_DIR)) {
    console.error(`prods/ directory not found at ${PRODS_DIR}`)
    return null
  }

  for (const name of CSV_CANDIDATES) {
    const full = path.join(PRODS_DIR, name)
    if (existsSync(full)) return full
  }
  return null
}

function detectSeparator(line: string): string {
  const tabs = (line.match(/\t/g) || []).length
  const commas = (line.match(/,/g) || []).length
  return tabs > commas ? '\t' : ','
}

function splitLine(line: string, sep: string): string[] {
  const fields: string[] = []
  let current = ''
  let inQuotes = false

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      if (inQuotes && i + 1 < line.length && line[i + 1] === '"') {
        current += '"'
        i++
      } else {
        inQuotes = !inQuotes
      }
    } else if (ch === sep && !inQuotes) {
      fields.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  fields.push(current)
  return fields
}

/** Escape a string for SQLite: double up single quotes */
function sqlEscape(s: string): string {
  if (!s) return ''
  return s.replace(/'/g, "''")
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const csvPath = findCsvFile()
  if (!csvPath) {
    console.error('No CSV file found. Pass a path as argument or place a file in prods/')
    process.exit(1)
  }

  console.log(`Reading: ${csvPath}`)
  console.log(`Output:  ${OUTPUT_FILE}`)

  const rl = createInterface({
    input: createReadStream(csvPath, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  })

  const out = createWriteStream(OUTPUT_FILE, { encoding: 'utf-8' })

  // Write schema
  out.write(`-- Auto-generated D1 import from Open Food Facts CSV
-- Generated: ${new Date().toISOString()}

CREATE TABLE IF NOT EXISTS food_products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT,
  product_name TEXT,
  brands TEXT,
  categories TEXT,
  ingredients_text TEXT,
  nutriscore_grade TEXT,
  nova_group TEXT,
  countries TEXT,
  additives_tags TEXT,
  allergens TEXT
);

CREATE INDEX IF NOT EXISTS idx_food_products_code ON food_products(code);
CREATE INDEX IF NOT EXISTS idx_food_products_name ON food_products(product_name);

`)

  let lineNum = 0
  let headers: string[] = []
  let separator = '\t'
  const columnMap: { srcIndex: number; destColumn: string }[] = []
  let batch: string[][] = [] // each entry is an array of escaped values
  let totalWritten = 0
  let skipped = 0

  for await (const line of rl) {
    lineNum++

    // Header line
    if (lineNum === 1) {
      separator = detectSeparator(line)
      headers = splitLine(line, separator).map(h => h.trim().replace(/^"|"$/g, '').toLowerCase())

      for (let i = 0; i < headers.length; i++) {
        const dest = WANTED_COLUMNS[headers[i]]
        if (dest) {
          columnMap.push({ srcIndex: i, destColumn: dest })
        }
      }

      console.log(`Columns: ${headers.length}, separator: ${separator === '\t' ? 'TAB' : 'COMMA'}`)
      console.log(`Mapped: ${columnMap.map(c => c.destColumn).join(', ')}`)

      if (columnMap.length === 0) {
        console.error('No matching columns found.')
        process.exit(1)
      }
      continue
    }

    // Parse data line
    const fields = splitLine(line, separator)
    const row: Record<string, string> = {}

    for (const { srcIndex, destColumn } of columnMap) {
      const value = (fields[srcIndex] || '').replace(/^"|"$/g, '').trim()
      if (value && (!row[destColumn] || row[destColumn] === '')) {
        row[destColumn] = value
      } else if (!row[destColumn]) {
        row[destColumn] = ''
      }
    }

    // Filter: must have product_name AND ingredients_text
    if (!row.product_name && !row.ingredients_text) {
      skipped++
      continue
    }

    // Truncate long fields to avoid SQLITE_TOOBIG
    for (const col of DB_COLUMNS) {
      if (row[col] && row[col].length > 1000) {
        row[col] = row[col].slice(0, 1000)
      }
    }

    // Build values array in DB_COLUMNS order
    const values = DB_COLUMNS.map(col => sqlEscape(row[col] || ''))
    batch.push(values)

    if (batch.length >= BATCH_SIZE) {
      writeBatch(out, batch)
      totalWritten += batch.length
      batch = []

      if (totalWritten % 50000 === 0) {
        console.log(`  ... ${totalWritten.toLocaleString()} rows (line ${lineNum.toLocaleString()}, skipped ${skipped.toLocaleString()})`)
      }
    }
  }

  // Final batch
  if (batch.length > 0) {
    writeBatch(out, batch)
    totalWritten += batch.length
  }

  // Write indexes for LIKE queries (after data is loaded for faster import)
  out.write(`\n-- Create text search index after data load for better import performance\nCREATE INDEX IF NOT EXISTS idx_food_products_ingredients ON food_products(ingredients_text);\n`)

  out.end()

  console.log(`\nDone! Wrote ${totalWritten.toLocaleString()} rows to ${OUTPUT_FILE}`)
  console.log(`Skipped ${skipped.toLocaleString()} empty rows`)
  console.log(`\nNext step:`)
  console.log(`  npx wrangler d1 execute alzhal-food --remote --file=scripts/d1-import.sql`)
}

function writeBatch(out: ReturnType<typeof createWriteStream>, batch: string[][]) {
  const colList = DB_COLUMNS.join(', ')
  const rows = batch.map(values => `('${values.join("','")}')`).join(',\n')
  out.write(`INSERT INTO food_products (${colList}) VALUES\n${rows};\n\n`)
}

main().catch(err => {
  console.error('Import failed:', err)
  process.exit(1)
})
