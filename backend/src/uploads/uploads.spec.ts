import { randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request, { type Response, type Test } from 'supertest';
import {
  createTestApp,
  createUser,
  signIn,
  type CreatedTestUser,
} from '../../test/app.js';
import { gif, heic, jpeg, png, sha256 } from '../../test/photos.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { MAX_PHOTO_BYTES } from './photo.js';

/** 23:30 on 2026-11-18 in Buenos Aires. */
const NOW = '2026-11-19T02:30:00.000Z';

interface Created {
  id: string;
  alreadyUploaded: boolean;
}

describe('uploads', () => {
  const uploadDir = mkdtempSync(path.join(os.tmpdir(), 'facturas-uploads-'));
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let ana: CreatedTestUser;
  let session: string;

  beforeAll(async () => {
    vi.stubEnv('UPLOAD_DIR', uploadDir);
    app = await createTestApp();
    prisma = app.get(PrismaService);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    ana = await createUser(app, { name: 'Ana' });
    session = await signIn(app, ana);
  });

  afterAll(async () => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    await app.close();
    rmSync(uploadDir, { recursive: true, force: true });
  });

  const http = () => request(app.getHttpServer());

  /** `POST /api/uploads` as the browser sends it, one `photos` part per photo. */
  function post(photos: Buffer[], as = session): Test {
    const req = http()
      .post('/api/uploads')
      .set('Cookie', `session=${as}`)
      .set('X-Requested-With', 'XMLHttpRequest');
    photos.forEach((bytes, i) => {
      req.attach('photos', bytes, {
        filename: `pagina-${i + 1}`,
        contentType: 'image/jpeg',
      });
    });
    return req;
  }

  const created = (res: Response) => res.body as Created;

  async function uploadNew(photos = [jpeg(), png()]): Promise<{
    id: string;
    photos: Buffer[];
  }> {
    const res = await post(photos).expect(201);
    return { id: created(res).id, photos };
  }

  const files = () => new Set(readdirSync(uploadDir));

  /** A fresh user's session, so "nothing written" counts only their rows. */
  async function freshUser(): Promise<{ id: string; session: string }> {
    const user = await createUser(app);
    return { id: user.id, session: await signIn(app, user) };
  }

  /** Every row and file an upload of `photos` by `userId` could have left. */
  async function written(userId: string, photos: Buffer[]) {
    return {
      documents: await prisma.document.count({
        where: { createdById: userId },
      }),
      images: await prisma.documentImage.count({
        where: { sha256: { in: photos.map(sha256) } },
      }),
      files: files().size,
    };
  }

  /** Runs `send`, then checks it wrote no row and no file. */
  async function expectNothingWritten(
    userId: string,
    photos: Buffer[],
    send: () => Promise<unknown>,
  ): Promise<void> {
    const before = await written(userId, photos);
    await send();
    expect(await written(userId, photos)).toEqual(before);
  }

  describe('uploading', () => {
    const photoA = jpeg({ width: 1650, height: 2200 });
    const photoB = png({ width: 1200, height: 1600 });
    let res: Response;
    let filesBefore: Set<string>;

    beforeAll(async () => {
      filesBefore = files();
      res = await post([photoA, photoB]);
    });

    it('creates a processing upload by Ana, with nothing else set (acceptance 1)', async () => {
      expect(res.status).toBe(201);
      expect(res.body).toEqual({
        id: expect.any(String) as unknown,
        alreadyUploaded: false,
      });
      const doc = await prisma.document.findUniqueOrThrow({
        where: { id: created(res).id },
      });
      expect(doc).toMatchObject({
        source: 'upload',
        reviewStatus: 'processing',
        createdById: ana.id,
        type: null,
        supplierId: null,
        total: null,
        letter: null,
        number: null,
        issueDate: null,
        dueDate: null,
        reviewedById: null,
        deletedAt: null,
      });
    });

    it('stores one image per photo, in the order sent', async () => {
      const images = await prisma.documentImage.findMany({
        where: { documentId: created(res).id },
        orderBy: { position: 'asc' },
      });
      expect(images).toMatchObject([
        {
          position: 1,
          mimeType: 'image/jpeg',
          width: 1650,
          height: 2200,
          sizeBytes: photoA.length,
          sha256: sha256(photoA),
        },
        {
          position: 2,
          mimeType: 'image/png',
          width: 1200,
          height: 1600,
          sizeBytes: photoB.length,
          sha256: sha256(photoB),
        },
      ]);
    });

    it('queues one extraction job at the upload instant', async () => {
      const jobs = await prisma.extractionJob.findMany({
        where: { documentId: created(res).id },
      });
      expect(jobs).toMatchObject([
        { status: 'queued', attempts: 0, runAfter: new Date(NOW) },
      ]);
    });

    it('writes one documents create entry by Ana', async () => {
      const entries = await prisma.auditLog.findMany({
        where: { entityId: created(res).id },
      });
      expect(entries).toMatchObject([
        { entity: 'documents', action: 'create', userId: ana.id, before: null },
      ]);
    });

    it('writes each file as sent, under its own key (E5)', async () => {
      const images = await prisma.documentImage.findMany({
        where: { documentId: created(res).id },
        orderBy: { position: 'asc' },
      });
      const keys = images.map((image) => image.storageKey);
      expect(new Set(keys).size).toBe(2);
      expect(
        keys.map((key) => sha256(readFileSync(path.join(uploadDir, key)))),
      ).toEqual([sha256(photoA), sha256(photoB)]);
      const added = [...files()].filter((file) => !filesBefore.has(file));
      expect(added.sort()).toEqual([...keys].sort());
    });

    it('takes the type from the bytes, never from the Content-Type', async () => {
      // `post` labels every part image/jpeg.
      const photo = png();
      const { id } = await uploadNew([photo]);
      const [image] = await prisma.documentImage.findMany({
        where: { documentId: id },
      });
      expect(image.mimeType).toBe('image/png');
      expect(image.storageKey).toMatch(/\.png$/);
    });

    it('stores a turned JPEG as displayed', async () => {
      const { id } = await uploadNew([
        jpeg({ width: 2200, height: 1650, orientation: 6 }),
      ]);
      const [image] = await prisma.documentImage.findMany({
        where: { documentId: id },
      });
      expect(image).toMatchObject({ width: 1650, height: 2200 });
    });
  });

  describe('same image', () => {
    let x: { id: string; photos: Buffer[] };

    beforeAll(async () => {
      x = await uploadNew();
    });

    async function rowsOf(id: string) {
      return {
        images: await prisma.documentImage.count({ where: { documentId: id } }),
        jobs: await prisma.extractionJob.count({ where: { documentId: id } }),
        entries: await prisma.auditLog.count({ where: { entityId: id } }),
      };
    }

    it('returns the same document for the same photos, and writes nothing (acceptance 2)', async () => {
      const filesBefore = files();
      const res = await post(x.photos).expect(200);
      expect(res.body).toEqual({ id: x.id, alreadyUploaded: true });
      expect(await rowsOf(x.id)).toEqual({ images: 2, jobs: 1, entries: 1 });
      const holders = await prisma.documentImage.findMany({
        where: { sha256: { in: x.photos.map(sha256) } },
        select: { documentId: true },
      });
      expect(new Set(holders.map((h) => h.documentId))).toEqual(
        new Set([x.id]),
      );
      expect(files()).toEqual(filesBefore);
    });

    it('returns it for the photos in reverse order', async () => {
      const res = await post([...x.photos].reverse()).expect(200);
      expect(res.body).toEqual({ id: x.id, alreadyUploaded: true });
    });

    it('returns it for some of its pages', async () => {
      const res = await post([x.photos[1]]).expect(200);
      expect(res.body).toEqual({ id: x.id, alreadyUploaded: true });
    });

    it('matches a document in any status', async () => {
      const doc = await uploadNew();
      await prisma.document.update({
        where: { id: doc.id },
        data: { reviewStatus: 'error' },
      });
      const res = await post(doc.photos).expect(200);
      expect(res.body).toEqual({ id: doc.id, alreadyUploaded: true });
    });

    it('refuses one of its photos with a new one, and writes nothing', async () => {
      const user = await freshUser();
      const fresh = jpeg();
      await expectNothingWritten(user.id, [x.photos[0], fresh], async () => {
        const res = await post([x.photos[0], fresh], user.session).expect(409);
        expect(res.body).toEqual({
          errors: [
            {
              field: 'photos.0',
              code: 'photo_in_other_document',
              documentId: x.id,
            },
          ],
        });
      });
    });

    it('refuses photos from two documents, naming each', async () => {
      const y = await uploadNew();
      const user = await freshUser();
      const photos = [x.photos[0], y.photos[1]];
      await expectNothingWritten(user.id, photos, async () => {
        const res = await post(photos, user.session).expect(409);
        expect(res.body).toEqual({
          errors: [
            {
              field: 'photos.0',
              code: 'photo_in_other_document',
              documentId: x.id,
            },
            {
              field: 'photos.1',
              code: 'photo_in_other_document',
              documentId: y.id,
            },
          ],
        });
      });
    });

    it('counts a deleted document’s photo as new, and keeps its image row', async () => {
      const z = await uploadNew([jpeg()]);
      await http()
        .delete(`/api/documents/${z.id}`)
        .set('Cookie', `session=${session}`)
        .expect(204);

      const first = await post(z.photos).expect(201);
      const n = created(first);
      expect(n).toEqual({
        id: expect.any(String) as unknown,
        alreadyUploaded: false,
      });
      expect(n.id).not.toBe(z.id);
      expect(
        await prisma.documentImage.count({ where: { documentId: z.id } }),
      ).toBe(1);

      const again = await post(z.photos).expect(200);
      expect(again.body).toEqual({ id: n.id, alreadyUploaded: true });
    });

    it('names the oldest document when a hash is somehow in two', async () => {
      const doc = await uploadNew([jpeg()]);
      // Written directly, after `doc` but dated before it.
      const { id: older } = await prisma.document.create({
        data: {
          source: 'upload',
          reviewStatus: 'processing',
          createdById: ana.id,
          createdAt: new Date('2026-11-01T12:00:00Z'),
          images: {
            create: {
              position: 1,
              storageKey: `${randomUUID()}.jpg`,
              mimeType: 'image/jpeg',
              width: 1650,
              height: 2200,
              sizeBytes: doc.photos[0].length,
              sha256: sha256(doc.photos[0]),
            },
          },
        },
      });
      const res = await post([doc.photos[0], jpeg()]).expect(409);
      expect(res.body).toEqual({
        errors: [
          {
            field: 'photos.0',
            code: 'photo_in_other_document',
            documentId: older,
          },
        ],
      });
    });

    it('refuses the same photo twice in one upload, marking only the second', async () => {
      const user = await freshUser();
      const photo = jpeg();
      await expectNothingWritten(user.id, [photo], async () => {
        const res = await post([photo, photo], user.session).expect(400);
        expect(res.body).toEqual({
          errors: [{ field: 'photos.1', code: 'photo_repeated' }],
        });
      });
    });

    it('creates one document when the same new photos arrive at once', async () => {
      for (let run = 0; run < 5; run++) {
        const photos = [jpeg(), png()];
        const results = await Promise.all([post(photos), post(photos)]);
        expect(results.map((r) => r.status).sort()).toEqual([200, 201]);
        const [a, b] = results.map(created);
        expect(a.id).toBe(b.id);
        const holders = await prisma.documentImage.findMany({
          where: { sha256: { in: photos.map(sha256) } },
          select: { documentId: true },
        });
        expect(new Set(holders.map((h) => h.documentId)).size).toBe(1);
      }
    });
  });

  describe('refused uploads', () => {
    let user: { id: string; session: string };

    beforeEach(async () => {
      user = await freshUser();
    });

    const send = (photos: Buffer[]) => post(photos, user.session);

    it('marks every page that is not a JPEG, PNG or WebP, in one response', async () => {
      const photos = [jpeg(), heic(), gif()];
      await expectNothingWritten(user.id, photos, async () => {
        const res = await send(photos).expect(400);
        expect(res.body).toEqual({
          errors: [
            { field: 'photos.1', code: 'photo_type_invalid' },
            { field: 'photos.2', code: 'photo_type_invalid' },
          ],
        });
      });
    });

    it.each([
      ['a text file', Buffer.from('not a photo, just some text')],
      ['an empty file', Buffer.alloc(0)],
    ])('refuses %s as photo_type_invalid', async (_, bytes) => {
      await expectNothingWritten(user.id, [], async () => {
        const res = await send([bytes]).expect(400);
        expect(res.body).toEqual({
          errors: [{ field: 'photos.0', code: 'photo_type_invalid' }],
        });
      });
    });

    it('accepts a photo of exactly 7 MiB', async () => {
      await send([jpeg({ size: MAX_PHOTO_BYTES })]).expect(201);
    });

    it('refuses a photo one byte over 7 MiB with 413', async () => {
      const photos = [jpeg(), jpeg({ size: MAX_PHOTO_BYTES + 1 })];
      await expectNothingWritten(user.id, photos, async () => {
        await send(photos).expect(413);
      });
    });

    it('refuses an upload without X-Requested-With', async () => {
      const photo = jpeg();
      await expectNothingWritten(user.id, [photo], async () => {
        const res = await http()
          .post('/api/uploads')
          .set('Cookie', `session=${user.session}`)
          .attach('photos', photo, 'pagina-1')
          .expect(400);
        expect(res.body).toEqual({ errors: [] });
      });
    });

    it('refuses an upload with the header set to something else', async () => {
      const photo = jpeg();
      await expectNothingWritten(user.id, [photo], async () => {
        await send([photo]).set('X-Requested-With', 'fetch').expect(400);
      });
    });

    it('refuses a JSON body', async () => {
      await expectNothingWritten(user.id, [], async () => {
        const res = await send([]).send({ photos: [] }).expect(400);
        expect(res.body).toEqual({ errors: [] });
      });
    });

    it('refuses a multipart body with no files', async () => {
      await expectNothingWritten(user.id, [], async () => {
        const res = await send([])
          .set('Content-Type', 'multipart/form-data; boundary=x')
          .send('--x--\r\n')
          .expect(400);
        expect(res.body).toEqual({ errors: [] });
      });
    });

    it('refuses 11 photos', async () => {
      const photos = Array.from({ length: 11 }, () => jpeg());
      await expectNothingWritten(user.id, photos, async () => {
        await send(photos).expect(400);
      });
    });

    it('accepts 10 photos', async () => {
      const photos = Array.from({ length: 10 }, () => jpeg());
      await send(photos).expect(201);
    });

    it('refuses a text field next to a photo', async () => {
      const photo = jpeg();
      await expectNothingWritten(user.id, [photo], async () => {
        await send([photo]).field('note', 'hola').expect(400);
      });
    });

    it('refuses a photo under another field name', async () => {
      const photo = jpeg();
      await expectNothingWritten(user.id, [photo], async () => {
        await http()
          .post('/api/uploads')
          .set('Cookie', `session=${user.session}`)
          .set('X-Requested-With', 'XMLHttpRequest')
          .attach('photo', photo, 'pagina-1')
          .expect(400);
      });
    });

    it('answers 401 without a session', async () => {
      await http()
        .post('/api/uploads')
        .set('X-Requested-With', 'XMLHttpRequest')
        .attach('photos', jpeg(), 'pagina-1')
        .expect(401);
    });
  });
});
