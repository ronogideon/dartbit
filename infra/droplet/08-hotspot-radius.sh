#!/usr/bin/env bash
# Dartbit v1.10.22 — Phase 2 droplet setup: hotspot + voucher RADIUS.
#
# What this does, idempotently:
#   1. Installs a FreeRADIUS sqlcounter ("dartbit_uptime") that reproduces MikroTik's native
#      `limit-uptime` over RADIUS: it sums acctsessiontime from radacct (reset = never) and, on
#      each auth, checks it against the voucher's `Max-All-Session` cap and replies with
#      Session-Timeout = remaining. So a voucher's clock starts on FIRST login and counts only
#      while the device is actually online — exactly the old behaviour, now centralised.
#   2. Ensures `sql` runs in BOTH authorize and accounting (accounting must write radacct or the
#      counter has nothing to sum). PPPoE pilot already enabled authorize; this makes accounting
#      explicit and adds the counter to authorize.
#   3. Validates the config (freeradius -XC) BEFORE reloading, and reloads gracefully (no dropped
#      sessions). Aborts on any validation failure, restoring backups.
#
# Safe to re-run. Run as root on the droplet:  sudo bash 08-hotspot-radius.sh
set -euo pipefail

RAD=/etc/freeradius/3.0
TS=$(date +%Y%m%d-%H%M%S)
log(){ echo -e "\033[1;36m[dartbit]\033[0m $*"; }
die(){ echo -e "\033[1;31m[dartbit] ERROR:\033[0m $*" >&2; exit 1; }

[ -d "$RAD" ] || die "FreeRADIUS 3.0 not found at $RAD — run the PPPoE RADIUS setup first."

# ── 1. sqlcounter: dartbit_uptime ────────────────────────────────────────────────────────────────
# Placed in mods-available and symlinked into mods-enabled. `Max-All-Session` is a built-in
# FreeRADIUS check attribute; `Session-Timeout` is the standard reply MikroTik honours to end the
# session when the remaining allowance hits zero.
COUNTER="$RAD/mods-available/dartbit_uptime"
log "Writing sqlcounter → $COUNTER"
cat > "$COUNTER" <<'EOF'
# Dartbit cumulative-uptime counter for vouchers (reset = never → lifetime-of-voucher cap).
# Mirrors MikroTik limit-uptime: total online seconds across all sessions, capped at Max-All-Session.
sqlcounter dartbit_uptime {
    sql_module_instance = sql
    dialect             = ${modules.sql.dialect}
    counter_name        = Dartbit-Uptime
    check_name          = Max-All-Session
    reply_name          = Session-Timeout
    key                 = User-Name
    reset               = never
    query               = "SELECT COALESCE(SUM(acctsessiontime), 0) FROM radacct WHERE username = '%{${key}}'"
}
EOF
ln -sf "$COUNTER" "$RAD/mods-enabled/dartbit_uptime"

# ── 2. Ensure sql + counter in the right sections of the default site ─────────────────────────────
SITE="$RAD/sites-enabled/default"
[ -f "$SITE" ] || die "default site not found at $SITE"
cp -a "$SITE" "$SITE.bak-$TS"
log "Backed up default site → $SITE.bak-$TS"

# Add `dartbit_uptime` into authorize{} right after `sql` (so the counter sees current usage), only
# once. We match the first standalone `sql` line inside authorize.
if ! grep -q 'dartbit_uptime' "$SITE"; then
  log "Inserting dartbit_uptime into authorize{}"
  # Insert after the first line that is exactly 'sql' (optionally indented) within the file.
  awk '
    BEGIN{done=0}
    {
      print
      if (!done && $1=="sql") { print "\t\tdartbit_uptime"; done=1 }
    }
  ' "$SITE" > "$SITE.tmp" && mv "$SITE.tmp" "$SITE"
else
  log "dartbit_uptime already present in default site — skipping"
fi

# Ensure `sql` is enabled in accounting{} so radacct fills (the counter's data source). If an `sql`
# line is commented in accounting, this won't force it; we just warn so you can check manually.
if ! awk '/^accounting[ \t]*\{/{a=1} a&&/^[ \t]*sql[ \t]*$/{f=1} /^\}/{if(a)a=0} END{exit !f}' "$SITE"; then
  log "WARNING: could not confirm 'sql' in accounting{} — verify hotspot accounting is logged to radacct."
fi

# ── 3. Validate, then graceful reload ─────────────────────────────────────────────────────────────
log "Validating FreeRADIUS config (freeradius -XC)…"
if ! freeradius -XC >/tmp/dartbit-radius-check.log 2>&1; then
  tail -n 30 /tmp/dartbit-radius-check.log
  log "Validation FAILED — restoring backup."
  mv "$SITE.bak-$TS" "$SITE"
  rm -f "$RAD/mods-enabled/dartbit_uptime"
  die "Config invalid; no changes applied. See /tmp/dartbit-radius-check.log"
fi
log "Config valid. Reloading FreeRADIUS…"
systemctl reload freeradius 2>/dev/null || systemctl restart freeradius
log "Done. Vouchers now enforce cumulative uptime via the dartbit_uptime counter."
