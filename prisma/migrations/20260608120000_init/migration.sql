-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "plan" TEXT NOT NULL DEFAULT 'free',
    "quotaRemaining" INTEGER NOT NULL DEFAULT 10,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StoreProfile" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "industry" TEXT NOT NULL,
    "location" TEXT,
    "mainProducts" TEXT[],
    "averageOrderValue" DOUBLE PRECISION,
    "targetCustomers" TEXT[],
    "sellingPoints" TEXT[],
    "promotions" TEXT[],
    "brandTone" TEXT NOT NULL,
    "forbiddenWords" TEXT[],
    "contactPhone" TEXT,
    "logoAssetId" TEXT,
    "storefrontAssetId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StoreProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Asset" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "originalFilename" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "durationSeconds" DOUBLE PRECISION,
    "width" INTEGER,
    "height" INTEGER,
    "thumbnailStorageKey" TEXT,
    "proxyStorageKey" TEXT,
    "tags" TEXT[],
    "businessTags" TEXT[],
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Asset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssetAnalysis" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "visualTags" TEXT[],
    "businessTags" TEXT[],
    "transcript" TEXT,
    "keywords" TEXT[],
    "confidence" DOUBLE PRECISION NOT NULL,
    "recommendedUses" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssetAnalysis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AvatarProfile" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerAvatarId" TEXT,
    "providerVoiceId" TEXT,
    "consentAcceptedAt" TIMESTAMP(3) NOT NULL,
    "trainingStatus" TEXT NOT NULL,
    "fallbackMode" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AvatarProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScriptDraft" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "hook" TEXT NOT NULL,
    "scenes" JSONB NOT NULL,
    "voiceover" TEXT NOT NULL,
    "captions" TEXT[],
    "cta" TEXT NOT NULL,
    "generationMode" TEXT NOT NULL,
    "complianceWarnings" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScriptDraft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RenderProject" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "scriptDraftId" TEXT NOT NULL,
    "selectedAssetIds" TEXT[],
    "avatarProfileId" TEXT,
    "purpose" TEXT NOT NULL,
    "aspectRatio" TEXT NOT NULL,
    "subtitleStyle" TEXT NOT NULL,
    "bgmTrackId" TEXT,
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RenderProject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Job" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "projectId" TEXT,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "progress" INTEGER NOT NULL,
    "payload" JSONB NOT NULL,
    "dependsOnJobIds" TEXT[],
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VideoOutput" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "renderProjectId" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "coverStorageKey" TEXT,
    "aspectRatio" TEXT NOT NULL,
    "durationSeconds" DOUBLE PRECISION NOT NULL,
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VideoOutput_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "AssetAnalysis_assetId_key" ON "AssetAnalysis"("assetId");

-- AddForeignKey
ALTER TABLE "StoreProfile" ADD CONSTRAINT "StoreProfile_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "StoreProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetAnalysis" ADD CONSTRAINT "AssetAnalysis_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AvatarProfile" ADD CONSTRAINT "AvatarProfile_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AvatarProfile" ADD CONSTRAINT "AvatarProfile_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "StoreProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScriptDraft" ADD CONSTRAINT "ScriptDraft_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScriptDraft" ADD CONSTRAINT "ScriptDraft_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "StoreProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RenderProject" ADD CONSTRAINT "RenderProject_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RenderProject" ADD CONSTRAINT "RenderProject_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "StoreProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RenderProject" ADD CONSTRAINT "RenderProject_scriptDraftId_fkey" FOREIGN KEY ("scriptDraftId") REFERENCES "ScriptDraft"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RenderProject" ADD CONSTRAINT "RenderProject_avatarProfileId_fkey" FOREIGN KEY ("avatarProfileId") REFERENCES "AvatarProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "RenderProject"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VideoOutput" ADD CONSTRAINT "VideoOutput_renderProjectId_fkey" FOREIGN KEY ("renderProjectId") REFERENCES "RenderProject"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
