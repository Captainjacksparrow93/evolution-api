// Import this first so Sentry can instrument everything below it.
import '@utils/instrumentSentry';
// Map platform-provided env var names before env.config builds its singleton.
import '@config/env-compat';

import { PrismaRepository } from '@api/repository/repository.service';
import { HttpStatus, router } from '@api/routes/index.router';
import { Auth, configService, Cors, HttpServer, Sentry as SentryConfig, Webhook } from '@config/env.config';
import { Logger } from '@config/logger.config';
import { ROOT_DIR } from '@config/path.config';
import * as Sentry from '@sentry/node';
import axios from 'axios';
import compression from 'compression';
import cors from 'cors';
import express, { json, NextFunction, Request, Response, urlencoded } from 'express';
import { join } from 'path';

export type CreateAppOptions = {
  /**
   * Serverless mode: the app is invoked per request and the filesystem is
   * read-only. Skips the static mounts that assume local directories.
   */
  serverless?: boolean;
};

/**
 * Body size limit for the JSON and urlencoded parsers.
 *
 * The historical default is 136mb, which suits a long-lived server receiving
 * base64 media. Serverless platforms cap payloads far lower (Vercel: 4.5mb), so
 * this is overridable to fail fast in Express with a clear 413 rather than an
 * opaque platform-level rejection.
 */
const bodyLimit = process.env.SERVER_MAX_BODY_SIZE || '136mb';

let prismaRepository: PrismaRepository;

/**
 * Returns the process-wide PrismaRepository, connecting on first use.
 *
 * Memoized at module scope so a reused serverless container does not open a new
 * connection pool on every warm invocation.
 */
export async function getPrismaRepository(): Promise<PrismaRepository> {
  if (!prismaRepository) {
    prismaRepository = new PrismaRepository(configService);
    await prismaRepository.onModuleInit();
  }

  return prismaRepository;
}

/**
 * Builds the Express application: middleware, routes and error handling.
 *
 * Deliberately does NOT listen, attach Socket.IO, load WhatsApp instances or
 * install process-level error handlers — those are lifecycle concerns owned by
 * the caller, and none of them are meaningful in a serverless invocation.
 */
export async function createApp(options: CreateAppOptions = {}): Promise<express.Express> {
  const logger = new Logger('SERVER');
  const app = express();

  await getPrismaRepository();

  app.use(
    cors({
      origin(requestOrigin, callback) {
        const { ORIGIN } = configService.get<Cors>('CORS');
        if (ORIGIN.includes('*')) {
          return callback(null, true);
        }
        if (ORIGIN.indexOf(requestOrigin) !== -1) {
          return callback(null, true);
        }
        return callback(new Error('Not allowed by CORS'));
      },
      methods: [...configService.get<Cors>('CORS').METHODS],
      credentials: configService.get<Cors>('CORS').CREDENTIALS,
    }),
    urlencoded({ extended: true, limit: bodyLimit }),
    json({ limit: bodyLimit }),
    compression(),
  );

  app.set('view engine', 'hbs');
  app.set('views', join(ROOT_DIR, 'views'));

  // Static mounts read from directories that only exist on a writable, local
  // filesystem. Skipped in serverless mode, where they can never resolve.
  if (!options.serverless) {
    app.use(express.static(join(ROOT_DIR, 'public')));
    app.use('/store', express.static(join(ROOT_DIR, 'store')));
  }

  app.use('/', router);

  app.use(
    (err: Error, req: Request, res: Response, next: NextFunction) => {
      if (err) {
        const webhook = configService.get<Webhook>('WEBHOOK');

        if (webhook.EVENTS.ERRORS_WEBHOOK && webhook.EVENTS.ERRORS_WEBHOOK != '' && webhook.EVENTS.ERRORS) {
          const tzoffset = new Date().getTimezoneOffset() * 60000; //offset in milliseconds
          const localISOTime = new Date(Date.now() - tzoffset).toISOString();
          const now = localISOTime;
          const globalApiKey = configService.get<Auth>('AUTHENTICATION').API_KEY.KEY;
          const serverUrl = configService.get<HttpServer>('SERVER').URL;

          const errorData = {
            event: 'error',
            data: {
              error: err['error'] || 'Internal Server Error',
              message: err['message'] || 'Internal Server Error',
              status: err['status'] || 500,
              response: {
                message: err['message'] || 'Internal Server Error',
              },
            },
            date_time: now,
            api_key: globalApiKey,
            server_url: serverUrl,
          };

          logger.error(errorData);

          const baseURL = webhook.EVENTS.ERRORS_WEBHOOK;
          const httpService = axios.create({ baseURL });

          httpService.post('', errorData);
        }

        return res.status(err['status'] || 500).json({
          status: err['status'] || 500,
          error: err['error'] || 'Internal Server Error',
          response: {
            message: err['message'] || 'Internal Server Error',
          },
        });
      }

      next();
    },
    (req: Request, res: Response, next: NextFunction) => {
      const { method, url } = req;

      res.status(HttpStatus.NOT_FOUND).json({
        status: HttpStatus.NOT_FOUND,
        error: 'Not Found',
        response: {
          message: [`Cannot ${method.toUpperCase()} ${url}`],
        },
      });

      next();
    },
  );

  const sentryConfig = configService.get<SentryConfig>('SENTRY');
  if (sentryConfig.DSN) {
    logger.info('Sentry - ON');

    // Add this after all routes,
    // but before any and other error-handling middlewares are defined
    Sentry.setupExpressErrorHandler(app);
  }

  return app;
}
