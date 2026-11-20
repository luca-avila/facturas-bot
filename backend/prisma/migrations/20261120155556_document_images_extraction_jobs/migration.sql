-- CreateEnum
CREATE TYPE "extraction_job_status" AS ENUM ('queued', 'running', 'succeeded', 'failed');

-- CreateTable
CREATE TABLE "document_images" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "document_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "storage_key" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_images_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "extraction_jobs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "document_id" UUID NOT NULL,
    "status" "extraction_job_status" NOT NULL,
    "attempts" INTEGER NOT NULL,
    "run_after" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "extraction_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "document_images_storage_key_key" ON "document_images"("storage_key");

-- CreateIndex
CREATE INDEX "document_images_sha256_idx" ON "document_images"("sha256");

-- CreateIndex
CREATE UNIQUE INDEX "document_images_document_id_position_key" ON "document_images"("document_id", "position");

-- CreateIndex
CREATE INDEX "extraction_jobs_document_id_idx" ON "extraction_jobs"("document_id");

-- AddForeignKey
ALTER TABLE "document_images" ADD CONSTRAINT "document_images_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "extraction_jobs" ADD CONSTRAINT "extraction_jobs_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Added by hand: rules Prisma can't express.
ALTER TABLE "document_images" ADD CONSTRAINT "document_images_position_positive" CHECK ("position" >= 1);
ALTER TABLE "document_images" ADD CONSTRAINT "document_images_dimensions_positive" CHECK ("width" > 0 AND "height" > 0);
ALTER TABLE "document_images" ADD CONSTRAINT "document_images_size_positive" CHECK ("size_bytes" > 0);
ALTER TABLE "document_images" ADD CONSTRAINT "document_images_sha256_hex" CHECK ("sha256" ~ '^[0-9a-f]{64}$');
ALTER TABLE "document_images" ADD CONSTRAINT "document_images_mime_type" CHECK ("mime_type" IN ('image/jpeg', 'image/png', 'image/webp'));
-- The image endpoint joins UPLOAD_DIR with this key, so it can never hold a path.
ALTER TABLE "document_images" ADD CONSTRAINT "document_images_storage_key_format" CHECK ("storage_key" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp)$');
ALTER TABLE "extraction_jobs" ADD CONSTRAINT "extraction_jobs_attempts_non_negative" CHECK ("attempts" >= 0);
