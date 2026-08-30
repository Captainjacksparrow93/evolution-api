/**
 * Environment variable compatibility shim.
 *
 * Evolution API and the Prisma datasource both read `DATABASE_CONNECTION_URI`
 * (see prisma/postgresql-schema.prisma). Most managed platforms — Vercel, Neon,
 * Railway — hand out the connection string as `DATABASE_URL` instead, so map it
 * across when only the platform name is present.
 *
 * This module MUST be imported before `@config/env.config`, which builds its
 * `configService` singleton at module load time.
 */
if (!process.env.DATABASE_CONNECTION_URI && process.env.DATABASE_URL) {
  process.env.DATABASE_CONNECTION_URI = process.env.DATABASE_URL;
}

export {};
