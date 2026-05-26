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

// Fetch and consume all pending commands for a router (atomically marks them consumed).
export async function dequeueAll(routerId: string): Promise<string[]> {
  const rows = await prisma.routerCommand.findMany({
    where: { routerId, consumed: false },
    orderBy: { createdAt: 'asc' },
  });
  if (rows.length === 0) return [];
  const ids = rows.map(r => r.id);
  // Mark consumed immediately so the next poll doesn't re-deliver them.
  await prisma.routerCommand.updateMany({
    where: { id: { in: ids } },
    data: { consumed: true },
  });
  return rows.map(r => r.command);
}

// How many commands are pending for a router.
export async function peek(routerId: string): Promise<number> {
  return prisma.routerCommand.count({ where: { routerId, consumed: false } });
}
