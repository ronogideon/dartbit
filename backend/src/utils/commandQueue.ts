// Simple in-memory command queue, keyed by routerId.
// Note: not persistent across restarts. For production, use a DB table.
const pendingCommands: Record<string, string[]> = {};

export function enqueueCommand(routerId: string, command: string) {
  if (!pendingCommands[routerId]) pendingCommands[routerId] = [];
  pendingCommands[routerId].push(command);
  return pendingCommands[routerId].length;
}

export function dequeueAll(routerId: string): string[] {
  const cmds = pendingCommands[routerId] || [];
  delete pendingCommands[routerId];
  return cmds;
}

export function peek(routerId: string): number {
  return (pendingCommands[routerId] || []).length;
}
