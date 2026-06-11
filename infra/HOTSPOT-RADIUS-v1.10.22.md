# Dartbit v1.10.22 — Hotspot + Voucher RADIUS bring-up

This extends the proven PPPoE-over-RADIUS path (working on JJA) to **hotspot** and **vouchers**, and
retires the redundant per-router auth/expiry scripts on RADIUS-managed routers. Everything is gated
behind each router's `radiusEnabled` flag, so non-RADIUS routers are completely untouched.

## What changed in the backend

- **`utils/radius.ts`** — `syncSubscriberToRadius` now handles HOTSPOT as well as PPPoE. A hotspot
  subscriber gets two RADIUS identities: the **D-name** (`username` / 4-digit secret, for portal
  login) and the **device MAC** (`username = password = MAC`, for silent mac-auth). Both carry the
  same `Expiration` (fixed-window, from `expiresAt`) and `Mikrotik-Rate-Limit`. Added voucher
  functions (`syncVoucherToRadius`, `bulkSyncVouchersToRadius`, `removeVoucherFromRadius`) and a
  hotspot bulk migrator (`bulkSyncHotspotToRadius`). CoA-Disconnect now kicks every identity.
- **Vouchers** authenticate by code (`username = password = code`) and carry a `Max-All-Session`
  cap. Cumulative uptime (start-on-first-use, the same semantics as the old MikroTik `limit-uptime`)
  is enforced by the droplet-side **`dartbit_uptime` sqlcounter** — no backend polling. MPESA receipt
  vouchers are skipped (those devices already auth via the subscriber's MAC/D-name rows).
- **Redundant scripts disabled on RADIUS routers:**
  - `routes/routerZtp.ts` `/sync-script` — on a `radiusEnabled` router it stops generating the local
    PPPoE-secret / hotspot-user / voucher / MAC-user push, purges stale Dartbit-tagged hotspot &
    voucher users so they can't shadow RADIUS, and returns early. It still refreshes the cmd-poller
    interval and the captive-portal HTML.
  - `index.ts` 3-second expiry watcher — skips hotspot subscribers on `radiusEnabled` routers
    (RADIUS enforces expiry via `Expiration` + CoA).
  - `routes/mpesa.ts` M-Pesa provisioning — on a `radiusEnabled` router it writes RADIUS rows
    instead of creating local hotspot users, then fires the instant active-login go-ahead **after**
    the radcheck rows exist.
  - `routes/subscribers.ts` create/edit/delete and `routes/vouchers.ts` generate/delete — route to
    RADIUS on `radiusEnabled` routers and skip the local push.

PPPoE `/ppp secret` entries are intentionally left as-is (the parallel pilot arrangement); only
hotspot + voucher local entries are purged. Revisit PPPoE secret purging in a later version.

## Bring-up order (JJA)

1. **Droplet:** `sudo bash infra/droplet/08-hotspot-radius.sh`
   Installs the `dartbit_uptime` sqlcounter, ensures `sql` in authorize + accounting, validates with
   `freeradius -XC`, and reloads gracefully. Aborts (restoring backups) if validation fails.
2. **Deploy the backend** (Railway) at v1.10.22.
3. **Router JJA:** apply `infra/mikrotik/jja-hotspot-radius.rsc` — adds `hotspot` to the dartbit
   radius entry's service list and switches the hotspot profile to `use-radius=yes` with MAC
   auto-login, cookie, and accounting.
4. **Flip the flag:** set JJA `radiusEnabled = true` in Dartbit (this also (re)registers JJA as a
   FreeRADIUS client). The next sync-script run purges stale local hotspot/voucher users.
5. **Migrate existing data into RADIUS** (one-time):
   - `POST /mikrotiks/radius/bulk-sync-hotspot { "routerId": "<JJA id>" }`
   - `POST /mikrotiks/radius/bulk-sync-vouchers { "routerId": "<JJA id>" }`
   (PPPoE was already migrated via `POST /mikrotiks/radius/bulk-sync`.)

## Verify

- `GET /mikrotiks/radius/diagnose` → `radcheckCount` should jump after the bulk syncs.
- On the droplet: `radtest <voucher-code> <voucher-code> 127.0.0.1 0 testing123` (or watch
  `freeradius -X`) — a fresh voucher should `Access-Accept` with a `Session-Timeout`; once cumulative
  uptime exceeds the cap it should `Access-Reject`.
- Buy a hotspot package on JJA → the device should auto-login by MAC within a couple of seconds, and
  appear by its D-number on the active page (unchanged UX, now RADIUS-driven).
- Let a package expire → CoA-Disconnect should drop the session centrally (no 3-second watcher push).

## Rollback

Set JJA `radiusEnabled = false`. The sync-script immediately resumes generating local hotspot/voucher
users and the expiry watcher resumes; on the router, set the hotspot profile back to `use-radius=no`.
No data is lost — local users are rebuilt from the DB on the next sync.

## One design note

Voucher validity is **start-on-first-use** (cumulative online time), matching the previous
`limit-uptime` behaviour exactly. If you ever want **fixed-window** vouchers (expire at a wall-clock
time regardless of use), that's a different model — say the word and it's a small follow-up using the
existing `Expiration` path instead of the counter.
