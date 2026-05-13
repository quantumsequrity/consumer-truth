-- Migration: add ingredient_name to feedback table.
--
-- Background: app/api/feedback writes ingredient_name for per-ingredient
-- thumbs-up/down feedback (IngredientFeedback in AnalysisResult.tsx). Pre-
-- existing deployments created the table without this column and the INSERT
-- 500-errored. This one-shot migration adds the column.
--
-- Run once against APP_DB on any deployment created before this column existed:
--   npx wrangler d1 execute alzhal-app --remote --file=scripts/d1-migrate-feedback-ingredient.sql
--
-- Fresh deployments do NOT need this — d1-app-schema.sql already creates the
-- column. Running this against a fresh DB will fail with "duplicate column
-- name" and that failure is safe to ignore.

ALTER TABLE feedback ADD COLUMN ingredient_name TEXT;
