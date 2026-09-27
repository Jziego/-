-- CreateIndex
CREATE INDEX "Asset_ownerId_createdAt_idx" ON "Asset"("ownerId", "createdAt");

-- CreateIndex
CREATE INDEX "AvatarProfile_ownerId_createdAt_idx" ON "AvatarProfile"("ownerId", "createdAt");

-- CreateIndex
CREATE INDEX "Job_ownerId_createdAt_idx" ON "Job"("ownerId", "createdAt");

-- CreateIndex
CREATE INDEX "RenderProject_ownerId_createdAt_idx" ON "RenderProject"("ownerId", "createdAt");

-- CreateIndex
CREATE INDEX "ScriptDraft_ownerId_createdAt_idx" ON "ScriptDraft"("ownerId", "createdAt");

-- CreateIndex
CREATE INDEX "StoreProfile_ownerId_idx" ON "StoreProfile"("ownerId");

-- CreateIndex
CREATE INDEX "VideoOutput_ownerId_createdAt_idx" ON "VideoOutput"("ownerId", "createdAt");
