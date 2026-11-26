## Qué hace este cambio
Antes: la aplicación solo corría en desarrollo local (Postgres en `docker-compose.yml`, Vite y NestJS con `tsx`), sin reverse proxy, TLS ni herramientas de despliegue o gestión de usuarios en producción.
Ahora: toda la app (nginx con HTTPS vía Certbot, frontend SPA, backend NestJS, worker de extracción y Postgres) corre en un VPS con `docker-compose.prod.yml`, migraciones explícitas, CLI compilado de usuarios en el contenedor `backend`, smoke test read-only post-deploy y un verificador local del stack; los backups nocturnos y el restore quedaron diferidos fuera del MVP (`plans/mvp-slices.md`, `system-design.md`, `README.md`).

## Cómo funciona
1. En un VPS nuevo sin certificados, nginx arranca en modo HTTP seguro: solo sirve el desafío ACME (`/.well-known/acme-challenge/`, validación de dominio de Let's Encrypt) y devuelve `503` al resto para nunca exponer credenciales ni `/api` sin TLS (`nginx/entrypoint.sh`, `nginx/templates/http-only.conf.template`).
2. El operador emite el primer certificado con `deploy/init-cert.sh`; si antes probó con `--staging`, el script detecta el archivo de renovación de staging y pasa `--force-renewal` para reemplazarlo por uno de producción, reinicia nginx a HTTPS y levanta el servicio `certbot` que renueva cada 12 horas (`deploy/init-cert.sh`, `docker-compose.prod.yml`).
3. En modo HTTPS, el puerto 80 redirige con `301` al `APP_DOMAIN` configurado (ignorando cabeceras `Host` falsificadas para evitar open redirects) y el 443 sirve el SPA compilado con headers de seguridad (HSTS, `nosniff`, `DENY`, `Referrer-Policy`), `no-cache` en `/index.html` y caché inmutable en `/assets/*`, recargando nginx cada 6 horas sin montar el socket de Docker (`nginx/templates/https.conf.template`, `nginx/entrypoint.sh`, `nginx/Dockerfile`).
4. Las peticiones a `/api/*` se proxean al contenedor `backend` con límite de `75m` en `/api/uploads`, rate limit por IP (`10r/m`, `burst=10`, HTTP `429`) en `/api/auth/login` incluyendo barra final y mayúsculas/minúsculas (porque Express acepta ambas variantes), y `404` explícito en `/uploads` sin montar jamás el volumen de fotos (`nginx/templates/https.conf.template`, `docker-compose.prod.yml`).
5. `backend` y `worker` comparten la imagen `runtime` sin `devDependencies` bajo el usuario no-root `node` y el volumen `uploads-data` (`0700`/`0600`), pero con secretos aislados (`backend` nunca recibe `ANTHROPIC_API_KEY`, `LLM_MODEL` ni `RESTAURANT_CUIT`; `worker` nunca recibe `JWT_SECRET`), healthcheck de `backend` exigiendo `401` en `/api/auth/me` y apagado ordenado en `SIGTERM` (`backend/Dockerfile`, `docker-compose.prod.yml`, `backend/src/main.ts`).
6. Las migraciones corren solo bajo demanda con el perfil `ops` (`migrate`) y las cuentas se crean, resetean o deshabilitan con el CLI compilado en Node puro (`runUsersCli` en `backend/src/users/users-cli.ts`, `backend/src/users-cli.ts`, `backend/package.json`).

## Decisiones que tomó el código
- `docker-compose.prod.yml` separado en vez de modificar `docker-compose.yml`: mantiene Postgres local en `127.0.0.1:5432` intacto para los tests de Vitest.
- Frontend compilado en multi-stage dentro de `nginx/Dockerfile` en lugar de un volumen compartido: evita carreras de assets al desplegar y deja Node fuera de la imagen de nginx.
- Healthcheck por `401` en `/api/auth/me` en vez de un `/api/health` público: prueba que NestJS escucha y que `SessionGuard` está activo sin agregar ninguna ruta `@Public()`.
- Backups off-VPS diferidos fuera del MVP en lugar de implementarlos ahora (decisión explícita del usuario): simplifica el primer deploy a cambio de depender del disco del VPS hasta el próximo slice, mitigado con volúmenes persistentes y aviso explícito en `README.md` contra `down -v`.

## Qué prueban los tests
- Arranque HTTP-only (`503` en `/` y `/api/auth/login`, `200` en ACME), rechazo de `APP_DOMAIN` inválido, higiene de imágenes (sin `samples/`, `.env*` ni `tsx`), migración explícita, healthcheck `401`, arranque del worker sin llamadas externas y separación de puertos, secretos, UID/GID y volúmenes (`deploy/verify-stack.sh`).
- Redirect `301` inmune a `Host` falsificado, SPA + deep link `/a-resolver` + `/assets/*`, headers de seguridad, `401` sin sesión, `404` en `/uploads/*`, login con cookie `Secure; HttpOnly; SameSite=Strict; Path=/api`, lecturas autenticadas y logout sin imprimir ni exponer contraseñas (`deploy/smoke.sh`).
- CLI compilado (`user:create:prod`, `user:reset-password:prod`, `user:disable:prod` revocando sesiones), subida de foto con `worker` detenido + descarga autenticada byte-a-byte con `private, no-store` y CSP `sandbox`, bloqueo de `/uploads/<key>`, y rate limit `429` incluyendo `/api/auth/login/` y `/api/auth/LOGIN` (`deploy/verify-stack.sh`, `backend/scripts/users.spec.ts`, `backend/test/routes.spec.ts`).
- Sin cubrir: emisión y renovación real contra Let's Encrypt (`deploy/init-cert.sh` y el ciclo del servicio `certbot`), porque requiere DNS público y el VPS real; se valida ahí empezando con `--staging`.

## Cómo probarlo a mano
1. Correr `./deploy/verify-stack.sh` en local y verificar `ALL PRODUCTION STACK VERIFICATIONS PASSED.` (aislado en puertos `18080`/`18443`, sin tráfico externo y con limpieza automática).
2. En el VPS, copiar `.env.production.example` a `.env.production` (`chmod 600`), completar variables, probar `./deploy/init-cert.sh --staging` y luego emitir el certificado real con `./deploy/init-cert.sh`.
3. Correr migraciones (`docker compose -f docker-compose.prod.yml --env-file .env.production --profile ops run --rm --build migrate`), levantar el stack (`up -d --build`), crear el primer usuario con `exec backend npm run user:create:prod -- ...` y ejecutar `./deploy/smoke.sh --domain <tu-dominio> --email <email>`.

## Merge danger
- Door: **one-way**, porque expone autenticación, facturas e imágenes a internet, inaugura datos reales donde correrán futuras migraciones y difiere los backups fuera del VPS (`one-way-doors.md`).
- Blast radius: un error en rutas/montajes de nginx o un secreto filtrado en una imagen expondría datos financieros privados a internet; y sin backups off-VPS, perder el disco del VPS o ejecutar `down -v` borra definitivamente la base y las fotos.
- Look closely at:
  - `nginx/templates/https.conf.template` y `nginx/templates/http-only.conf.template`: verificar bloqueo total en HTTP-only salvo ACME, `404` en `/uploads`, `limit_req` en `/api/auth/login` (con variantes) y preservación de headers de seguridad.
  - `nginx/entrypoint.sh`: revisar validación de `APP_DOMAIN`, selección de template HTTP-only/HTTPS y recarga periódica sin socket de Docker.
  - `docker-compose.prod.yml`: confirmar que solo `nginx` publica puertos (`80`/`443`), `uploads-data` nunca se monta en `nginx` y `backend`/`worker` mantienen separados `JWT_SECRET` y `ANTHROPIC_API_KEY`.
  - `backend/Dockerfile`, `nginx/Dockerfile` y `.dockerignore`: confirmar exclusión de `samples/` y `.env*`, ejecución como `USER node` y permisos `0700` en `/data/uploads`.
  - `deploy/init-cert.sh`: revisar flujo ACME, reemplazo con `--force-renewal` al pasar de `--staging` a producción y verificación de cambio a HTTPS.
- Open questions:
  - Confirmar explícitamente que aceptás operar inicialmente en producción sin backups automáticos fuera del VPS (por ejemplo, manteniendo los comprobantes en papel) hasta planificar e implementar el slice de backups y restore.
