# Deploying Evolution API on Vercel (Meta Cloud API + Neon)

This deployment runs Evolution API as a Vercel Function backed by Neon Postgres.

> **Read this first.** Vercel is a serverless platform: no process survives between
> requests, the filesystem is read-only, and a function is capped at 300s. Evolution API's
> default WhatsApp mode (Baileys / QR code) needs a WebSocket held open for days, so **it
> cannot work here**. This deployment supports the **Meta WhatsApp Cloud API channel only**,
> which is webhook-driven and therefore a genuine fit.
>
> If you need QR-code login or Baileys, deploy to an always-on host (Railway, Fly.io,
> Render, or a VPS) using the provided `Dockerfile` instead. Nothing in this guide changes
> that path — `npm run start:prod` and the Docker image are unaffected.

## What works, and what does not

**Works**

- Meta Cloud API: sending and receiving messages, templates, media, status callbacks
- Instance CRUD, settings, proxy and label management
- Outbound webhooks (plain HTTP)
- Chat, contact and message queries against Neon
- HTTP-based chatbot integrations: OpenAI, Dify, N8N, Flowise, EvoAI, Typebot, Chatwoot

**Does not work**

| Feature | Why |
| --- | --- |
| Baileys / QR-code login | Needs a WhatsApp WebSocket open for days; a function is capped at 300s |
| Socket.IO / WebSocket events | No persistent connection; use outbound webhooks instead |
| RabbitMQ, SQS, NATS, Kafka | Brokers need a long-lived consumer connection |
| Media persistence | Requires S3/MinIO; with `S3_ENABLED=false` media stays on Meta's servers |
| Admin manager UI | Served from a git submodule Vercel does not clone — set `SERVER_DISABLE_MANAGER=true` |
| `/store` static files | Read-only filesystem |
| Cross-request caching | No Redis; the cache layer disables itself cleanly |
| Chatbot debounce timers, `node-cron` Chatwoot sync | Timers do not survive the response |

Uploads are also capped at **4.5 MB** by Vercel (against the 136 MB the app allows elsewhere).
Set `SERVER_MAX_BODY_SIZE=4mb` so Express returns a clear 413 instead of an opaque platform error.

## 1. Create the Neon database

Neon gives you two connection strings. You need both, for different purposes:

- **Pooled** (host contains `-pooler`) — used at runtime by the deployed function.
- **Direct** (no `-pooler`) — used to run migrations. PgBouncer cannot run DDL in transaction
  mode, so migrations must not use the pooled URL.

## 2. Run the migrations once, from your machine

Vercel's build does **not** run migrations. Apply the schema yourself against the **direct** endpoint:

```bash
export DATABASE_PROVIDER=postgresql
export DATABASE_CONNECTION_URI='postgresql://USER:PASSWORD@ep-xxx.REGION.aws.neon.tech/neondb?sslmode=require'
npm ci
npm run db:deploy
```

Verify with `npm run db:studio`.

## 3. Set the environment variables in Vercel

| Variable | Value | Notes |
| --- | --- | --- |
| `DATABASE_URL` | Neon **pooled** URL + `?sslmode=require&pgbouncer=true&connection_limit=1` | See note below |
| `DATABASE_PROVIDER` | `postgresql` | |
| `DATABASE_CONNECTION_CLIENT_NAME` | `evolution_exchange` | Scopes instances; must match across environments |
| `DATABASE_SAVE_DATA_INSTANCE` | `true` | Required — instances are loaded from the database on every request |
| `DATABASE_SAVE_DATA_NEW_MESSAGE` | `true` | Otherwise incoming messages are not stored |
| `AUTHENTICATION_API_KEY` | a long random string | **Must be set.** Unset falls back to the public constant `BQYHJGJHJ` |
| `SERVER_URL` | your production URL, e.g. `https://your-app.vercel.app` | No default; unset produces literal `undefined/...` URLs |
| `SERVER_TYPE` | `http` | Vercel terminates TLS for you |
| `SERVER_DISABLE_MANAGER` | `true` | |
| `SERVER_MAX_BODY_SIZE` | `4mb` | Matches Vercel's payload cap |
| `CACHE_REDIS_ENABLED` | `false` | |
| `CACHE_LOCAL_ENABLED` | `false` | |
| `S3_ENABLED` | `false` | |
| `PROVIDER_ENABLED` | `false` | |
| `TELEMETRY_ENABLED` | `false` | Telemetry is opt-**out**; on by default |
| `WEBSOCKET_ENABLED` | `false` | |
| `RABBITMQ_ENABLED` / `SQS_ENABLED` / `NATS_ENABLED` / `KAFKA_ENABLED` | `false` | |
| `WA_BUSINESS_URL` | `https://graph.facebook.com` | |
| `WA_BUSINESS_VERSION` | `v20.0` | The code default is the older `v18.0` |
| `WA_BUSINESS_LANGUAGE` | `en_US` | |
| `WA_BUSINESS_TOKEN_WEBHOOK` | a random string you choose | Echoed back during Meta's webhook verification |

