// Instant walled-garden control — NO re-auth, NO reboot.
//
// Expired-but-enabled subscribers are confined to the Dartbit portal by the `dartbit-expired`
// firewall address-list (the DNS-allow / portal-allow / drop-rest rules are built in ZTP). We manage
// membership with STATIC address-list entries via the router command queue so they are ALWAYS
// removable — unlike the dynamic entries a RADIUS `Mikrotik-Address-List` reply creates at auth,
// which are owned by the live session and cannot be cleared without disconnecting it (the exact
// reason renewed users used to need a CPE reboot).
//
//   • WALL   → add the subscriber's live IP to dartbit-expired. The session STAYS UP; the firewall
//              confines it to the portal on the next packet. No disconnect.
//   • UNWALL → remove the entry AND flush that IP's connection tracking, so already-open sockets
//              recover in ~1s. No disconnect, no redial, no reboot.
//
// The framed IP is resolved ON THE ROUTER from /ppp active, so the backend never has to know it; a
// STATIC-service IP (which has no PPP session) is passed explicitly. Every script is idempotent — a
// WALL is a no-op if the address is already listed or the user is offline; an UNWALL is a no-op if
// nothing is listed.
import { enqueueCommand } from './commandQueue';

const LIST = 'dartbit-expired';

// Per-subscriber tag on entries we add, so an UNWALL can always find and clear them even if the
// subscriber's IP has since changed.
function tag(subscriberId: string): string {
  return `Dartbit-exp:${subscriberId}`;
}

// Confine a subscriber: add a STATIC dartbit-expired entry for their current IP. Resolves the live
// PPPoE framed IP on the router; also handles an explicit STATIC IP. Never disconnects.
export function wallScript(username: string, subscriberId: string, staticIp?: string | null): string {
  const t = tag(subscriberId);
  const lines: string[] = [
    `:foreach a in=[/ppp active find name="${username}"] do={ :local ip [/ppp active get $a address]; ` +
      `:if ([:len [/ip firewall address-list find list=${LIST} address=$ip]]=0) do={ ` +
      `/ip firewall address-list add list=${LIST} address=$ip comment="${t}" } }`,
  ];
  if (staticIp) {
    lines.push(
      `:if ([:len [/ip firewall address-list find list=${LIST} address=${staticIp}]]=0) do={ ` +
        `/ip firewall address-list add list=${LIST} address=${staticIp} comment="${t}" }`,
    );
  }
  return lines.join('\n');
}

// Release a subscriber WITHOUT a disconnect: remove their dartbit-expired entry (matched by live IP,
// static IP, and subscriber tag as a backstop) and FLUSH that IP's conntrack so live connections
// recover immediately. This is what makes a renewal take effect in ~1s instead of needing a reboot.
export function unwallScript(username: string, subscriberId: string, staticIp?: string | null): string {
  const t = tag(subscriberId);
  const lines: string[] = [
    // Backstop: clear any entry we ever tagged for this subscriber (covers an IP change).
    `:foreach e in=[/ip firewall address-list find list=${LIST} comment="${t}"] do={ /ip firewall address-list remove $e }`,
    // Resolve the live PPPoE IP → drop its entry + flush its connection tracking.
    `:foreach a in=[/ppp active find name="${username}"] do={ :local ip [/ppp active get $a address]; ` +
      `:foreach e in=[/ip firewall address-list find list=${LIST} address=$ip] do={ /ip firewall address-list remove $e }; ` +
      `:foreach c in=[/ip firewall connection find src-address~$ip] do={ /ip firewall connection remove $c } }`,
  ];
  if (staticIp) {
    lines.push(`:foreach e in=[/ip firewall address-list find list=${LIST} address=${staticIp}] do={ /ip firewall address-list remove $e }`);
    lines.push(`:foreach c in=[/ip firewall connection find src-address~"${staticIp}"] do={ /ip firewall connection remove $c }`);
  }
  return lines.join('\n');
}

export async function enqueueWall(routerId: string, username: string, subscriberId: string, staticIp?: string | null): Promise<void> {
  await enqueueCommand(routerId, wallScript(username, subscriberId, staticIp));
}

export async function enqueueUnwall(routerId: string, username: string, subscriberId: string, staticIp?: string | null): Promise<void> {
  await enqueueCommand(routerId, unwallScript(username, subscriberId, staticIp));
}
