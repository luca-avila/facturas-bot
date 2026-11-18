-- CreateEnum
CREATE TYPE "document_type" AS ENUM ('invoice', 'delivery_note', 'credit_note', 'opening_balance');

-- CreateEnum
CREATE TYPE "document_source" AS ENUM ('upload', 'manual');

-- CreateEnum
CREATE TYPE "review_status" AS ENUM ('processing', 'error', 'unreviewed', 'reviewed');

-- CreateEnum
CREATE TYPE "due_date_source" AS ENUM ('supplier_term', 'manual');

-- CreateTable
CREATE TABLE "suppliers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "legal_name" TEXT,
    "cuit" CHAR(11),
    "payment_term_days" INTEGER,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "suppliers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "documents" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "type" "document_type",
    "source" "document_source" NOT NULL,
    "review_status" "review_status" NOT NULL,
    "supplier_id" UUID,
    "letter" TEXT,
    "number" TEXT,
    "number_normalized" TEXT,
    "issue_date" DATE,
    "due_date" DATE,
    "due_date_source" "due_date_source",
    "total" DECIMAL(14,2),
    "notes" TEXT,
    "created_by" UUID NOT NULL,
    "reviewed_at" TIMESTAMPTZ(6),
    "reviewed_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID,
    "entity" TEXT NOT NULL,
    "entity_id" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "suppliers_cuit_key" ON "suppliers"("cuit");

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Added by hand: rules Prisma can't express.
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_cuit_digits" CHECK ("cuit" ~ '^[0-9]{11}$');
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_payment_term_days_non_negative" CHECK ("payment_term_days" >= 0);

ALTER TABLE "documents" ADD CONSTRAINT "documents_total_positive" CHECK ("total" > 0);

-- Invariant 1: a counted document is complete, and invoices and delivery notes have a due date.
ALTER TABLE "documents" ADD CONSTRAINT "documents_counted_complete" CHECK (
  "review_status" NOT IN ('unreviewed', 'reviewed')
  OR ("type" IS NOT NULL AND "supplier_id" IS NOT NULL AND "issue_date" IS NOT NULL AND "total" IS NOT NULL
      AND ("type" NOT IN ('invoice', 'delivery_note') OR "due_date" IS NOT NULL))
);

-- Invariant 8: reviewed_at and reviewed_by are set if and only if the document is reviewed.
ALTER TABLE "documents" ADD CONSTRAINT "documents_reviewed_by_iff_reviewed" CHECK (
  ("review_status" = 'reviewed') = ("reviewed_at" IS NOT NULL AND "reviewed_by" IS NOT NULL)
  AND ("reviewed_at" IS NULL) = ("reviewed_by" IS NULL)
);

-- No writer can store a number_normalized that disagrees with number, so invariant 7 can't be bypassed.
ALTER TABLE "documents" ADD CONSTRAINT "documents_number_normalized" CHECK (
  "number_normalized" IS NOT DISTINCT FROM NULLIF(regexp_replace("number", '[^0-9]', '', 'g'), '')
);

-- Due-date rules from system-design.md.
ALTER TABLE "documents" ADD CONSTRAINT "documents_due_date_source" CHECK (("due_date" IS NULL) = ("due_date_source" IS NULL));
ALTER TABLE "documents" ADD CONSTRAINT "documents_credit_note_no_due_date" CHECK ("type" IS DISTINCT FROM 'credit_note' OR "due_date" IS NULL);
ALTER TABLE "documents" ADD CONSTRAINT "documents_opening_balance_no_term" CHECK ("type" IS DISTINCT FROM 'opening_balance' OR "due_date_source" IS DISTINCT FROM 'supplier_term');

-- Invariant 7. NULLS NOT DISTINCT, so two documents with no letter still collide.
CREATE UNIQUE INDEX "documents_number_unique" ON "documents" ("supplier_id", "type", "letter", "number_normalized") NULLS NOT DISTINCT
  WHERE "deleted_at" IS NULL AND "review_status" IN ('unreviewed', 'reviewed') AND "number_normalized" IS NOT NULL;
