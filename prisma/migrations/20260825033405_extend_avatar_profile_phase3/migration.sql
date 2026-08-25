-- AlterTable
ALTER TABLE "AvatarProfile" ADD COLUMN     "consentStatus" TEXT NOT NULL DEFAULT 'approved',
ADD COLUMN     "name" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "providerGroupId" TEXT,
ADD COLUMN     "statusReason" TEXT,
ADD COLUMN     "trainingVideoAssetId" TEXT;
