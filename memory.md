# Memory: review fixes

Inbox for the retro. The reviewer adds one line per fix. The retro turns repeated entries into checks or rules and deletes them from here.

Format: `- YYYY-MM-DD | rule or category | what was wrong`

- 2026-11-20 | logic | inspectPhoto swapped width and height for any EXIF orientation of 5 or more, including invalid values above 8 that browsers ignore
- 2026-11-20 | logic | The same-image check compared the char(64) sha256 column with text[], which casts the column and keeps document_images_sha256_idx from serving the lookup
- 2026-11-24 | security | UPLOAD_DIR accepted any absolute path, including one inside the repo that the Vite dev server shares on the local network with --host
- 2026-11-25 | tests | Discarding an Error document via DELETE /api/documents/:id and checking it drops from GET /api/error-documents was not explicitly tested
- 2026-11-26 | ui | Clicking Descartar in the duplicate_suspected card on Documento toggled the form's confirmation panel, which was unmounted on the Foto tab and off-screen on Datos; navigating via Ver el existente also kept stale Documento state across id changes
- 2026-11-26 | security | Nginx matched /api/auth/login with exact =, letting trailing-slash or mixed-case variants (/api/auth/login/, /api/auth/LOGIN) bypass limit_req while Express still routed them to login
- 2026-11-26 | security | deploy/smoke.sh echoed the password when read from an interactive terminal and passed the login JSON body in curl argv instead of stdin
- 2026-11-26 | logic | deploy/init-cert.sh did not pass --force-renewal when replacing a prior --staging certificate, so switching from staging to production silently kept the untrusted staging cert
