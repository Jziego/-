-- AlterTable
ALTER TABLE "ScriptDraft" ADD COLUMN     "analysis" JSONB,
ADD COLUMN     "angle" TEXT;

-- AlterTable
ALTER TABLE "StoreProfile" ADD COLUMN     "nickname" TEXT,
ADD COLUMN     "ownerAge" INTEGER,
ADD COLUMN     "yearsInBusiness" INTEGER;
