import dotenv from 'dotenv';
dotenv.config();

import { PrismaClient } from '@prisma/client';

declare global {
  // eslint-disable-next-line no-var
  var __prisma: PrismaClient | undefined;
}

// SINGLE shared Prisma client for the entire process. Every route handler AND every
// background worker (session cleanup, offline watcher, billing, expiry, winbox, auto-delete,
// radius sync, patchDatabase) must import THIS — never `new PrismaClient()`. Each extra client
// opens its own connection pool; several pools together exhaust Postgres's connection limit,
// which makes every query time out ("Timed out fetching a new connection from the connection
// pool") and hangs anything that touches the DB (e.g. tenant login). Reuse the global handle in
// every environment so a hot-reload or repeated import can't spawn a second pool.
//
// Pool sizing: control the per-process connection limit via the DATABASE_URL query param
// `?connection_limit=N&pool_timeout=20` rather than here, so it can be tuned per deploy without
// a code change. Keep N modest (e.g. 10-20) so a single instance can't monopolise Postgres.
const prisma =
  global.__prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
  });

global.__prisma = prisma;

export default prisma;
