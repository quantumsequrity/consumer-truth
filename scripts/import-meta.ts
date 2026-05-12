#!/usr/bin/env npx tsx
/**
 * Import product metadata from Open Food Facts CSV into D1 SQL file.
 * Links to FOOD_DB via `code` (barcode).
 *
 * Usage:  npx tsx scripts/import-meta.ts
 * Import: npx wrangler d1 execute alzhal-meta --remote --file=scripts/d1-meta.sql
 */

import { createReadStream, createWriteStream, existsSync } from 'fs'
import { createInterface } from 'readline'
import path from 'path'

const BATCH_SIZE = 20
const PRODS_DIR = path.join(process.cwd(), 'prods')
const OUTPUT_FILE = path.join(process.cwd(), 'scripts', 'd1-meta.sql')

const CSV_CANDIDATES = [
  'en.openfoodfacts.org.products.csv',
  'en.openfoodfacts.org.products.tsv',
]

const COLUMN_MAP: Record<string, string> = {
  'code': 'code',
  'generic_name': 'generic_name',
  'quantity': 'quantity',
  'packaging': 'packaging',
  'packaging_text': 'packaging_text',
  'labels': 'labels',
  'labels_en': 'labels',
  'origins': 'origins',
  'origins_en': 'origins',
  'manufacturing_places': 'manufacturing_places',
  'stores': 'stores',
  'traces': 'traces',
  'traces_en': 'traces',
  'brand_owner': 'brand_owner',
  'food_groups': 'food_groups',
  'food_groups_en': 'food_groups',
  'environmental_score_score': 'ecoscore_score',
  'environmental_score_grade': 'ecoscore_grade',
  'image_url': 'image_url',
  'image_small_url': 'image_small_url',
  'image_ingredients_url': 'image_ingredients_url',
  'image_nutrition_url': 'image_nutrition_url',
  'unique_scans_n': 'popularity_scans',
  'completeness': 'completeness',
  'pnns_groups_1': 'pnns_group_1',
  'pnns_groups_2': 'pnns_group_2',
}

const DB_COLUMNS = [
  'code', 'generic_name', 'quantity', 'packaging', 'packaging_text',
  'labels', 'origins', 'manufacturing_places', 'stores', 'traces',
  'brand_owner', 'food_groups', 'ecoscore_score', 'ecoscore_grade',
  'image_url', 'image_small_url', 'image_ingredients_url', 'image_nutrition_url',
  'popularity_scans', 'completeness', 'pnns_group_1', 'pnns_group_2',
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

  out.write(`-- Product metadata from Open Food Facts
-- Generated: ${new Date().toISOString()}

CREATE TABLE IF NOT EXISTS food_meta (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT,
  generic_name TEXT,
  quantity TEXT,
  packaging TEXT,
  packaging_text TEXT,
  labels TEXT,
  origins TEXT,
  manufacturing_places TEXT,
  stores TEXT,
  traces TEXT,
  brand_owner TEXT,
  food_groups TEXT,
  ecoscore_score TEXT,
  ecoscore_grade TEXT,
  image_url TEXT,
  image_small_url TEXT,
  image_ingredients_url TEXT,
  image_nutrition_url TEXT,
  popularity_scans TEXT,
  completeness TEXT,
  pnns_group_1 TEXT,
  pnns_group_2 TEXT
);

CREATE INDEX IF NOT EXISTS idx_meta_code ON food_meta(code);

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
      console.log(`Mapped ${columnMapping.length} meta columns`)
      continue
    }

    const fields = splitLine(line, separator)
    const row: Record<string, string> = {}
    let hasData = false

    for (const { srcIndex, destColumn } of columnMapping) {
      const value = (fields[srcIndex] || '').replace(/^"|"$/g, '').trim().slice(0, 500)
      if (value && (!row[destColumn] || row[destColumn] === '')) {
        row[destColumn] = value
        if (destColumn !== 'code') hasData = true
      } else if (!row[destColumn]) {
        row[destColumn] = ''
      }
    }

    if (!row.code || !hasData) { skipped++; continue }

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
  console.log(`  npx wrangler d1 execute alzhal-meta --remote --file=scripts/d1-meta.sql`)
}

function writeBatch(out: ReturnType<typeof createWriteStream>, batch: string[][]) {
  const colList = DB_COLUMNS.join(', ')
  const rows = batch.map(v => `('${v.join("','")}')`).join(',\n')
  out.write(`INSERT INTO food_meta (${colList}) VALUES\n${rows};\n\n`)
}

main().catch(err => { console.error('Failed:', err); process.exit(1) })
