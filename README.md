# Dartbit — ISP Billing & MikroTik Management Platform

Multi-tenant ISP management for WISPs and hotspot operators: MikroTik zero-touch
provisioning, PPPoE / Hotspot / Static subscriber management, M-Pesa billing, SMS
notifications, vouchers, RADIUS authentication, and a branded customer portal.

---

## Architecture

Dartbit is three deployable apps plus a control droplet:

| Component            | Stack                                         | Hosting (typical)        |
|----------------------|-----------------------------------------------|--------------------------|
| Backend API          | Node.js, Express, TypeScript, Prisma, Postgres| Railway                  |
| Tenant dashboard     | Next.js 14 (App Router), Tailwind, React Query| Railway (separate service)|
| Superadmin console   | Next.js 14                                    | Railway (separate service)|
| Control droplet      | FreeRADIUS + WireGuard + Postgres on Ubuntu   | DigitalOcean             |

The **control droplet** (`vpn.dartbittech.com`) runs FreeRADIUS for subscriber
authentication and a WireGuard tunnel that carries *management* traffic only — used
for RADIUS control and the one-tap **Remote Winbox** feature. It never carries
customer internet traffic.

> The three apps deploy **independently**. Updating the backend does not rebuild the
> dashboard or superadmin console — deploy each from its own folder.

---

## Core features

- **Zero-touch provisioning (ZTP):** link a router, run one bootstrap command, and the
  router self-configures (hotspot, PPPoE, profiles, portal HTML) and reports heartbeat.
- **Services:** PPPoE, Hotspot, and Static IP, across multiple routers per tenant.
- **Packages:** speed/validity/price plans, optionally **scoped to specific routers**
  (default: offered on all routers).
- **Billing:** M-Pesa (Daraja STK push) with automatic provisioning on payment.
- **Vouchers:** package-driven generation; redeem via the portal.
- **RADIUS auth:** FreeRADIUS on the droplet owns PPPoE/Hotspot authentication; expiry
  is enforced server-side.
- **SMS notifications:** pre-expiry reminders and at-expiry notices (per-tenant or shared
  gateway), plus payment receipts.
- **Remote Winbox:** open a temporary, secured port to any router's Winbox from the
  dashboard — no VPN client needed on your computer. See `WINBOX-USAGE.md`.
- **Customer portal:** branded self-service for balance, expiry (traffic-light status),
  and renewal.

---

## Local development

### Prerequisites
- Node.js 18+
- PostgreSQL 14+

### Backend
```bash
cd backend
cp .env.example .env          # set DATABASE_URL, JWT_SECRET, BACKEND_URL
npm install                   # runs prisma generate via postinstall
npx prisma migrate dev        # or: npx prisma db push
npm run seed
npm run dev                   # http://localhost:4000  (health: /health)
```

### Tenant dashboard
```bash
cd frontend
cp .env.example .env.local    # NEXT_PUBLIC_API_URL=http://localhost:4000
npm install --legacy-peer-deps
npm run dev                   # http://localhost:3000
```

### Superadmin console
```bash
cd superadmin-frontend
cp .env.example .env.local    # NEXT_PUBLIC_API_URL=http://localhost:4000
npm install --legacy-peer-deps
npm run dev
```

See `SETUP.md` for a step-by-step local guide and troubleshooting.

---

## Deployment (Railway)

Deploy **three services** in one project, sharing a PostgreSQL plugin:

1. **Backend** — root `backend/`. Env: `DATABASE_URL` (from the Postgres plugin),
   `JWT_SECRET`, `BACKEND_URL`, `FRONTEND_URL`, `NODE_ENV=production`, `PORT=4000`,
   plus M-Pesa and SMS gateway credentials. Schema is applied automatically on boot
   (idempotent column patches); no manual migration step required.
2. **Tenant dashboard** — root `frontend/`. Env: `NEXT_PUBLIC_API_URL=<backend URL>`.
3. **Superadmin console** — root `superadmin-frontend/`. Env: `NEXT_PUBLIC_API_URL=<backend URL>`.

After deploy, set the **Backend URL** in Settings so router bootstrap commands use the
correct public URL.

The control droplet is provisioned separately (FreeRADIUS + WireGuard) and is **not**
touched by app deploys.

---

## MikroTik integration

### Linking a router
1. **Routers → Link Router**, enter a name.
2. Copy the **bootstrap command** and run it once in the router's terminal (Winbox/SSH).
3. The router self-provisions and turns **ONLINE** in the dashboard.

### Remote Winbox
From a router's detail page (Info tab) → **Open Winbox access**. The backend opens a
temporary port on the droplet, provisions a management login, and shows you the
address + credentials with an auto-close timer. Full details and the one-time droplet
helper install are in `WINBOX-USAGE.md`.

---

## Repository layout

```
backend/             Express + Prisma API, ZTP, RADIUS control, M-Pesa, SMS
frontend/            Tenant dashboard (Next.js)
superadmin-frontend/ Platform/superadmin console (Next.js)
README.md            This file
SETUP.md             Local setup & troubleshooting
WINBOX-USAGE.md      Remote Winbox access (replaces the old VPN flow)
```
