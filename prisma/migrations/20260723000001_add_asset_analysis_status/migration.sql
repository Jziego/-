-- AlterTable: track whether AI classification succeeded, failed, or is pending.
ALTER TABLE "AssetAnalysis" ADD COLUMN "analysisStatus" TEXT NOT NULL DEFAULT 'pending';

-- Backfill: existing rows already carry tags, so treat them as succeeded.
UPDATE "AssetAnalysis" SET "analysisStatus" = 'succeeded';
