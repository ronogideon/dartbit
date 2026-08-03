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

// A blank/whitespace username would render as `/ppp active find name=""`, which must never be emitted
// — it can behave as an unfiltered match on the router and touch every session. Callers pass a real
// PPPoE username; anything else yields a no-op script.
function safeUser(username: string): string | null {
  const u = (username || '').trim();
  return u.length ? u : null;
}

// Confine a subscriber: add a STATIC dartbit-expired entry for their current IP. Resolves the live
// PPPoE framed IP on the router; also handles an explicit STATIC IP. Never disconnects.
export function wallScript(username: string, subscriberId: string, staticIp?: string | null): string {
  const user = safeUser(username);
  if (!user && !staticIp) return '';
  const t = tag(subscriberId);
  const lines: string[] = [];
  if (user) {
    lines.push(
      `:foreach a in=[/ppp active find name="${user}"] do={ :local ip [/ppp active get $a address]; ` +
        `:if ([:len [/ip firewall address-list find list=${LIST} address=$ip]]=0) do={ ` +
        `/ip firewall address-list add list=${LIST} address=$ip comment="${t}" } }`,
    );
  }
  if (staticIp) {
    lines.push(
      `:if ([:len [/ip firewall address-list find list=${LIST} address=${staticIp}]]=0) do={ ` +
        `/ip firewall address-list add list=${LIST} address=${staticIp} comment="${t}" }`,
    );
  }
  return lines.join('\n');
}

// Release a subscriber WITHOUT a manual reboot. In order:
//   1. remove our STATIC dartbit-expired entries for their IP (removable) + flush that IP's conntrack
//      → a session blocked the new way recovers in ~1s with ZERO interruption.
//   2. if a DYNAMIC entry STILL blocks the IP — legacy residue from the old profile/RADIUS-reply model
//      that cannot be removed on a live session — force ONE automatic redial: the CPE reconnects in
//      ~3s and re-auths onto the now-entitled RADIUS state (written before this runs). Still no manual
//      reboot. New-model blocks are always static, so this redial only fires while migrating sessions
//      that were walled before this version shipped.
// All removes use `!dynamic` (dynamic entries can't be removed and would abort the script) and are
// wrapped in :do/on-error for total robustness.
export function unwallScript(username: string, subscriberId: string, staticIp?: string | null): string {
  const user = safeUser(username);
  if (!user && !staticIp) return '';
  const t = tag(subscriberId);
  const lines: string[] = [
    // Backstop: clear any STATIC entry we ever tagged for this subscriber (covers an IP change).
    `:do { /ip firewall address-list remove [find list=${LIST} comment="${t}" !dynamic] } on-error={}`,
  ];
  if (user) {
    lines.push(
      // Resolve the live PPPoE IP. Only act if the IP is ACTUALLY in dartbit-expired — so calling
      // unwall on an already-entitled (never-walled) user is a true no-op and never blips their
      // session. If it WAS walled: remove the static entry, flush conntrack, and DROP the session so
      // it re-auths against the now-entitled RADIUS state (one-session-per-host makes the redial clean).
      `:foreach a in=[/ppp active find name="${user}"] do={ :local ip [/ppp active get $a address]; ` +
        `:if ([:len [/ip firewall address-list find list=${LIST} address=$ip]] > 0) do={ ` +
          `:do { /ip firewall address-list remove [find list=${LIST} address=$ip !dynamic] } on-error={}; ` +
          `:foreach c in=[/ip firewall connection find src-address~$ip] do={ /ip firewall connection remove $c }; ` +
          `/ppp active remove $a } }`,
    );
  }
  if (staticIp) {
    lines.push(
      `:if ([:len [/ip firewall address-list find list=${LIST} address=${staticIp}]] > 0) do={ ` +
        `:do { /ip firewall address-list remove [find list=${LIST} address=${staticIp} !dynamic] } on-error={}; ` +
        `:foreach c in=[/ip firewall connection find src-address~"${staticIp}"] do={ /ip firewall connection remove $c } }`,
    );
  }
  return lines.join('\n');
}

export async function enqueueWall(routerId: string, username: string, subscriberId: string, staticIp?: string | null): Promise<void> {
  await enqueueCommand(routerId, wallScript(username, subscriberId, staticIp));
}

export async function enqueueUnwall(routerId: string, username: string, subscriberId: string, staticIp?: string | null): Promise<void> {
  await enqueueCommand(routerId, unwallScript(username, subscriberId, staticIp));
}

// Force a clean re-auth: unconditionally drop the user's live PPPoE session so the CPE redials and
// re-authenticates against the (already-updated) entitled RADIUS state. Used on payment/renewal of a
// previously-lapsed user — the old session authenticated into the walled state and keeps running
// under it until it re-auths, so clearing the address-list alone isn't enough. With
// one-session-per-host=yes the redial replaces cleanly. This does NOT depend on detecting the walled
// state on the router — the caller only fires it when the user was actually expired, so a healthy
// early renewal is never interrupted.
export function reauthScript(username: string): string {
  const user = safeUser(username);
  if (!user) return '';
  return `:foreach a in=[/ppp active find name="${user}"] do={ /ppp active remove $a }`;
}

export async function enqueueReauth(routerId: string, username: string): Promise<void> {
  await enqueueCommand(routerId, reauthScript(username));
}
