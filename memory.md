# Memory: review fixes

Inbox for the retro. The reviewer adds one line per fix. The retro turns repeated entries into checks or rules and deletes them from here.

Format: `- YYYY-MM-DD | rule or category | what was wrong`

- 2026-11-18 | logic | Pago registrado keyed its rows by documentId, which repeats when a payment's leftover is later applied to a document it already paid part of
- 2026-11-20 | logic | inspectPhoto swapped width and height for any EXIF orientation of 5 or more, including invalid values above 8 that browsers ignore
- 2026-11-20 | logic | The same-image check compared the char(64) sha256 column with text[], which casts the column and keeps document_images_sha256_idx from serving the lookup
- 2026-11-24 | security | UPLOAD_DIR accepted any absolute path, including one inside the repo that the Vite dev server shares on the local network with --host
- 2026-11-25 | docs | UploadsService's comment still called it the only writer of extraction_jobs after the worker started updating them
- 2026-11-25 | logic | Documento kept dueDateSource='supplier_term' when switching to a supplier without a payment term, showing 'Se calcula al guardar' instead of prompting for a due date
- 2026-11-25 | tests | Discarding an Error document via DELETE /api/documents/:id and checking it drops from GET /api/error-documents was not explicitly tested
