import { ProviderFiles } from '@api/provider/sessions';
import { eventManager, waMonitor } from '@api/server.module';
import { configService, HttpServer, ProviderSession } from '@config/env.config';
import { onUnexpectedError } from '@config/error.config';
import { Logger } from '@config/logger.config';
import { ServerUP } from '@utils/server-up';

import { createApp } from './app';

async function initWA() {
  await waMonitor.loadInstance();
}

/**
 * Long-lived server entrypoint: builds the app, binds it to an HTTP(S) server,
 * attaches the realtime event transports and loads the WhatsApp instances.
 *
 * The serverless entrypoint (src/vercel.ts) shares `createApp` but skips
 * everything below it — none of it survives a per-request invocation.
 */
async function bootstrap() {
  const logger = new Logger('SERVER');

  if (configService.get<ProviderSession>('PROVIDER').ENABLED) {
    const providerFiles = new ProviderFiles(configService);
    await providerFiles.onModuleInit();
    logger.info('Provider:Files - ON');
  }

  const app = await createApp();

  const httpServer = configService.get<HttpServer>('SERVER');

  ServerUP.app = app;
  let server = ServerUP[httpServer.TYPE];

  if (server === null) {
    logger.warn('SSL cert load failed — falling back to HTTP.');
    logger.info("Ensure 'SSL_CONF_PRIVKEY' and 'SSL_CONF_FULLCHAIN' env vars point to valid certificate files.");

    httpServer.TYPE = 'http';
    server = ServerUP[httpServer.TYPE];
  }

  eventManager.init(server);

  server.listen(httpServer.PORT, () => logger.log(httpServer.TYPE.toUpperCase() + ' - ON: ' + httpServer.PORT));

  initWA().catch((error) => {
    logger.error('Error loading instances: ' + error);
  });

  onUnexpectedError();
}

bootstrap();
