import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { createTestApp } from './app.js';

interface RouteLayer {
  route?: { path: string; methods: Record<string, boolean> };
}

interface ExpressApp {
  router: { stack: RouteLayer[] };
}

/** Every method and path registered on the real app, read from Express at run time. */
function registeredRoutes(
  app: NestExpressApplication,
): { method: string; path: string }[] {
  const express = app.getHttpAdapter().getInstance() as ExpressApp;
  return express.router.stack.flatMap(({ route }) =>
    route
      ? Object.keys(route.methods)
          .filter((method) => route.methods[method])
          .map((method) => ({ method, path: route.path }))
      : [],
  );
}

const PUBLIC_ROUTES = new Set(['post /api/auth/login']);

describe('every route', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('finds the auth and account routes, so a broken listing fails instead of passing on nothing', () => {
    const routes = registeredRoutes(app).map(
      ({ method, path }) => `${method} ${path}`,
    );
    expect(routes).toEqual(
      expect.arrayContaining([
        'post /api/auth/login',
        'get /api/auth/me',
        'post /api/auth/logout',
        'get /api/suppliers',
        'post /api/suppliers',
        'get /api/suppliers/:id',
        'put /api/suppliers/:id',
        'post /api/suppliers/:id/term/preview',
        'post /api/suppliers/:id/term',
        'post /api/documents',
        'put /api/documents/:id',
        'post /api/documents/:id/review',
        'post /api/documents/:id/retry',
        'delete /api/documents/:id',
        'post /api/applications/preview',
        'post /api/applications',
        'post /api/payments',
        'post /api/payments/mark-paid',
        'get /api/payments',
        'get /api/payments/:id',
        'post /api/uploads',
        'get /api/uploads',
        'get /api/documents/:id',
        'get /api/images/:id',
        'get /api/error-documents',
      ]),
    );
  });

  it('answers 401 without a session, except sign-in', async () => {
    const routes = registeredRoutes(app).filter(
      ({ method, path }) => !PUBLIC_ROUTES.has(`${method} ${path}`),
    );
    expect(routes.length).toBeGreaterThan(0);

    for (const { method, path } of routes) {
      const url = path.replace(/:\w+/g, () => randomUUID());
      const server = request(app.getHttpServer());
      const res = await server[method as 'get'](url).send({});
      expect({ method, path, status: res.status }).toEqual({
        method,
        path,
        status: 401,
      });
    }
  });

  it('keeps 404 for a path no route matches', async () => {
    await request(app.getHttpServer()).get('/api/nope').expect(404);
  });
});
