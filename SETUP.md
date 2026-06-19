# Dartbit — Local Setup Guide

## Prerequisites
- Node.js 18+
- PostgreSQL 14+ running locally

---

## 1 — Database

Create the database, then set the connection string in `backend/.env`:

```sql
CREATE DATABASE dartbit;
```
```env
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/dartbit"
# adjust user/password/host as needed
```

---

## 2 — Backend

```bash
cd backend
npm install                 # postinstall runs `prisma generate`
npx prisma migrate dev      # or: npx prisma db push  (applies the schema)
npm run seed                # creates the demo tenant + superadmin
npm run dev
```

Expected:
```
🚀 Dartbit backend running
   Local:   http://localhost:4000
   Health:  http://localhost:4000/health
```

Visit `http://localhost:4000/health` → `{"status":"ok"}`.

> **Note:** the backend applies idempotent schema patches on every boot (adds any new
> columns/tables if missing), so a freshly pulled build self-updates its database
> without a manual migration in most cases.

---

## 3 — Tenant dashboard

```bash
cd frontend
cp .env.example .env.local   # NEXT_PUBLIC_API_URL=http://localhost:4000
npm install --legacy-peer-deps
npm run dev                  # http://localhost:3000
```

## 4 — Superadmin console (optional, platform owner)

```bash
cd superadmin-frontend
cp .env.example .env.local   # NEXT_PUBLIC_API_URL=http://localhost:4000
npm install --legacy-peer-deps
npm run dev
```

---

## 5 — Login

| Role         | Email                       | Password       |
|--------------|-----------------------------|----------------|
| Tenant Admin | admin@demoisp.com           | Test12345      |
| Superadmin   | superadmin@dartbit.local    | SuperAdmin123! |

(Change these immediately for any non-local environment.)

---

## MikroTik ZTP on local dev

The router must reach your backend over the LAN:

1. Find your PC's LAN IP (`ipconfig` / `ip addr`).
2. Set `BACKEND_URL=http://YOUR_LAN_IP:4000` in `backend/.env`.
3. Allow port 4000 through the firewall, e.g. on Windows:
   ```cmd
   netsh advfirewall firewall add rule name="Dartbit" dir=in action=allow protocol=TCP localport=4000
   ```
4. Re-link the router in the UI to get a bootstrap command with the correct IP.

---

## Troubleshooting

**`Environment variable not found: DATABASE_URL`** — ensure `backend/.env` exists (not
just `.env.example`) and you're running from `backend/`.

**Frontend can't reach the backend** — confirm `frontend/.env.local` has
`NEXT_PUBLIC_API_URL=http://localhost:4000` and the backend is up on 4000.

**Seed failed** — make sure the database exists and the schema was applied
(`npx prisma db push`) before `npm run seed`.

**Type errors only on Railway, not locally** — the local Prisma client may be a stub;
the real `prisma generate` on Railway validates field/relation names. Run
`npx prisma generate` locally against the real schema to reproduce.
