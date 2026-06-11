# Dartbit v1.10.22 — JJA hotspot over RADIUS
# Apply on router JJA (RB3011, RouterOS 7.x). Paste into a terminal or import as .rsc.
#
# Prereqs already in place from the PPPoE pilot:
#   - WireGuard up; JJA's Dartbit VPN IP = 10.8.0.12
#   - A /radius entry pointing at the droplet (10.8.0.1) with the shared secret, called-id=dartbit,
#     and src-address=10.8.0.12  (this is what made PPPoE work)
#   - JJA registered as a STATIC client in the droplet's clients.conf
#
# This script (a) adds `hotspot` to that radius entry's service list and (b) switches the hotspot
# server profile to authenticate against RADIUS, with MAC auto-login + accounting (so the voucher
# uptime counter has data). It does NOT remove local users — the v1.10.22 sync-script purges stale
# Dartbit hotspot/voucher users automatically once this router is flagged radiusEnabled in Dartbit.

:put "Dartbit: enabling hotspot RADIUS on JJA…"

# 1) Extend the Dartbit RADIUS entry to serve hotspot as well as ppp. Matches the entry by its
#    called-id=dartbit so we don't touch any coexisting (e.g. centipid) radius server.
:foreach r in=[/radius find where called-id="dartbit"] do={
    /radius set $r service=ppp,hotspot
    :put "  • radius entry updated → service=ppp,hotspot (src-address must be 10.8.0.12)"
}
# Safety: if no called-id=dartbit entry was found, do nothing and warn (avoid editing the wrong server).
:if ([:len [/radius find where called-id="dartbit"]] = 0) do={
    :put "  ! No radius entry with called-id=dartbit found — add it first (PPPoE pilot config)."
}

# 2) Point the hotspot server profile(s) at RADIUS.
#    - use-radius=yes            → auth against FreeRADIUS (radcheck)
#    - login-by=mac,cookie,http-chap,http-pap → silent MAC auto-login for paid devices + voucher
#      code login via the portal; cookie lets a returning device resume without re-auth
#    - accounting + interim-update → radacct fills, which the dartbit_uptime counter sums for vouchers
#    - mac-auth-mode=as-username → RouterOS sends User-Name = MAC (Dartbit stores radcheck by MAC)
:foreach p in=[/ip hotspot profile find] do={
    /ip hotspot profile set $p use-radius=yes login-by=mac,cookie,http-chap,http-pap \
        radius-accounting=yes radius-interim-update=5m radius-mac-format=XX:XX:XX:XX:XX:XX \
        radius-default-domain="dartbit"
    :put ("  • hotspot profile RADIUS-enabled: " . [/ip hotspot profile get $p name])
}

:put "Dartbit: hotspot RADIUS enabled. Now set this router to radiusEnabled in Dartbit and run the"
:put "         hotspot + voucher bulk-sync so existing customers/codes are written to FreeRADIUS."
