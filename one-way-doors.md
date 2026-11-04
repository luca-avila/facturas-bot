# One-way doors

Changes whose effects can't be undone with a revert. They always get a thorough human review.

- Migrations that drop or transform columns holding real data
- Sending WhatsApp messages (a sent message can't be unsent)
- Deleting invoices or changing their payment status
- Phone-number authorization
- Message deduplication (if it fails, invoices get loaded twice)

Everything else is a two-way door by default. When in doubt, treat it as one-way.
