-- AlterTable
ALTER TABLE "ScriptDraft" ADD COLUMN     "speakerAvatarIds" TEXT[] DEFAULT ARRAY[]::TEXT[];
