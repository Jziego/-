-- DropForeignKey
ALTER TABLE "VideoOutput" DROP CONSTRAINT "VideoOutput_renderProjectId_fkey";

-- AlterTable
ALTER TABLE "VideoOutput" ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'final_composite',
ALTER COLUMN "renderProjectId" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "VideoOutput" ADD CONSTRAINT "VideoOutput_renderProjectId_fkey" FOREIGN KEY ("renderProjectId") REFERENCES "RenderProject"("id") ON DELETE SET NULL ON UPDATE CASCADE;
