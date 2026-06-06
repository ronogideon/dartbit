// Builds the exact RouterOS commands for ONE hotspot subscriber's current state and pushes them to
// the router's command queue for immediate application (the dartbit-cmd poller runs every ~5s),
// rather than waiting for the 60s full sync. Used on create/extend/delete/expiry so backend changes
// reflect on the router almost instantly. The 60s sync remains the safety-net reconciler.
import prisma from './prisma';
import { enqueueCommand } from './commandQueue';

interface HsSubLike {
  id: string;
  username: string;
  secret: string;
  macAddress?: string | null;
  isActive: boolean;
  expiresAt?: Date | null;
  packageId?: string | null;
  service: string;
  routerId?: string | null;
  package?: { id: string; speedUpKbps: number; speedDownKbps: number } | null;
}

// Returns the RouterOS command lines to bring this hotspot subscriber's router entries in line with
// its current entitlement. Entitled → ensure D-name + MAC users. Not entitled → remove them + kick.
export function buildHotspotSubCommands(sub: HsSubLike): string[] {
  const lines: string[] = [];
  if (sub.service !== 'HOTSPOT') return lines;
  const now = new Date();
  const expired = sub.expiresAt ? sub.expiresAt <= now : false;
  const entitled = sub.isActive && !!sub.packageId && !expired;
  const macU = sub.macAddress ? sub.macAddress.toUpperCase() : '';
  const profileName = sub.package ? `db-h-${sub.package.id.substring(0, 8)}` : 'dartbit-default';
  const speed = sub.package ? `${sub.package.speedUpKbps}k/${sub.package.speedDownKbps}k` : '5M/5M';
  const macBind = macU ? ` mac-address=${macU}` : '';

  if (!entitled) {
    lines.push(`:foreach u in=[/ip hotspot user find name="${sub.username}"] do={ /ip hotspot user remove $u }`);
    lines.push(`:foreach a in=[/ip hotspot active find user="${sub.username}"] do={ /ip hotspot active remove $a }`);
    if (macU) {
      lines.push(`:foreach u in=[/ip hotspot user find name="${macU}"] do={ /ip hotspot user remove $u }`);
      lines.push(`:foreach a in=[/ip hotspot active find mac-address="${macU}"] do={ /ip hotspot active remove $a }`);
      lines.push(`:foreach c in=[/ip hotspot cookie find mac-address="${macU}"] do={ /ip hotspot cookie remove $c }`);
      lines.push(`:foreach h in=[/ip hotspot host find mac-address="${macU}"] do={ /ip hotspot host remove $h }`);
    }
    return lines;
  }

  lines.push(`:if ([:len [/ip hotspot user profile find name="${profileName}"]] = 0) do={ /ip hotspot user profile add name=${profileName} address-pool=dhcp-pool }`);
  lines.push(`/ip hotspot user profile set [find name="${profileName}"] rate-limit="${speed}" shared-users=1 add-mac-cookie=no address-pool=dhcp-pool`);
  lines.push(`:if ([:len [/ip hotspot user find name="${sub.username}"]] = 0) do={ /ip hotspot user add name="${sub.username}" password="${sub.secret}" profile=${profileName}${macBind} comment="Dartbit:${sub.id}" }`);
  lines.push(`:if ([:len [/ip hotspot user find name="${sub.username}"]] > 0) do={ /ip hotspot user set [find name="${sub.username}"] password="${sub.secret}" profile=${profileName} disabled=no${macBind} }`);
  if (macU) {
    lines.push(`:if ([:len [/ip hotspot user find name="${macU}"]] = 0) do={ /ip hotspot user add name="${macU}" password=dartbit mac-address=${macU} profile=${profileName} comment="DbMac:${sub.id}" }`);
    lines.push(`:if ([:len [/ip hotspot user find name="${macU}"]] > 0) do={ /ip hotspot user set [find name="${macU}"] password=dartbit mac-address=${macU} profile=${profileName} disabled=no }`);
  }
  return lines;
}

// Fetch a subscriber by id and push its current-state commands to its router immediately.
export async function pushSubscriberToRouter(subscriberId: string): Promise<void> {
  try {
    const sub = await prisma.subscriber.findUnique({
      where: { id: subscriberId },
      include: { package: true },
    });
    if (!sub || !sub.routerId) return;
    const cmds = buildHotspotSubCommands(sub as unknown as HsSubLike);
    if (cmds.length) await enqueueCommand(sub.routerId, cmds.join('\n'));
  } catch (e) {
    console.error('[push] pushSubscriberToRouter failed:', e instanceof Error ? e.message : e);
  }
}

// Push removal commands for a subscriber that's about to be / has been deleted (we may no longer be
// able to read it from the DB, so the caller passes the known fields).
export async function pushSubscriberRemoval(routerId: string, username: string, macAddress?: string | null): Promise<void> {
  try {
    const lines: string[] = [];
    lines.push(`:foreach u in=[/ip hotspot user find name="${username}"] do={ /ip hotspot user remove $u }`);
    lines.push(`:foreach a in=[/ip hotspot active find user="${username}"] do={ /ip hotspot active remove $a }`);
    lines.push(`:foreach s in=[/ppp secret find name="${username}"] do={ /ppp secret remove $s }`);
    lines.push(`:foreach a in=[/ppp active find name="${username}"] do={ /ppp active remove $a }`);
    if (macAddress) {
      const macU = macAddress.toUpperCase();
      lines.push(`:foreach u in=[/ip hotspot user find name="${macU}"] do={ /ip hotspot user remove $u }`);
      lines.push(`:foreach a in=[/ip hotspot active find mac-address="${macU}"] do={ /ip hotspot active remove $a }`);
      lines.push(`:foreach c in=[/ip hotspot cookie find mac-address="${macU}"] do={ /ip hotspot cookie remove $c }`);
      lines.push(`:foreach h in=[/ip hotspot host find mac-address="${macU}"] do={ /ip hotspot host remove $h }`);
    }
    await enqueueCommand(routerId, lines.join('\n'));
  } catch (e) {
    console.error('[push] pushSubscriberRemoval failed:', e instanceof Error ? e.message : e);
  }
}
