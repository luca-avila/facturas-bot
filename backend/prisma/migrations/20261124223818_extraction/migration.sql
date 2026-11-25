-- CreateEnum
CREATE TYPE "tax_kind" AS ENUM ('iva', 'iva_perception', 'iibb_perception', 'other');

-- AlterTable
ALTER TABLE "documents" ADD COLUMN     "cae" TEXT,
ADD COLUMN     "issues" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "subtotal" DECIMAL(14,2);

-- AlterTable
ALTER TABLE "extraction_jobs" ADD COLUMN     "last_error" TEXT,
ADD COLUMN     "locked_until" TIMESTAMPTZ(6),
ADD COLUMN     "model" TEXT,
ADD COLUMN     "prompt_version" TEXT,
ADD COLUMN     "raw_output" JSONB;

-- CreateTable
CREATE TABLE "document_lines" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "document_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "product_code" TEXT,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(14,3),
    "unit" TEXT,
    "package_text" TEXT,
    "unit_price" DECIMAL(16,4),
    "iva_rate" DECIMAL(5,2),
    "discount_pct" DECIMAL(5,2),
    "line_total" DECIMAL(14,2),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_taxes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "document_id" UUID NOT NULL,
    "kind" "tax_kind" NOT NULL,
    "label" TEXT NOT NULL,
    "rate" DECIMAL(5,2),
    "base" DECIMAL(14,2),
    "amount" DECIMAL(14,2) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_taxes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "document_lines_document_id_position_key" ON "document_lines"("document_id", "position");

-- CreateIndex
CREATE INDEX "document_taxes_document_id_idx" ON "document_taxes"("document_id");

-- AddForeignKey
ALTER TABLE "document_lines" ADD CONSTRAINT "document_lines_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_taxes" ADD CONSTRAINT "document_taxes_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Added by hand: rules Prisma can't express.
ALTER TABLE "documents" ADD CONSTRAINT "documents_issues_array" CHECK (jsonb_typeof("issues") = 'array');
ALTER TABLE "documents" ADD CONSTRAINT "documents_subtotal_non_negative" CHECK ("subtotal" >= 0);
ALTER TABLE "document_lines" ADD CONSTRAINT "document_lines_position_positive" CHECK ("position" >= 1);
-- A running job always holds a lease, and only a running one does.
ALTER TABLE "extraction_jobs" ADD CONSTRAINT "extraction_jobs_running_leased" CHECK (("status" = 'running') = ("locked_until" IS NOT NULL));
ALTER TABLE "extraction_jobs" ADD CONSTRAINT "extraction_jobs_succeeded_output" CHECK (
  "status" <> 'succeeded' OR ("raw_output" IS NOT NULL AND "model" IS NOT NULL AND "prompt_version" IS NOT NULL)
);

-- E3: raw_output is written once and never edited. No ERRCODE, as in documents_keep_applied.
CREATE FUNCTION "extraction_jobs_keep_raw_output"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."raw_output" IS NOT NULL AND NEW."raw_output" IS DISTINCT FROM OLD."raw_output" THEN
    RAISE EXCEPTION 'extraction_jobs_keep_raw_output: job % already has its raw_output', OLD."id";
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "extraction_jobs_keep_raw_output" BEFORE UPDATE ON "extraction_jobs"
  FOR EACH ROW EXECUTE FUNCTION "extraction_jobs_keep_raw_output"();
