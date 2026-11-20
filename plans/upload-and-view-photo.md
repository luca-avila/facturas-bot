# Plan: Upload and view the photo (slice 4)

Spec: [`mvp-slices.md`, section 4](mvp-slices.md#4-upload-and-view-the-photo). Branch: `feat/upload-and-view-photo`.

## Goal

A signed-in person photographs a document of one or more pages on the phone, or picks the photos from the gallery, and uploads them. The app opens *Documento* in *Procesando*, with the pages in order and *Subido por* with their name, and the upload shows in *Subidas* under *Mías* and *Todas*. Uploading the same photos again opens the same document instead of creating a second one, and images are only ever served to someone with a session.

## Out of scope

- The worker, extraction and anything that moves a document out of `processing` (slice 5). *Documento* doesn't refresh itself while it's *Procesando*: slice 5 adds that, along with the *Datos* and *Foto* tabs (5b, 5c).
- Removing files whose transaction failed, as the spec says. A failed upload can leave files in `UPLOAD_DIR` that no row points to.
- *Descartar* on *Documento*, editing, *A resolver* and the *Error* warning in *Resumen* (slices 5 and 6). `DELETE /api/documents/:id` already works on an upload, and tests use it.
- Any server-side change to image bytes (E5): no thumbnails, no resizing, no EXIF stripping.
- A camera view inside the page (4a), drag-and-drop ordering (4b), thumbnails in *Subidas* (4g), the desktop layout (5h) and the bottom navigation bar (0b). See *Decisions*.
- Frontend DOM or component tests, as in earlier slices.
- nginx's body size limit, the Docker volume for `UPLOAD_DIR`, and backing it up (slice 8).
- Paging *Subidas*, and rate limiting uploads.

## Decisions

These are defaults chosen within the spec. Step 1 writes the first two into `system-design.md`, since they differ from the wireframes or from the design's example library.

1. **The browser compresses with its own canvas code, not `browser-image-compression`.** `system-design.md` names that library as an example ("such as"). Its 2.0.2 source does two things this design forbids:
   - By default it compresses in a web worker that loads the library from `cdn.jsdelivr.net`, so third-party code would run next to every photo.
   - When the re-encoded file is larger than the original, which is likely for a photo WhatsApp already compressed, it lowers the quality by 5% a pass, up to ten times, down to about 0.51 from 0.85. No option turns that off (`maxIteration: 0` means 10).
   `frontend/src/photos.ts` instead decodes the photo with an `<img>`, which applies EXIF orientation in every target browser, draws it once on a canvas with the long side at most 2200 px, and encodes one JPEG at 0.85. That's one lossy pass, about 40 lines, and no new dependency.
2. **Wireframe changes.**
   - *Subir* (4a, 4b): the phone's own camera opens from a button, through `<input type="file" accept="image/*" capture="environment">`. A camera view inside the page would need `getUserMedia`, which needs HTTPS, and the phone reaches the dev server over plain HTTP. Pages move with ↑ and ↓ buttons instead of dragging.
   - *Ya estaba subido* (4f): it's a notice at the top of *Documento*, not a screen of its own. That's what acceptance 2 asks for ("it opens the same document").
   - *Subidas* (4g): rows have no thumbnail. The server never makes smaller copies (E5), and loading every full photo would spend the phone's data.
3. **At most 10 pages per upload, and at most 7 MiB (7,340,032 bytes) per photo**, on both ends. That's the spec's "under 7 MB" for originals, and 7 MiB in base64 still fits the API's 10 MB per image. Ten photos of 7 MiB is the most one request holds in memory.
4. **The last 7 days are calendar days in Buenos Aires**: today and the six days before. A document uploaded on 2026-11-12 is listed through 2026-11-18 and gone on 2026-11-19 at 00:00 in Buenos Aires, unless it's still *Procesando*. That matches *Subidas*' grouping by day.
5. ***Mías* is the default filter**, as the wireframe shows (4g).
6. **`width` and `height` are the image as displayed.** A JPEG with EXIF orientation 5 to 8 has its header's width and height swapped. Canvas output carries no EXIF, so this only affects originals uploaded after compression failed.
7. **Files are written inside the upload transaction, after the lock and the same-image check.** The order is: lock, check, write the files, insert the rows, commit. A file always exists before its row commits, as the design wants, and an upload that matches an existing document writes no file. The lock is held while the files are written, which takes milliseconds at this volume.
8. **The upload route requires `X-Requested-With: XMLHttpRequest`.** `configure-app.ts` relies on JSON-only parsing, so a cross-site form reaches no parser. Multipart is a content type a cross-site form can send. `SameSite=Strict` already keeps the session cookie off such a request, and the global `SessionGuard` runs before the multipart parser. The header keeps that guarantee even where `SameSite` doesn't apply, such as from a sibling subdomain: a form can't set it, and a cross-origin `fetch` that sets it needs a CORS preflight, which fails.
9. **Images are served with `Cache-Control: private, no-store`**, plus `X-Content-Type-Options: nosniff` and `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; sandbox` (what GitHub serves raw files with). No copy stays in a shared phone's browser cache after sign-out, and the bytes can never run as a page. The cost is downloading a page again when it's reopened.
10. **An upload writes one `audit_log` entry**, `documents` `create` by the person (D2). Images and jobs aren't financial rows, so they get none.
11. **The type comes from the bytes, never from the client.** The server ignores the part's `Content-Type` and file name. `image-size` reads the type and dimensions from the headers, and only `jpg`, `png` and `webp` are accepted. It never decodes or changes the image.

**Verified facts.** Checked on 2026-11-19 against Postgres 17 (the compose image), Prisma 7.10.1 with `@prisma/adapter-pg`, Node 24, `@nestjs/platform-express` 12 with its multer 2.5.0, and `image-size` 2.0.2, in scratch databases and directories that have since been dropped. These aren't open to the implementer.
- The schema under *Interface* validates, and `prisma migrate diff` generates exactly the tables, enum, indexes and foreign keys listed under *Migration*, all `ON DELETE RESTRICT`. After the hand-written block, a diff from the database to the schema is an empty migration.
- Each hand-written `CHECK` refuses its case by name: position 0, a key of `../etc/passwd`, `image/heic`, an uppercase hash, a repeated position (`document_images_document_id_position_key`). A valid row at position 3 is accepted.
- ``await tx.$executeRaw`SELECT pg_advisory_xact_lock(${1})` `` works inside an interactive transaction and returns 1.
- Two transactions run at once, each doing lock, then `SELECT … WHERE i.sha256 = ANY(${hashes}::text[])`, then `tx.document.create` with nested `images` and `extractionJobs`: the second waits, then sees the first's rows, and one document exists. 3 runs out of 3. **Without the lock, two documents exist in 3 runs out of 3**, with no delay between check and insert, so the concurrency test can fail.
- `= ANY(${hashes}::text[])` binds a JS `string[]` against the `char(64)` column.
- `AT TIME ZONE ${BUSINESS_TIME_ZONE}::text` works with a bind parameter. `to_char(…, 'YYYY-MM-DD')` and `to_char(…, 'HH24:MI')` turn `2026-11-19T02:59:59Z` into `2026-11-18` and `23:59`. `date - date` comes back as a JS `number`.
- multer 2.5.0, with `limits: { fileSize: N }`, accepts a file of exactly N bytes and refuses N + 1 with `LIMIT_FILE_SIZE`, which Nest turns into 413. More files than `files` gives `LIMIT_FILE_COUNT`, a text field under `fields: 0` gives `LIMIT_FIELD_COUNT`, and a file under another field name gives `LIMIT_UNEXPECTED_FILE`, all 400. A JSON body leaves `req.files` undefined. Files arrive in the order sent, in memory (`buffer`, `size`) by default, and a zero-byte file is accepted with `size` 0.
- `imageSize` from `image-size` 2.0.2 reads the hand-built headers under *Test photos*: `{ width: 1650, height: 2200, type: 'jpg' }` for a JPEG, likewise `png` and `webp`, and `orientation: 6` from a JPEG with a big-endian EXIF block. A 7 MiB JPEG padded with zeros after its end marker still reads. It throws on a HEIC `ftyp` box, on text, and on a JPEG without a frame header, and it reports a GIF as `gif`. Version 2.1.0 is 13 days old: pin 2.0.2.
- Supertest buffers `image/*` responses, so `res.body` is a `Buffer`.
- `browser-image-compression` 2.0.2 behaves as described in decision 1 (read from its published source).

## Interface

### Schema (`backend/prisma/schema.prisma`)

Add to `Document`:

```prisma
  images               DocumentImage[]
  extractionJobs       ExtractionJob[]
```

New models:

```prisma
/**
 * Rows never change: no updated_at. The file at storage_key is written once
 * and never changed (E5).
 */
model DocumentImage {
  id         String   @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  documentId String   @map("document_id") @db.Uuid
  document   Document @relation(fields: [documentId], references: [id], onDelete: Restrict)
  position   Int
  storageKey String   @unique @map("storage_key")
  mimeType   String   @map("mime_type")
  width      Int
  height     Int
  sizeBytes  Int      @map("size_bytes")
  sha256     String   @db.Char(64)
  createdAt  DateTime @default(now()) @map("created_at") @db.Timestamptz(6)

  @@unique([documentId, position])
  @@index([sha256])
  @@map("document_images")
}

enum ExtractionJobStatus {
  queued
  running
  succeeded
  failed

  @@map("extraction_job_status")
}

model ExtractionJob {
  id         String              @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  documentId String              @map("document_id") @db.Uuid
  document   Document            @relation(fields: [documentId], references: [id], onDelete: Restrict)
  status     ExtractionJobStatus
  attempts   Int
  runAfter   DateTime            @map("run_after") @db.Timestamptz(6)
  createdAt  DateTime            @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt  DateTime            @default(now()) @updatedAt @map("updated_at") @db.Timestamptz(6)

  @@index([documentId])
  @@map("extraction_jobs")
}
```

`sha256` gets a plain index, not a unique one: a deleted document's hash can come back (question 6).

### Migration

Run `npx prisma migrate dev --name document_images_extraction_jobs --create-only`. Prisma generates: the `extraction_job_status` enum; both tables; `document_images_storage_key_key` (unique), `document_images_sha256_idx`, `document_images_document_id_position_key` (unique) and `extraction_jobs_document_id_idx`; and both foreign keys with `ON DELETE RESTRICT ON UPDATE CASCADE`. Append:

```sql
-- Added by hand: rules Prisma can't express.
ALTER TABLE "document_images" ADD CONSTRAINT "document_images_position_positive" CHECK ("position" >= 1);
ALTER TABLE "document_images" ADD CONSTRAINT "document_images_dimensions_positive" CHECK ("width" > 0 AND "height" > 0);
ALTER TABLE "document_images" ADD CONSTRAINT "document_images_size_positive" CHECK ("size_bytes" > 0);
ALTER TABLE "document_images" ADD CONSTRAINT "document_images_sha256_hex" CHECK ("sha256" ~ '^[0-9a-f]{64}$');
ALTER TABLE "document_images" ADD CONSTRAINT "document_images_mime_type" CHECK ("mime_type" IN ('image/jpeg', 'image/png', 'image/webp'));
-- The image endpoint joins UPLOAD_DIR with this key, so it can never hold a path.
ALTER TABLE "document_images" ADD CONSTRAINT "document_images_storage_key_format" CHECK ("storage_key" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp)$');
ALTER TABLE "extraction_jobs" ADD CONSTRAINT "extraction_jobs_attempts_non_negative" CHECK ("attempts" >= 0);
```

Then `npx prisma migrate dev` and `npx prisma generate`.

### HTTP (prefix `/api`, every route behind the global `SessionGuard`)

**`POST /api/uploads`**: creates a document from photos.
- Request: `multipart/form-data` with 1 to 10 file parts named `photos`, in page order, and no other parts. Header `X-Requested-With: XMLHttpRequest`. The parts' file names and `Content-Type`s are ignored.
- `201 { "id": "<uuid>", "alreadyUploaded": false }`: created one document (`source` `upload`, `review_status` `processing`, `created_by` the session user, everything else null), one `document_images` row per photo with `position` 1 to n in the order sent, and one `extraction_jobs` row (`queued`, `attempts` 0, `run_after` `now()`).
- `200 { "id": "<uuid>", "alreadyUploaded": true }`: every photo is already in one document that isn't deleted, in any status, whether all of its pages or some, in any order. Nothing is written.
- `400 { "errors": [...] }`, every page error in one pass, `field` being `photos.<i>` with `i` the 0-based index in the order sent:
  - `photo_type_invalid`: not a JPEG, PNG or WebP by its bytes (HEIC, GIF, PDF, text, empty).
  - `photo_repeated`: the same bytes as an earlier photo in this upload. The first one isn't marked.
- 400 with no field errors (malformed): no header, no files, a JSON body, more than 10 files, a text field, or a file under another field name. The first three answer `{ "errors": [] }`. The rest come from multer, with Nest's default body, which has no `errors` either. Tests check the status and that nothing was written.
- `409 { "errors": [{ "field": "photos.<i>", "code": "photo_in_other_document", "documentId": "<uuid>" }, ...] }`: some photo is already in a document that isn't deleted, and the upload isn't wholly in one document. That covers some photos matching and others not, and photos from two documents. Only the matching pages are listed, each with its document. If a hash is somehow in two documents, it names the oldest. Nothing is written.
- `413`: a photo over 7 MiB. Nothing is written.

Only images of documents that aren't deleted count. A photo whose only document is deleted is new.

**`GET /api/documents/:id`**: one document for *Documento*.

```ts
interface DocumentDetail {
  id: string;
  source: 'upload' | 'manual';
  reviewStatus: 'processing' | 'error' | 'unreviewed' | 'reviewed';
  type: DocumentType | null;
  letter: string | null;
  number: string | null;
  createdByName: string;
  /** YYYY-MM-DD and HH:MM of created_at in Buenos Aires. */
  createdOn: string;
  createdTime: string;
  /** By position. Empty for a manual document. */
  images: { id: string; position: number }[];
}
```

`404` for a non-UUID, unknown or deleted id.

**`GET /api/uploads?scope=mine|all`**: *Subidas*.

```ts
interface UploadList {
  /** Newest first, by created_at then id. */
  uploads: UploadRow[];
}
interface UploadRow {
  id: string;
  reviewStatus: ReviewStatus;
  pageCount: number;
  /** YYYY-MM-DD and HH:MM of created_at in Buenos Aires. */
  uploadedOn: string;
  uploadedTime: string;
  /** Today minus uploadedOn, in Buenos Aires: 0 today, 1 yesterday. */
  daysAgo: number;
  createdByName: string;
  type: DocumentType | null;
  letter: string | null;
  number: string | null;
  supplierName: string | null;
  /** Canonical, such as "53600.00". */
  total: string | null;
}
```

- Rows: `source = 'upload'`, not deleted (D3), and either `review_status = 'processing'` or uploaded on `addDays(today(), -6)` or later, in Buenos Aires. `mine` adds `created_by` = the session user.
- `scope` missing, repeated or anything other than `mine` or `all` gives 400 with no errors.

**`GET /api/images/:id`**: the bytes of one image, exactly as stored.
- `200` with `Content-Type` the stored `mime_type`, `Content-Length`, `Cache-Control: private, no-store`, `X-Content-Type-Options: nosniff` and `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; sandbox`.
- `404` for a non-UUID or unknown id, or an image whose document is deleted (D3).
- A row whose file is missing throws, so it's a 500, never a 404.

### Backend modules

**`backend/src/common/`**
- `clock.ts`: export `BUSINESS_TIME_ZONE`. SQL that turns a timestamp into a Buenos Aires date or time passes it as `${BUSINESS_TIME_ZONE}::text`, never as a literal.
- `advisory-locks.ts` (new): `export const ADVISORY_LOCKS = { uploads: 1 } as const;`. Every `pg_advisory_xact_lock` key in the app comes from here, so two locks can never share a key by accident.
- `field-errors.ts`: add `photo_type_invalid`, `photo_repeated` and `photo_in_other_document` to `FieldErrorCode`.

**`backend/src/uploads/`** (new `UploadsModule`, imported by `AppModule`; it imports `AuditModule`)
- `photo.ts`:
  - `MAX_PHOTO_BYTES = 7 * 1024 * 1024`, `MAX_PAGES = 10`.
  - `inspectPhoto(bytes: Buffer): Photo | null`. `Photo` is `{ mimeType: 'image/jpeg' | 'image/png' | 'image/webp'; extension: 'jpg' | 'png' | 'webp'; width; height; sizeBytes; sha256 }`. It calls `imageSize(bytes)` from `image-size` and returns null when that throws, when `type` isn't `jpg`, `png` or `webp`, or when the width or height isn't a positive integer. It swaps width and height when `orientation` is 5 to 8. `sha256` is the lowercase hex digest of `bytes`, and `sizeBytes` is `bytes.length`. It never changes the bytes.
- `uploads.config.ts`: `UploadsConfig`, read when the app is created, like `AuthConfig`. `UPLOAD_DIR` must be an absolute path, or it throws `UPLOAD_DIR must be set to an absolute path outside the repo, such as /home/you/facturas-uploads. Put it in .env.`, so the backend doesn't start. It runs `mkdirSync(dir, { recursive: true, mode: 0o700 })`.
- `image-store.ts`: `ImageStore`, the only code that touches `UPLOAD_DIR`.
  - `newKey(extension)` returns `` `${randomUUID()}.${extension}` ``.
  - `write(key, bytes)` opens `path.join(dir, key)` with flag `wx` and mode `0o600`, writes the bytes as they are, calls `sync()`, then `close()`.
  - `read(key)` returns the file's bytes.
- `upload-request.guard.ts`: `UploadRequestGuard`, used with `@UseGuards` on `POST /uploads` only. It throws `invalidRequest()` unless the `X-Requested-With` header is exactly `XMLHttpRequest`. Route guards run after the global `SessionGuard` and before interceptors, so the order is: 401, then this 400, then multer.
- `uploads.controller.ts`, `@Controller('uploads')`:
  - `POST`: `@UseGuards(UploadRequestGuard)`, then `@UseInterceptors(FilesInterceptor('photos', MAX_PAGES, { limits: { fileSize: MAX_PHOTO_BYTES, files: MAX_PAGES, fields: 0, parts: MAX_PAGES } }))`. With no `storage` and no `dest`, multer keeps files in memory. `@UploadedFiles() files: UploadedPhoto[] | undefined`, where `UploadedPhoto` is a local `{ buffer: Buffer; size: number }`, so no `@types/multer`. It answers 200 when `alreadyUploaded`, through `@Res({ passthrough: true })`.
  - `GET`: parses `scope` like `parseListQuery` in `payments.controller.ts`.
- `images.controller.ts`, `@Controller('images')`: `GET :id` with the three `@Header`s, returning `new StreamableFile(bytes, { type: mimeType, length: bytes.length })`.
- `uploads.service.ts`, `UploadsService`, the only writer of `document_images` and `extraction_jobs`:
  - `upload(files, user)`:
    1. No files gives `invalidRequest()`.
    2. `inspectPhoto` each one. Null gives `photo_type_invalid` on that page. A hash equal to an earlier valid page's gives `photo_repeated`. Any error gives `invalidRequest(errors)`.
    3. One `this.prisma.$transaction` (no `isolationLevel`):
       - `` tx.$executeRaw`SELECT pg_advisory_xact_lock(${ADVISORY_LOCKS.uploads})` ``.
       - `SELECT i.sha256, i.document_id FROM document_images i JOIN documents d ON d.id = i.document_id WHERE d.deleted_at IS NULL AND i.sha256 = ANY(${hashes}::text[]) ORDER BY d.created_at, d.id`. Keep the first document per hash.
       - If every hash matched and all in one document, return `{ id, alreadyUploaded: true }`. If any matched otherwise, throw `conflict(...)` with one error per matching page. The extra `documentId` property passes through `conflict`'s `FieldError[]` type.
       - `store.write` each photo under `newKey(extension)`.
       - `tx.document.create` with nested `images.create` and `extractionJobs.create` (`runAfter: now()`), selecting `id`. Use the model API: Prisma fills `created_at` from the JS clock, which tests fake.
       - `audit.snapshot(tx, 'documents', id)`, then `audit.record` with `create`, by the user.
  - `list(scope, user)`: one raw query (see *HTTP*), with `page_count` as a subquery, `total::text`, and `${today()}::date - (d.created_at AT TIME ZONE ${BUSINESS_TIME_ZONE}::text)::date AS days_ago`. The cutoff is a parameter computed from `today()`, never SQL `now()`, so faked time works.
  - `readImage(id)`: non-UUID is a 404. Join `documents` with `deleted_at IS NULL`. No row is a 404. Then `store.read(storage_key)`.

**`backend/src/documents/`**
- `DocumentsController`: add `@Get(':id')`.
- `DocumentsService.detail(id)`: non-UUID is a 404. Two reads, the document (with `users.name` and `to_char` in Buenos Aires) and its images by position, in one read-only `RepeatableRead` transaction, as `supplierAccount` does. Update the class comment: it writes documents and reads one for *Documento*.

**`backend/src/configure-app.ts`**: extend the comment. `POST /api/uploads` is the one route that parses multipart. `SessionGuard` and `UploadRequestGuard` run before its parser, and a cross-site form can't send `X-Requested-With`.

**Config**
- `backend/package.json`: add `"image-size": "2.0.2"` (exact) to `dependencies`.
- `backend/vitest.config.ts`: add `UPLOAD_DIR: path.join(os.tmpdir(), \`facturas-test-uploads-${randomBytes(6).toString('hex')}\`)` to `test.env`, a fresh directory per run, like `JWT_SECRET`.
- `.env.example`: add `UPLOAD_DIR=` with the comment `# Absolute path where uploaded photos are stored, outside the repo, such as /home/you/facturas-uploads. The backend creates it.`
- `README.md`: the `UPLOAD_DIR` row says the same.
- Don't edit `.env`. The hand-off tells the user to add the line.

### Test photos (`backend/test/photos.ts`)

Image files can't be committed (the CUIT check fails on binaries), so tests build bytes at run time. Each call puts 16 random bytes inside, so every call has new bytes and a new hash. `sha256(bytes)` computes a digest, and no test writes one out.
- `jpeg({ width = 1650, height = 2200, size?, orientation? })`: `FF D8`, a COM segment (`FF FE`, length 18, the 16 random bytes), and if `orientation` is set, an APP1 segment (`FF E1`) holding `Exif\0\0` and a big-endian TIFF block (`MM`, 42, IFD at offset 8, one entry: tag `0x0112`, type 3, count 1, the value). Then an SOF0 segment (`FF C0`, length 17, precision 8, height, width, 3 components: `1,0x22,0`, `2,0x11,1`, `3,0x11,1`), then `FF D9`, then zeros up to `size` when it's given.
- `png({ width, height })`: the PNG signature, an `IHDR` chunk (width, height, `8, 2, 0, 0, 0`), a `tEXt` chunk holding the random bytes as hex, and `IEND`. Each chunk's CRC comes from `zlib.crc32`.
- `webp({ width, height })`: `RIFF`, the length, `WEBP`, a `VP8X` chunk of 10 bytes (width − 1 and height − 1 as 24-bit little-endian at offsets 4 and 7), and an `XTRA` chunk with the random bytes. Chunks are padded to even length.
- `heic()`: a 24-byte `ftyp` box with brand `heic` and compatible brands `mif1heic`, then the random bytes.
- `gif()`: `GIF89a`, a 16 by 16 size, the random bytes.

### Frontend

**`frontend/src/photos.ts`** (new): the only place for compression settings.
- `LONG_SIDE_MAX_PX = 2200`, `JPEG_QUALITY = 0.85`, `MAX_PHOTO_BYTES = 7 * 1024 * 1024`, `MAX_PAGES = 10`, and `ORIGINAL_TYPES = ['image/jpeg', 'image/png', 'image/webp']`.
- `scaledSize(width, height, longSideMax)`: scales so the long side is at most `longSideMax`, keeps the aspect ratio, never enlarges, rounds, and is never below 1. It throws on a zero size.
- `type Encode = (file: File, longSideMax: number, quality: number) => Promise<Blob>`.
- `encodeInBrowser: Encode`, browser-only and not unit tested:
  - Load the file through `URL.createObjectURL` into an `Image`, `await img.decode()`, and size it from `naturalWidth` and `naturalHeight`. These already reflect EXIF orientation.
  - Make a canvas of `scaledSize(...)` and fill it white, so a transparent PNG doesn't turn black. Set `imageSmoothingQuality = 'high'`: that's resampling, not a filter.
  - `drawImage` once, then `toBlob(…, 'image/jpeg', quality)`. A null blob, or one whose type isn't `image/jpeg`, throws.
  - Revoke the URL in `finally`.
- `preparePhoto(file, encode = encodeInBrowser): Promise<PreparedPhoto>`, where `PreparedPhoto` is `{ ok: true; blob: Blob } | { ok: false; problem: 'format'; format: string | null } | { ok: false; problem: 'too_large' }`:
  - It calls `encode(file, LONG_SIDE_MAX_PX, JPEG_QUALITY)`. A result over `MAX_PHOTO_BYTES` is `too_large`.
  - If `encode` throws, it falls back to the original. A type in `ORIGINAL_TYPES` at most `MAX_PHOTO_BYTES` returns the file as is. A type in the list but larger is `too_large`. Any other type is `format`, with `format` the file name's extension in uppercase (`HEIC`), or null without one.

**`frontend/src/accounts-api.ts`**
- Types: `UploadScope = 'mine' | 'all'`, `UploadRow`, `UploadList`, `DocumentDetail`, and `PageError { page: number; code: FieldErrorCode; documentId: string | null }`. The three new codes go into `FieldErrorCode`.
- `listUploads(scope)` calls `GET /api/uploads?scope=…` through `call()`. `getDocument(id)` does the same for `GET /api/documents/:id`.
- `imageUrl(id)` returns `/api/images/${encodeURIComponent(id)}`.
- `uploadPhotos(photos: Blob[], options?: { onProgress?: (fraction: number) => void; signal?: AbortSignal }): Promise<UploadResult>`. It uses `XMLHttpRequest`, since `fetch` can't report upload progress.

  ```ts
  type UploadResult =
    | { ok: true; id: string; alreadyUploaded: boolean }
    | { ok: false; error: 'unavailable' | 'unauthorized' | 'too_large' | 'aborted' }
    | { ok: false; error: 'rejected'; pageErrors: PageError[] }
  ```

  - `FormData` with one `photos` entry per blob, in order, named `pagina-<n>`.
  - `POST /api/uploads` with `X-Requested-With: XMLHttpRequest`.
  - Listeners through `addEventListener`: `progress` on `xhr.upload` (when `lengthComputable`, it reports `loaded / total`), and `load`, `error` and `abort` on the request. An aborted `signal` calls `xhr.abort()`.
  - Statuses:
    - 200 and 201 read `{ id, alreadyUploaded }`. A body that doesn't parse is `unavailable`.
    - 400 and 409 are `rejected`, with one `PageError` per error whose `field` matches `^photos\.(\d+)$`. `documentId` is kept when it's a string. Other errors are dropped, so a malformed 400 gives `pageErrors: []`.
    - 413 is `too_large`.
    - 401 runs the unauthorized handlers and returns `unauthorized`. Extract a private `notifyUnauthorized()` that `call()` uses too.
    - A network error and any other status are `unavailable`. Abort is `aborted`.

**`frontend/src/labels.ts`**
- `FIELD_ERROR_MESSAGES`:
  - `photo_type_invalid`: *Este formato no se puede subir. Sacá la foto desde la app o elegí JPG/PNG.*
  - `photo_repeated`: *Esta foto ya está en otra página de este documento.*
  - `photo_in_other_document`: *Esta foto ya está en otro documento.*
- `UPLOAD_SCOPE_LABELS: Record<UploadScope, string>`: `mine` is *Mías*, `all` is *Todas*.
- `photoFormatMessage(format: string | null)`: *Este formato no se puede subir (HEIC). Sacá la foto desde la app o elegí JPG/PNG.*, without the parenthesis when `format` is null.
- `PHOTO_TOO_LARGE_MESSAGE`: *La imagen es demasiado grande.*
- `UPLOAD_FAILED_MESSAGE`: *No se pudo subir. Volvé a intentar.*

**`frontend/src/format.ts`**: `formatPageCount(n)`, so 1 is *1 página* and 2 is *2 páginas*.

**`frontend/src/screens/upload-pages.ts`** (new, pure): the page list of *Subir*.
- `UploadPage`: `{ key: number; fileName: string; state: 'preparing' | 'ready' | 'problem'; blob: Blob | null; previewUrl: string | null; problem: PageProblem | null }`.
- `PageProblem`: `{ kind: 'format'; format: string | null } | { kind: 'too_large' } | { kind: 'server'; code: FieldErrorCode; documentId: string | null }`.
- `movePage(pages, index, delta)` does nothing at either end. `removePage(pages, index)`.
- `withServerErrors(sent, errors)` attaches each `PageError` to the page that was at that index when the upload was sent. The problem then moves with its page.
- `canUpload(pages)`: from 1 to `MAX_PAGES` pages, every one `ready`, with no problem.
- Keys come from a module counter, never `crypto.randomUUID()`. The phone reaches the dev server over plain HTTP, which isn't a secure context, so `crypto.randomUUID` is undefined there.

**`frontend/src/screens/subidas-groups.ts`** (new, pure): `groupByDay(rows)` splits rows, in the order received, into consecutive groups by `daysAgo`. The labels are *Hoy* (0), *Ayer* (1), or `formatDate(uploadedOn)`.

**Routes** (`Shell.tsx`) and header links. The nav becomes *Resumen*, *Subir*, *Subidas*, *Pagos*.

| Path | Screen | Wireframe |
| --- | --- | --- |
| `/subir` | *Subir* | 4a–4e |
| `/subidas` (`?ver=todas` for *Todas*) | *Subidas* | 4g |
| `/documentos/:id` | *Documento* | 5a, 4f |

***Subir*** (`screens/Subir.tsx`)
- With no pages: *Subir documento*, the hint *Encuadrá la hoja entera. Una foto por página.*, and two buttons. *Sacar foto* uses a hidden input with `accept="image/*" capture="environment"`. *Galería* uses one with `accept="image/*" multiple`. Each input's `value` is reset after a pick, so the same file can be picked again.
- Each picked file becomes a `preparing` page, and `preparePhoto` runs on the pages one at a time. That keeps a phone's memory low, and compression happens without notice (4c).
- With pages (4b): the title shows `formatPageCount(n)` and *✕* goes back. Each row has:
  - the thumbnail, from an object URL of the prepared blob, or a grey box with the format for a format problem. Tapping a thumbnail opens it at full width, with *Cerrar*.
  - *Página {n}*, or *Preparando…* while it's being prepared.
  - ↑ and ↓ (labels *Mover antes* and *Mover después*) and ✕ (*Quitar página*).
  - The problem under the row (4d): `photoFormatMessage`, `PHOTO_TOO_LARGE_MESSAGE`, or the server code's message. `photo_in_other_document` adds a *Ver documento* link to `/documentos/<documentId>`.
- Under the list: *+ Agregar página* (camera) and *Galería*. At 10 pages both are disabled, with *Hasta 10 páginas por documento.* Extra gallery files past 10 aren't added, and the same line shows.
- *Subir documento* is enabled only when `canUpload`. With any problem, it shows *Quitá o reemplazá las páginas marcadas para subir.*
- Uploading (4c): *Subiendo {formatPageCount(n)}…*, the percentage, and *Cancelar*, which aborts and goes back to the list with the pages kept.
- `unavailable` (4e): *Se cortó la conexión.*, *Las fotos siguen en este teléfono. Cuando vuelva la señal, reintentá.*, *Reintentar* (sends the same blobs again, which the same-image check makes safe), and *Descartar fotos* (empties the list).
- `rejected` with page errors puts them on the pages. With none, it shows `UPLOAD_FAILED_MESSAGE`. `too_large` shows *Alguna foto es demasiado grande. Quitala y volvé a intentar.* `unauthorized` shows nothing.
- `ok` navigates to `/documentos/<id>` with `replace: true` and `state: { alreadyUploaded }`.
- Object URLs are revoked when a page is removed and on unmount.

***Documento*** (`screens/Documento.tsx`, 5a)
- *← Subidas*.
- The heading is `documentTitle(doc)` when `type` is set, otherwise nothing for *Procesando* and *Documento sin datos* for the rest. The status badge comes from `REVIEW_STATUS_LABELS`.
- With `state.alreadyUploaded`: the notice *Este documento ya estaba subido. No se creó uno nuevo.*
- The pages scroll sideways with CSS scroll snap. Each one is an `<img src={imageUrl(id)} alt="Página {n} de {m}">` inside a link to the same URL with `target="_blank" rel="noopener"`, where pinch zoom works, and a caption *pág. {n} de {m}*. With no images: *Este documento se cargó a mano y no tiene fotos.*
- *Procesando*: *Leyendo el documento… Tarda menos de un minuto. Podés salir: lo vas a encontrar en Subidas.*, with a link to *Subidas*.
- *Subido por {name} · {dd/mm/aaaa} {HH:MM}*, or *Cargado por …* for a manual document.
- `not_found` shows *No encontramos este documento.* Other failures show *No pudimos cargar el documento.*, *Revisá la conexión.* and *Reintentar*.

***Subidas*** (`screens/Subidas.tsx`, 4g)
- *Subidas*, with a *+ Subir* link in the top bar. The *Mías* and *Todas* chips use the existing `.chips` markup, with *Mías* by default.
- `groupByDay` headings, then one row per document, linking to `/documentos/<id>`:
  - *Procesando*: *Leyendo el documento…* and *{formatPageCount(n)} · {HH:MM}*.
  - Otherwise: `documentTitle`, or *Documento sin datos* without a type, and the non-null parts of *{supplierName} · {formatMoney(total)} · {HH:MM}*.
  - The status badge.
- Empty: *No subiste nada en los últimos 7 días.* for *Mías*, *No se subió nada en los últimos 7 días.* for *Todas*.
- Failure: *No pudimos cargar las subidas.*, *Revisá la conexión.* and *Reintentar*. Only the latest response is applied, as in *Pagos*.

## Behaviors to test

Backend tests go through HTTP with supertest against `createTestApp()` and a real Postgres, unless an item says it inserts rows directly. Photos come from `test/photos.ts`. Tests that check that nothing was written use a fresh user, and count that user's documents plus the rows with the test's hashes, because other spec files upload at the same time. `uploads.spec.ts` gives its app a directory of its own: `vi.stubEnv('UPLOAD_DIR', <fresh mkdtemp>)` before `createTestApp()`, and `vi.unstubAllEnvs()` in `afterAll`. That way, "no file written" can be checked by listing it.

**Uploading** (`backend/src/uploads/uploads.spec.ts`; Date faked at `2026-11-19T02:30:00Z`)
- Acceptance 1: Ana uploads a JPEG and a PNG and gets 201 with `alreadyUploaded: false`.
  - The document is `upload` and `processing`, created by Ana, with no type, supplier or total.
  - It has two images: position 1 is the JPEG and position 2 the PNG. Each has the right mime type, width, height, size and the sha256 of the bytes sent.
  - It has one job: `queued`, `attempts` 0, `run_after` at the faked instant.
  - It has one `documents` `create` audit entry by Ana.
- E5: the file under each `storage_key` has the sha256 of the bytes sent, the two keys differ, and the directory holds exactly those two new files.
- `GET /api/documents/:id` returns `processing`, `createdByName` *Ana*, `createdOn` `2026-11-18` and `createdTime` `23:30`, and both images in order.
- The bytes decide the type: a PNG sent with `Content-Type: image/jpeg` is stored as `image/png`.
- A JPEG with EXIF orientation 6, encoded 2200 by 1650, is stored as 1650 wide and 2200 high.

**Same image** (`uploads.spec.ts`; X is acceptance 1's document)
- Acceptance 2:
  - The same two photos again give 200 with X's id and `alreadyUploaded: true`.
  - X still has two images, one job and one audit entry, and no document but X has those hashes.
  - No file was written.
- The same two in reverse order, and the second one alone, also return X.
- X moved to `error` (directly) still matches.
- X's first photo with a new photo gives 409 with exactly `[{ field: 'photos.0', code: 'photo_in_other_document', documentId: X }]`. Nothing is written: no document, no image with the new hash, no file.
- A photo from X and a photo from another upload, Y, give 409 naming X on `photos.0` and Y on `photos.1`. Nothing is written.
- Deleting:
  - After `DELETE /api/documents/<Z>`, uploading Z's photo gives 201 and a new document N. Z keeps its image row.
  - Uploading that photo again returns N.
- The same photo twice in one upload gives 400 with exactly `[{ field: 'photos.1', code: 'photo_repeated' }]`. Nothing is written.
- Concurrency: two identical uploads of new photos sent at once.
  - The statuses are 201 and 200, in either order, with the same id.
  - Exactly one document has those hashes.
  - Repeat five times with new photos. Removing the advisory lock must make this fail, as the probe did.

**Refused uploads** (`uploads.spec.ts`; each writes nothing: no document by that user, no file)
- `[jpeg, heic, gif]` gives 400 with `photo_type_invalid` on `photos.1` and `photos.2`, both in one response.
- A text file and an empty file each give `photo_type_invalid`.
- A JPEG of exactly 7 MiB gives 201. One byte more gives 413.
- These give 400 with no field errors:
  - no `X-Requested-With`, with a valid session
  - a JSON body
  - 11 photos
  - a text field next to a photo
  - a photo under the field name `photo`
- Without a session, an upload gets 401.

**Rollback** (`backend/src/audit/audit-rollback.spec.ts`, with the existing `FailingAuditService`)
- Failing on `documents`, an upload returns 500 and leaves no document, image or job with those hashes. With `failOn` back to null, the same photos then give 201 with `alreadyUploaded: false`. That proves no image row was left to match.

**Images** (`uploads.spec.ts`)
- `GET /api/images/:id` for each image of X returns 200, the stored `Content-Type`, and a body whose sha256 equals that of the uploaded bytes. It carries `Cache-Control: private, no-store`, `X-Content-Type-Options: nosniff` and the CSP header.
- Acceptance 3: without a session it's 401.
- A non-UUID id and an unknown id give 404. So does Z's image, now that Z is deleted.

***Documento* reads** (`backend/src/documents/documents.spec.ts`)
- A manual document returns `source` `manual`, `reviewed`, its type, letter and number, and `images: []`.
- A non-UUID, unknown or deleted id gives 404.

***Subidas*** (`backend/src/uploads/subidas.spec.ts`; Date faked, the clock moved with `vi.setSystemTime`, signing in again after each move past 30 days)
- Ana uploads A at `2026-11-12T13:00:00Z` (10:00 in Buenos Aires), then B five minutes later. B is set directly to `unreviewed` with an informal supplier, type `invoice`, letter `A`, a number with its `number_normalized`, issue and due dates with `due_date_source` `manual`, and total `53600.00`, which the `documents` `CHECK`s require. Beto uploads C at `2026-11-12T14:00:00Z`.
- At `2026-11-18T13:00:00Z`:
  - Ana's *Mías* is exactly `[B, A]`, each with `daysAgo` 6, `uploadedOn` `2026-11-12`, `uploadedTime` `10:05` and `10:00`, `createdByName` *Ana*, and `pageCount`.
  - B carries its type, letter, number, supplier name and `"53600.00"`. A has nulls.
  - *Todas* includes A, B and C (found by id). Beto's *Mías* is exactly `[C]`.
- At `2026-11-19T02:59:00Z` (23:59 on the 18th in Buenos Aires), B is still listed.
- At `2026-11-19T03:00:00Z` (00:00 on the 19th), B is gone and A, still *Procesando*, is listed.
- At `2026-12-30T15:00:00Z`, A is listed with `daysAgo` 48.
- A deleted upload and a manual document are never listed.
- `scope` missing, `scope=x` and `scope=mine&scope=all` give 400.

**Startup** (`backend/src/uploads/uploads-config.spec.ts`, as in `auth.spec.ts`): without `UPLOAD_DIR`, or with `uploads` (relative), `createTestApp()` rejects with a message naming `UPLOAD_DIR`.

**Units**
- `backend/src/uploads/photo.spec.ts`:
  - `inspectPhoto` reads a JPEG, a PNG and a WebP: type, extension, width, height, size and the computed sha256.
  - It swaps the sizes for orientation 6 and keeps them for orientation 1.
  - It returns null for HEIC, GIF, text, empty bytes and a JPEG without a frame header (only `FF D8 FF D9`).

**Database** (`backend/src/uploads/upload-tables.spec.ts`; rows inserted directly)
- A valid image and a valid job are accepted.
- The image `CHECK`s refuse, matched by name:
  - position 0
  - width 0
  - `size_bytes` 0
  - an uppercase hash and a 63-character one
  - `image/heic`
  - storage keys `../x.jpg` and `<uuid>.gif`
- These are refused too: a second image at the same position, a repeated `storage_key`, and a job with `attempts` −1.
- A hard `DELETE` of a document that has images fails on its foreign key.

**Routes** (`test/routes.spec.ts`): the listing includes `post /api/uploads`, `get /api/uploads`, `get /api/documents/:id` and `get /api/images/:id`, and each answers 401 without a session.

**Frontend** (Node unit tests, `fetch` and `XMLHttpRequest` stubbed)
- `photos.spec.ts`, the compression options test:
  - `preparePhoto` calls the encoder with `(file, 2200, 0.85)` and returns its blob.
  - When the encoder throws:
    - a JPEG of exactly 7 MiB returns the original
    - one byte more is `too_large`
    - a small PNG and a small WebP return the original
    - `IMG_1.HEIC` with type `image/heic` is `format` *HEIC*
    - `scan.pdf` with an empty type is `format` *PDF*
    - a file without an extension is `format` null
  - An encoder result over 7 MiB is `too_large`.
  - `scaledSize`: 4000×3000 gives 2200×1650, 3000×4000 gives 1650×2200, 4033×3025 gives 2200×1650, 900×1600 and 2200×1000 stay as they are, and 1×5000 gives 1×2200.
- `accounts-api.spec.ts`:
  - `listUploads('mine')` calls `/api/uploads?scope=mine`. `getDocument` calls `/api/documents/<id>`. `imageUrl` encodes the id.
  - `uploadPhotos`, with a fake `XMLHttpRequest` (an `EventTarget` with an `upload` `EventTarget`, and `open`, `setRequestHeader`, `send` and `abort` recorded):
    - It sends a POST to `/api/uploads` with the header and the `photos` entries in order.
    - It reports progress fractions.
    - 201 and 200 map to `alreadyUploaded` false and true.
    - A 409 maps to page errors with index and `documentId`. A 400 without errors gives `pageErrors: []`.
    - 413 is `too_large`, and 401 calls the unauthorized handler.
    - A network error is `unavailable`, and aborting the signal is `aborted`.
- `upload-pages.spec.ts`:
  - Moving the first page earlier or the last later changes nothing.
  - Server errors land on the pages that were sent at those indexes, and stay with them after a move.
  - `canUpload` is false with no pages, with 11, with a page `preparing`, and with any problem. It's true otherwise.
- `subidas-groups.spec.ts`: rows with `daysAgo` 0, 0, 1, 3 give *Hoy* (2), *Ayer* (1) and the date of the third (1).
- `format.spec.ts`: `formatPageCount(1)` and `formatPageCount(2)`.

## Steps

One commit per step. Backend steps need `docker compose up -d db`, and after the schema change, `npx prisma generate`. "Verify" lists what proves the step is done. "All checks" means `npm run lint`, `npm run typecheck` and `npm test`, in the apps the step touches.

1. **Record the decisions**
   - In `system-design.md`, *Extraction*, *Capture*:
     - The first line becomes *Compress in the browser with a canvas, in one pass:*.
     - The EXIF bullet becomes *Apply EXIF orientation, which the browser does when it decodes the photo. No grayscale, thresholding or sharpening.*
     - Add a bullet: *Not `browser-image-compression`: by default it runs in a web worker that loads the library from a CDN, and when its result is larger than the original it lowers the quality again, up to ten times, with no way to turn that off.*
   - In *Screens*, under *Where the wireframes differ from this file on purpose*, add:
     - ***Subir (4a, 4b, 4f):** a button opens the phone's own camera, since a camera view inside the page needs HTTPS. Pages move with ↑ and ↓ instead of dragging. An upload that was already there opens its document with a notice, instead of a screen of its own.*
     - ***Subidas (4g):** rows have no thumbnail. The server never makes smaller copies (E5), and loading every full photo would spend the phone's data.*
   - Verify: backend `npm run lint` passes, since `check:cuits` scans the docs too.
2. **Tables and migration**
   - Add the enum, the two models and the back-relations. Generate the migration, append the hand-written block, migrate, generate.
   - Add `upload-tables.spec.ts`.
   - Verify:
     - All checks pass.
     - `\d document_images` shows the six `CHECK`s and three indexes.
     - Run `npx prisma migrate dev --create-only --name probe`. It generates nothing, and in particular no `DROP`. Delete the probe migration.
3. **Reading a photo**
   - Add `image-size` 2.0.2, `photo.ts`, `test/photos.ts` and `photo.spec.ts`.
   - Verify: all checks pass.
4. **Where files go**
   - Add `UploadsConfig`, `ImageStore`, an empty `UploadsModule` in `AppModule`, `UPLOAD_DIR` in `vitest.config.ts`, `.env.example` and `README.md`, and `uploads-config.spec.ts`.
   - Verify: all checks pass. `npm run start:dev` without `UPLOAD_DIR` exits with the message, and with an absolute one it creates the directory.
5. **Uploading**
   - Add the field error codes, `ADVISORY_LOCKS`, `UploadRequestGuard`, `POST /api/uploads` and `UploadsService.upload`, and update the `configure-app.ts` comment.
   - Add *Uploading*, *Same image*, *Refused uploads* and *Rollback*, except the `GET` assertions, which come in step 6.
   - Verify:
     - All checks pass.
     - `npx vitest run src/uploads` passes five times in a row.
     - With the lock line commented out, the concurrency test fails. Restore it.
6. **Reads**
   - Export `BUSINESS_TIME_ZONE`. Add `GET /api/images/:id`, `GET /api/documents/:id` and `GET /api/uploads`.
   - Add *Images*, *Documento reads*, *Subidas*, the `GET` assertions from step 5, and the four routes in `routes.spec.ts`.
   - Verify:
     - All checks pass.
     - With `start:dev`, sign in with `curl`, then upload two JPEGs built with `test/photos.ts` and written to a temporary directory outside the repo, with `-H 'X-Requested-With: XMLHttpRequest' -F photos=@a.jpg -F photos=@b.jpg`. Read `/api/documents/<id>`, `/api/images/<imageId>` and `/api/uploads?scope=mine`.
7. **Frontend foundations**
   - Add `photos.ts`, the API functions and types, the labels, `formatPageCount`, `upload-pages.ts`, `subidas-groups.ts`, and their tests.
   - Verify: frontend `npm run lint`, `npm run typecheck`, `npm test` and `npm run build` pass.
8. **Screens**
   - Add *Subir*, *Documento* and *Subidas*, the routes, the nav links and the CSS. The CSS uses the existing tokens, in light and dark.
   - Verify:
     - The frontend checks pass.
     - With both apps in dev mode and the frontend on `--host`, go through the manual acceptance below on a phone, and at 390 px wide on desktop, in light and dark mode.
9. **Docs**
   - `agents.md`, under *Where things live*:
     - `backend/src/uploads/`: `UploadsService` is the only writer of `document_images` and `extraction_jobs`. It takes `ADVISORY_LOCKS.uploads` before the same-image check. `ImageStore` is the only code that touches `UPLOAD_DIR`, and it writes bytes as they arrive (E5).
     - `frontend/src/photos.ts`: the only place for compression settings, a one-way door.
     - `backend/src/common/advisory-locks.ts`: every advisory lock key.
   - `agents.md`, under *Rules that are easy to miss*:
     - Tests build photos with `backend/test/photos.ts`. Never commit an image file: the CUIT check fails on binaries.
     - Tests get `UPLOAD_DIR` from the Vitest config. The backend won't start without it in `.env`.
     - The phone reaches the dev server over plain HTTP, which isn't a secure context. `crypto.randomUUID`, `crypto.subtle` and `getUserMedia` don't exist there.
     - Uploads in a spec file that checks files on disk use their own `UPLOAD_DIR`, through `vi.stubEnv` before `createTestApp()`.
   - Verify: all checks pass in both apps.

**Hand-off note for the user:** add `UPLOAD_DIR=<absolute path outside the repo>` to `.env` before starting the backend.

**Manual acceptance at the end** (invented data only)
1. On the phone, over the local network, open *Subir*, tap *Sacar foto* and photograph page 1 of a printed two-page document with invented data, holding the phone upright. Then *+ Agregar página* for page 2. Swap them with ↑ and ↓, swap them back, and tap a thumbnail to check it's legible and upright.
   - *Subir documento* shows the progress, then *Documento*.
   - *Documento* shows both pages in order, upright, *Procesando*, and *Subido por {your name}*.
   - In `psql`, `SELECT position, width, height FROM document_images WHERE document_id = '<id>' ORDER BY position` shows a long side of 2200 or less, and `extraction_jobs` has one `queued` row.
2. Upload the same two photos again from the gallery. *Documento* opens the same document with *Este documento ya estaba subido*, and `psql` still has one document with those hashes. If the second upload created a new document, this browser's JPEG encoder isn't deterministic: report it, because it means the same-image check only catches retries in that browser.
   - Upload page 1 together with a new photo. Page 1 shows *Esta foto ya está en otro documento.* with *Ver documento*, *Subir documento* is disabled until it's removed, and no document is created.
3. Copy an image URL from *Documento* (`/api/images/<id>`) and open it in a private window. It answers 401.
4. On a desktop browser:
   - Pick a `.heic` file. The page shows *Este formato no se puede subir (HEIC). …*
   - Make an 8 MB file that isn't an image with `head -c 8000000 /dev/urandom > grande.jpg` and pick it. It shows *La imagen es demasiado grande.*
   - With `curl`, as in step 6, an 8 MB file gives 413.
5. *Resumen* shows the same figures as before the uploads.
6. *Subidas* shows the upload under *Mías* and *Todas*, under *Hoy*, as *Leyendo el documento…*. Signed in as someone else, it shows under *Todas* only.

## Doors

| Part | Door | Note |
| --- | --- | --- |
| Compression in the browser (`photos.ts`: 2200 px, 0.85, one pass) | **One-way** (image compression settings) | Originals aren't kept, so a photo compressed too hard can't be recovered. See below. |
| Same-image check (lock, matching rules, 200 and 409) | **One-way** (document deduplication) | See below. |
| `GET /api/images/:id`, the multipart route, `UPLOAD_DIR` permissions | **One-way** (access to documents and images) | See below. |
| `GET /api/documents/:id` and `GET /api/uploads` | Two-way | Reads behind the existing `SessionGuard`, with no new `@Public()`. `routes.spec.ts` lists them and checks the 401. They filter `deleted_at` (D3). |
| Tables, enum, `CHECK`s and migration | Two-way | New tables on an empty database. `prisma migrate reset` undoes them in development. |
| `audit_log` entry for an upload | Two-way now | A missing entry can't be recreated later, but no real upload exists yet. |
| Frontend screens and copy | Two-way | The backend enforces every rule. |

Not on the list: nothing is hard-deleted, and no data leaves the system. No photo is sent anywhere, and no third-party script runs in the page or a worker, which is part of why decision 1 drops `browser-image-compression`.

**Blast radius today: none.** Nothing real is uploaded before slice 8, the test and dev databases hold invented data, and slice 5's extraction test checks the 2200 px against the real samples before any of this is used. Each door's risk starts with the first real photo in production.

**Compression**
- *If it's wrong*: every photo uploaded until it's fixed is stored too small or too blurry, and the original is gone. Extraction reads worse, and nothing flags it except worse extraction.
- *How the plan shrinks it*:
  - The settings live in one module, and a test pins the encoder call to `(file, 2200, 0.85)`.
  - One encode from the decoded original, never a quality loop: decision 1 is the evidence.
  - Slice 5's gate confirms 2200 px with real samples before slice 8.
  - The manual acceptance checks that a phone photo is upright and legible.
- *Limit*: an original uploaded after compression failed keeps its EXIF, including location if the phone wrote it. Slice 5 sends those bytes to the LLM, which belongs in slice 5's door.

**Deduplication**
- *If it's wrong*:
  - A false match refuses or redirects a real upload, which the person sees.
  - A missed match creates a second document from the same photos, which can count the debt twice once slice 5 extracts it. Slice 7's `duplicate_number` and `duplicate_suspected` catch most of these later.
  - A hash in two live documents breaks "no image belongs to two documents".
- *How the plan shrinks it*:
  - One shared `pg_advisory_xact_lock`, taken before the check, in the transaction that inserts. The probe showed two documents in 3 runs out of 3 without it, and one with it, and a concurrency test repeats it.
  - The match rules are decided under the lock, in one function, with a test for each case in the spec.
  - Nothing is written on 200, 400 or 409, not even a file.
  - Only `UploadsService` writes `document_images`.
- *Known limits*:
  - The hash is of the compressed bytes. The same photo compressed in another browser, or in one that adds noise to canvas output against fingerprinting, gives other bytes and isn't caught. Retries resend the same blobs, so they are. Acceptance 2 checks this on the real phone.
  - Without a unique index, a raw `INSERT` from `psql` can put a hash in two documents.

**Access to images**
- *If it's wrong*: photos of the restaurant's financial documents reach someone without an account, which can't be taken back.
- *How the plan shrinks it*:
  - Images are only served by `GET /api/images/:id`, behind the default-deny `SessionGuard`, never as static files. `UPLOAD_DIR` lives outside the repo and outside any served directory, at mode `0700` with files at `0600`.
  - The file path comes only from `storage_key`. The server generates it, and a `CHECK` limits it to `<uuid>.<jpg|png|webp>`, so no path can reach the join.
  - Responses are `no-store`, `nosniff` and sandboxed by CSP, so a polyglot file can't run as a page and no copy stays in a shared phone's cache.
  - A deleted document's images answer 404 (D3).
  - The multipart parser runs only after `SessionGuard` and `UploadRequestGuard`. An unauthenticated request never reaches it, and a cross-site form can't send the header.
  - `routes.spec.ts` checks the 401, and acceptance 3 checks it in a private window.
- *Limit*: every signed-in person sees every image, as decision 5 of the design says (every role has full access in the MVP).

**Look closely at**
- `UploadsService.upload`: the lock is the first statement in the transaction, the check is a new statement after it, the files are written after the check, and the `200` and `409` paths return before any write.
- The match rules: "every hash matched and one document" is the only path to 200, and `deleted_at IS NULL` is in the check's query.
- That the bytes written, hashed and served are `file.buffer` itself, with no copy that could change (E5).
- `ImageStore` uses `wx` and `sync()`, and builds paths only from `storage_key`.
- The guard order on `POST /api/uploads` (global `SessionGuard`, then `UploadRequestGuard`, then `FilesInterceptor`) and the multer `limits`.
- That `photos.ts` makes exactly one `toBlob` call per photo, with `'image/jpeg'` and `JPEG_QUALITY`, and no other drawing than the white fill and one `drawImage`.
- The image response headers, and the 404 for a deleted document's image.
