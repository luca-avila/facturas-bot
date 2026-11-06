# One-way doors

Changes whose effects can't be undone with a revert. They always get a thorough human review.

- Migrations that drop or transform columns holding real data
- Hard-deleting documents, images or payments (normal deletion is soft, so it's a two-way door)
- Bulk changes to stored amounts, due dates or applications (a change to how payment status is derived is a two-way door, because status isn't stored)
- Re-running extraction on documents that already have data (it can overwrite human corrections)
- Image compression settings (originals aren't kept, so an image compressed too hard can't be recovered)
- Document deduplication (if it fails, documents get loaded twice and debt is overstated)
- Authentication and access to documents and images (exposed financial data can't be taken back)
- Backups and restore (a failure only shows up once the data is gone)
- Sending data out of the system: messages to people, or documents to a new LLM provider (what's sent can't be unsent)

Everything else is a two-way door by default. When in doubt, treat it as one-way.