**On `DATABASE_URL`:** the application and the Prisma datasource both read
`DATABASE_CONNECTION_URI`. `src/config/env-compat.ts` copies `DATABASE_URL` into it when only the
latter is set, so either name works. Setting `DATABASE_CONNECTION_URI` directly also works and takes
precedence.

**If the build fails on bundle size**, set `VERCEL_SUPPORT_LARGE_FUNCTIONS=1` to raise the limit from
250 MB to 5 GB. The serverless build already drops sourcemaps and the duplicate ESM output
(318 MB → 38 MB), so this is usually unnecessary.

## 4. Deploy

Push the branch and import the repository in Vercel. `vercel.json` handles the rest: it runs
`npm run build:vercel` (Prisma client generation with the Linux engine, then a CommonJS-only tsup
build) and routes every path to `api/index.js`.

Confirm the build log shows `Generated Prisma Client`, then:

```bash
curl https://your-app.vercel.app/
```

You should get the welcome JSON.

## 5. Create the Meta instance

```bash
curl -X POST https://your-app.vercel.app/instance/create \
  -H 'Content-Type: application/json' \
  -H 'apikey: YOUR_AUTHENTICATION_API_KEY' \
  -d '{
    "instanceName": "my-instance",
    "integration": "WHATSAPP-BUSINESS",
    "token": "META_PERMANENT_ACCESS_TOKEN",
    "number": "META_PHONE_NUMBER_ID",
    "businessId": "META_WABA_ID"
  }'
```

The three Meta values come from your Meta app dashboard — a permanent access token, the phone number
ID (not the phone number itself), and the WhatsApp Business Account ID.

## 6. Point Meta at the webhook

In the Meta app dashboard, under **WhatsApp → Configuration → Webhook**:

- **Callback URL:** `https://your-app.vercel.app/webhook/meta`
- **Verify token:** the value of `WA_BUSINESS_TOKEN_WEBHOOK`
- **Subscribe to:** the `messages` field

Meta sends a `GET` handshake first; it must return the challenge value. Then send a WhatsApp message
to your business number and confirm a row appears in the `Message` table in Neon. If the webhook
returns 200 but nothing is written, the instance's `number` does not match the `phone_number_id` Meta
is sending.

Send a message back to verify the outbound path:

```bash
curl -X POST https://your-app.vercel.app/message/sendText/my-instance \
  -H 'Content-Type: application/json' \
  -H 'apikey: YOUR_AUTHENTICATION_API_KEY' \
  -d '{"number": "RECIPIENT_NUMBER", "text": "hello from vercel"}'
```

## How this differs from the always-on deployment

Two changes make the serverless path work; both are no-ops for the normal server.

**Instances are loaded per request.** `waMonitor.waInstances` is an in-memory map that a long-lived
server fills once at boot via `loadInstance()`. A function starts with it empty on every cold start,
so `WAMonitoringService.getInstance()` loads the instance from Postgres on demand.
`instanceExistsGuard` calls it ahead of every instance-scoped route, and the Meta webhook controller
calls it directly. Hydration always forces `connectionStatus: 'close'` so a leftover Baileys row can
never trigger a socket open inside a function.

**Webhook processing is fully awaited.** The Meta webhook handler previously used an unawaited
`async forEach`, and `eventHandler` / `messageHandle` were called without `await`. On a long-lived
server that merely reorders work; on Vercel the invocation is frozen the moment the response is sent,
which silently dropped message writes and outbound webhooks. These are now awaited so the handler
only responds once the work has landed.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `EROFS` / `ENOENT` in logs | Something is writing to disk — check that `S3_ENABLED`, `PROVIDER_ENABLED` and `CACHE_LOCAL_ENABLED` are all `false` |
| Prisma "query engine not found" | The build did not run `prisma generate`; confirm `buildCommand` is `npm run build:vercel` |
| Neon "too many connections" | Add `connection_limit=1` to the pooled URL |
| `FUNCTION_PAYLOAD_TOO_LARGE` | Payload over 4.5 MB — a hard platform limit, not configurable |
| Webhook 200s but nothing is stored | `DATABASE_SAVE_DATA_NEW_MESSAGE` is not `true`, or the instance `number` does not match Meta's `phone_number_id` |
| Function times out | Raise `maxDuration` in `vercel.json` (max 300 on Hobby, 800 on Pro) |
