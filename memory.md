# Memory: review fixes

Inbox for the retro. The reviewer adds one line per fix. The retro turns repeated entries into checks or rules and deletes them from here.

Format: `- YYYY-MM-DD | rule or category | what was wrong`

- 2026-11-18 | logic | Pago registrado keyed its rows by documentId, which repeats when a payment's leftover is later applied to a document it already paid part of
- 2026-11-20 | logic | inspectPhoto swapped width and height for any EXIF orientation of 5 or more, including invalid values above 8 that browsers ignore
- 2026-11-20 | logic | The same-image check compared the char(64) sha256 column with text[], which casts the column and keeps document_images_sha256_idx from serving the lookup
- 2026-11-24 | security | UPLOAD_DIR accepted any absolute path, including one inside the repo that the Vite dev server shares on the local network with --host
