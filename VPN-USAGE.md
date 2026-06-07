# Dartbit VPN — how to use it (v1.10.16)

The backend now auto-provisions a WireGuard VPN peer for each router and shows it in the UI.

## Connecting a router to the VPN
1. Routers page → router's ⋮ menu → **Manage VPN** → **Set up VPN**.
2. The backend assigns the router a VPN IP (10.8.0.11, .12, …), generates its keys, and registers
   the peer on the droplet automatically.
3. Copy the generated RouterOS config and run it once on the router (Winbox terminal or SSH).
4. The status turns **Connected** once the tunnel is up (handshake within ~3 min).

## Reaching a router via Winbox over the VPN
You need your computer on the same VPN as a peer (a one-time setup). Then Winbox to the router's
10.8.0.x address — no router keys needed at connect time, just the router's username/password.

### Add your laptop as a VPN peer (one-time, on the droplet)
```
# On the droplet, generate a key for your laptop:
wg genkey | tee laptop_priv.key | wg pubkey > laptop_pub.key
# Register it (use a reserved admin IP 10.8.0.2–10.8.0.10):
sudo dartbit-add-peer "$(cat laptop_pub.key)" "10.8.0.2/32" "admin-laptop"
```
Then on your laptop's WireGuard client, create a tunnel:
```
[Interface]
PrivateKey = <contents of laptop_priv.key>
Address = 10.8.0.2/32

[Peer]
PublicKey = 3NRQRHTseGumCRc1B+pR2qcwoLx3vifJemUNgrTCZGY=
Endpoint = vpn.dartbittech.com:51820
AllowedIPs = 10.8.0.0/24
PersistentKeepalive = 25
```
Activate it, then Winbox → `10.8.0.11` (the router's VPN IP).

## Notes
- The VPN carries management + (soon) RADIUS control traffic only — NOT customer internet.
- Router private keys are stored encrypted on the backend and only rendered inside the one-time
  setup config; they are never shown elsewhere in the tenant UI.
- Deleting a router removes its VPN peer from the droplet and frees its IP.
