-- CreateEnum
CREATE TYPE "payment_method" AS ENUM ('transfer', 'echeq', 'cash', 'mercado_pago', 'other');

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "supplier_id" UUID NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "paid_on" DATE NOT NULL,
    "value_date" DATE,
    "method" "payment_method" NOT NULL,
    "reference" TEXT,
    "notes" TEXT,
    "created_by" UUID NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "applications" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "document_id" UUID NOT NULL,
    "payment_id" UUID,
    "credit_note_id" UUID,
    "amount" DECIMAL(14,2) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "applications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "payments_supplier_id_idx" ON "payments"("supplier_id");

-- CreateIndex
CREATE INDEX "applications_document_id_idx" ON "applications"("document_id");

-- CreateIndex
CREATE INDEX "applications_payment_id_idx" ON "applications"("payment_id");

-- CreateIndex
CREATE INDEX "applications_credit_note_id_idx" ON "applications"("credit_note_id");

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "applications" ADD CONSTRAINT "applications_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "applications" ADD CONSTRAINT "applications_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "applications" ADD CONSTRAINT "applications_credit_note_id_fkey" FOREIGN KEY ("credit_note_id") REFERENCES "documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Added by hand: rules Prisma can't express.
ALTER TABLE "payments" ADD CONSTRAINT "payments_amount_positive" CHECK ("amount" > 0);
ALTER TABLE "payments" ADD CONSTRAINT "payments_value_date_echeq_only" CHECK ("value_date" IS NULL OR "method" = 'echeq');

ALTER TABLE "applications" ADD CONSTRAINT "applications_amount_positive" CHECK ("amount" > 0);
-- Exactly one source: a payment or a credit note.
ALTER TABLE "applications" ADD CONSTRAINT "applications_one_source" CHECK (("payment_id" IS NULL) <> ("credit_note_id" IS NULL));

-- Invariant 6, on both sides of an application: while a document has applications,
-- received or given, it stays counted, keeps its supplier and type, isn't deleted,
-- and its total covers what it received and what it gave. Hard deletes are already
-- refused by the RESTRICT foreign keys. No ERRCODE: the default P0001 reaches Prisma
-- as P2039 with this name in the message.
CREATE FUNCTION "documents_keep_applied"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  received numeric;
  given numeric;
BEGIN
  SELECT COALESCE(SUM("amount"), 0) INTO received FROM "applications" WHERE "document_id" = OLD."id";
  SELECT COALESCE(SUM("amount"), 0) INTO given FROM "applications" WHERE "credit_note_id" = OLD."id";
  IF received = 0 AND given = 0 THEN
    RETURN NEW;
  END IF;
  IF NEW."deleted_at" IS NOT NULL
     OR NEW."supplier_id" IS DISTINCT FROM OLD."supplier_id"
     OR NEW."type" IS DISTINCT FROM OLD."type"
     OR NEW."review_status" NOT IN ('unreviewed', 'reviewed')
     OR NEW."total" IS NULL OR NEW."total" < received OR NEW."total" < given THEN
    RAISE EXCEPTION 'documents_keep_applied: document % has applications', OLD."id";
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "documents_keep_applied" BEFORE UPDATE ON "documents"
  FOR EACH ROW EXECUTE FUNCTION "documents_keep_applied"();

-- The same for the payment side.
CREATE FUNCTION "payments_keep_applied"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  given numeric;
BEGIN
  SELECT COALESCE(SUM("amount"), 0) INTO given FROM "applications" WHERE "payment_id" = OLD."id";
  IF given > 0 AND (NEW."deleted_at" IS NOT NULL
                    OR NEW."supplier_id" IS DISTINCT FROM OLD."supplier_id"
                    OR NEW."amount" < given) THEN
    RAISE EXCEPTION 'payments_keep_applied: payment % has applications', OLD."id";
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "payments_keep_applied" BEFORE UPDATE ON "payments"
  FOR EACH ROW EXECUTE FUNCTION "payments_keep_applied"();
