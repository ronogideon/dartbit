# Dartbit — Remote Winbox access

Dartbit lets you open Winbox directly to any provisioned router **without installing a
VPN client on your computer**. The backend opens a temporary, dedicated public port on
the control droplet that forwards to the router over the management tunnel, provisions a
short-lived management login on the router, and shows you the address and credentials.
The access closes automatically after its window.

> This replaces the old "add your laptop as a WireGuard peer and Winbox over the VPN"
> flow. You no longer configure WireGuard on your machine.

---

## Using it (per router)

1. **Routers** → click a router tile → **Info** tab.
2. **Open Winbox access**.
3. Dartbit shows:
   - **Address** — `vpn.dartbittech.com:<port>` (a dedicated port in the 21000–21999 range)
   - **Username** / **Password** — a temporary `dartbit-mgr` login on the router
   - an **auto-close** time (the port and access tear down automatically)
4. Open Winbox, enter the address, username and password. Connect.
5. Done early? Use **Close access** to tear it down immediately.

Notes:
- The router must be **provisioned on the management tunnel** (have a tunnel IP). If it
  isn't, use **VPN setup & status** on the same Info tab first.
- The management login is created via the router's command queue, so the very first
  "Open Winbox access" needs the router online to apply — credentials are ready within a
  few seconds.

---

## One-time droplet setup (platform owner)

The forwarding helper must be installed on the control droplet once. Copy
`dartbit-winbox-port` to the droplet, then:

```bash
sudo install -m 0755 dartbit-winbox-port /usr/local/bin/dartbit-winbox-port
echo 'dartbit ALL=(root) NOPASSWD: /usr/local/bin/dartbit-winbox-port' | sudo tee /etc/sudoers.d/dartbit-winbox
sudo chmod 0440 /etc/sudoers.d/dartbit-winbox

# enable forwarding (persisted)
sudo sysctl -w net.ipv4.ip_forward=1
echo 'net.ipv4.ip_forward=1' | sudo tee /etc/sysctl.d/99-dartbit.conf

# open the port range inbound — BOTH layers if present:
sudo ufw allow 21000:21999/tcp               # UFW, if active
# DigitalOcean cloud firewall: add inbound TCP 21000-21999 from anywhere
```

Quick test (JJA's tunnel IP shown as an example):
```bash
sudo dartbit-winbox-port set 21001 10.8.0.12
sudo dartbit-winbox-port list
# Winbox to vpn.dartbittech.com:21001 should reach the router
sudo dartbit-winbox-port del 21001
```

---

## Security notes
- Each access uses a dedicated port and a temporary login, and closes automatically.
- The tunnel carries management/RADIUS control traffic only — never customer internet.
- Router credentials and keys are never exposed in the tenant UI outside the one-time
  provisioning config.
