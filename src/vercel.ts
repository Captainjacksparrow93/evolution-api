import type { Express } from 'express';
import type { IncomingMessage, ServerResponse } from 'http';

import { createApp } from './app';

/**
 * Serverless entrypoint.
 *
 * The app is built once per container and reused across warm invocations, so
 * the Prisma connection and the whole module graph are paid for only on a cold
 * start. An Express app is itself a `(req, res)` handler, so it can be handed
 * the platform's request and response directly — no adapter needed.
 *
 * `serverless: true` skips the static mounts that assume a writable local
 * filesystem. Socket.IO, the message brokers and the WhatsApp instance loader
 * are not started here at all: nothing survives between invocations, so
 * instances are hydrated from the database per request instead (see
 * WAMonitoringService.getInstance).
 */
let appPromise: Promise<Express>;

function getApp(): Promise<Express> {
  if (!appPromise) {
    // Retry the next invocation if the cold start fails, rather than caching a
    // rejected promise for the life of the container.
    appPromise = createApp({ serverless: true }).catch((error) => {
      appPromise = undefined;
      throw error;
    });
  }

  return appPromise;
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  const app = await getApp();

  return app(req as any, res as any);
}
