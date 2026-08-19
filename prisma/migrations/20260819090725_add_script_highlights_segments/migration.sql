-- AlterTable
ALTER TABLE "ScriptDraft" ADD COLUMN     "highlights" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "segments" JSONB NOT NULL DEFAULT '[]';
