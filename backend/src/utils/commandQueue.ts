// Persistent command queue backed by the database (RouterCommand table).
// The previous in-memory version lost queued commands whenever the backend
// restarted or ran on a different instance, so reprovision/commands silently
// never reached the router. Persisting them fixes that.
import prisma from './prisma';

// Enqueue a command for a router. Returns the queued command id.
export async function enqueueCommand(routerId: string, command: string): Promise<string> {
  const row = await prisma.routerCommand.create({
    data: { routerId, command, consumed: false },
  });
  return row.id;
}

// Fetch and consume pending commands for a router (atomically marks them consumed). Delivery is
// SIZE-CAPPED: we never hand the router a blob bigger than ~25KB in one poll. A full ZTP is ~19KB,
// so it goes out alone; if several are queued they drain one-per-poll instead of being joined into a
// single oversized payload that the router can't import (which previously timed out and poisoned the
// command channel). At least one command is always returned so the queue can never stall.
export async function dequeueAll(routerId: string): Promise<string[]> {
  const rows = await prisma.routerCommand.findMany({
    where: { routerId, consumed: false },
    orderBy: { createdAt: 'asc' },
  });
  if (rows.length === 0) return [];
  const MAX_BYTES = 25000;
  const picked: typeof rows = [];
  let total = 0;
  for (const r of rows) {
    if (picked.length > 0 && total + r.command.length > MAX_BYTES) break; // always deliver ≥1
    picked.push(r);
    total += r.command.length;
  }
  const ids = picked.map(r => r.id);
  await prisma.routerCommand.updateMany({ where: { id: { in: ids } }, data: { consumed: true } });
  return picked.map(r => r.command);
}

// Delete all pending (unconsumed) commands for a router. Returns how many were cleared.
export async function clearQueue(routerId: string): Promise<number> {
  const res = await prisma.routerCommand.deleteMany({ where: { routerId, consumed: false } });
  return res.count;
}

// How many commands are pending for a router.
export async function peek(routerId: string): Promise<number> {
  return prisma.routerCommand.count({ where: { routerId, consumed: false } });
}
