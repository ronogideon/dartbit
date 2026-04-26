# Dartbit v1.1 — ISP Billing & MikroTik Management Platform

A full-stack, multi-tenant ISP management platform with MikroTik zero-touch provisioning,
subscriber management, billing, and a customer portal.

---

## Tech Stack

| Layer      | Technology                          |
|------------|-------------------------------------|
| Backend    | Node.js, Express, TypeScript        |
| ORM        | Prisma + PostgreSQL                 |
| Auth       | JWT                                 |
| Validation | Zod                                 |
| Frontend   | Next.js 14 (App Router)             |
| Styling    | TailwindCSS                         |
| Data       | TanStack React Query                |

---

## Local Development Setup

### Prerequisites
- Node.js 18+
- PostgreSQL running locally

### 1. Backend

```bash
cd backend
cp .env.example .env
# Edit .env — set DATABASE_URL to your PostgreSQL connection string
# Set BACKEND_URL to your LAN IP e.g. http://192.168.1.100:4000 (for MikroTik to reach you)
npm install
npx prisma migrate dev --name init
npm run seed
npm run dev
```

### 2. Frontend

```bash
cd frontend
cp .env.example .env.local
# Edit .env.local — set NEXT_PUBLIC_API_URL=http://localhost:4000
npm install --legacy-peer-deps
npm run dev
```

- Frontend: http://localhost:3000
- Backend: http://localhost:4000

---

## Railway Deployment

### Step 1 — Deploy Backend

1. Create a new Railway project
2. Add a **PostgreSQL** plugin — Railway sets `DATABASE_URL` automatically
3. Create a new service from your GitHub repo (or upload)
4. Set root directory to `backend`
5. Set these environment variables in Railway:

```
JWT_SECRET=your-secure-random-string
BACKEND_URL=https://your-backend.up.railway.app
FRONTEND_URL=https://your-frontend.up.railway.app
NODE_ENV=production
PORT=4000
```

6. Railway will auto-run `npm install` → `postinstall` (prisma generate) → `npm start`
7. After first deploy, open Railway shell and run:
```bash
npx prisma migrate deploy
npm run seed
```

### Step 2 — Deploy Frontend

1. Add a second service in the same Railway project
2. Set root directory to `frontend`
3. Set environment variables:
```
NEXT_PUBLIC_API_URL=https://your-backend.up.railway.app
```
4. Deploy

### Step 3 — Update BACKEND_URL for MikroTik

Once deployed, go to **Settings** in Dartbit and set Backend URL to your Railway backend URL.
This ensures the MikroTik bootstrap command uses the correct public URL.

---

## Default Credentials

| Role         | Email                      | Password       |
|--------------|----------------------------|----------------|
| Superadmin   | superadmin@dartbit.local   | SuperAdmin123! |
| Tenant Admin | admin@demoisp.com          | Test12345      |

---

## Pages

| Route            | Description                        |
|------------------|------------------------------------|
| `/auth/login`    | Admin login                        |
| `/dashboard`     | Main dashboard with stats          |
| `/active-users`  | Live online sessions (2s refresh)  |
| `/subscribers`   | Subscriber CRUD                    |
| `/packages`      | Package CRUD (PPPoE / Hotspot)     |
| `/payments`      | Payment recording (M-Pesa ready)   |
| `/messages`      | SMS/Email message log              |
| `/routers`       | MikroTik router management         |
| `/settings`      | Tenant configuration               |
| `/admin/tenants` | Superadmin tenant management       |
| `/customer`      | Customer self-service portal       |
| `/hotspot`       | Hotspot landing page               |

---

## MikroTik Integration

### Linking a Router

1. Go to **Routers** → **Link Router**
2. Enter a name and the router IP
3. Copy the **bootstrap command** shown after linking
4. Paste and run it in your MikroTik terminal

**Important:** Make sure `BACKEND_URL` in your `.env` is set to a URL
reachable by the router (LAN IP for local, Railway URL for production).

### What the ZTP Script Does
- Sends **heartbeat every 15 seconds** (CPU load, uptime, identity)
- Syncs **interfaces every 5 minutes**
- Router status turns **ONLINE** in the dashboard automatically

---

## Windows Installation Notes (Local Dev)

If you encounter SWC binary errors on Windows:

```cmd
cd frontend
rd /s /q node_modules
del package-lock.json
npm cache clean --force
npm install --legacy-peer-deps
npm run dev
```

Do NOT add a `.babelrc` file — it breaks the build.

---

## Changelog

### v1.1
- Fixed root page redirect (client-side instead of server redirect)
- Fixed dashboard layout double-render conflict
- Added `@babel/runtime` dependency to prevent missing module errors
- Removed `.babelrc` (was causing Babel/SWC conflicts)
- Updated `next.config.js` (clean, no experimental flags)
- Added `--legacy-peer-deps` to frontend Dockerfile for Railway
- Added `postinstall` script to backend for Railway prisma generate
- Improved `.env.example` files with Railway-specific instructions
- Added detailed Railway deployment guide to README
- Pinned Next.js to 14.2.35 (stable Windows SWC binary)

### v1.0
- Initial release

---

## v1.1.2 Changes

- **Railway URL**: Backend and frontend hardcoded to `https://dartbit-production.up.railway.app`
- **Collapsible Sidebar**: Click the collapse button at the bottom of the sidebar to toggle between full (256px) and icon-only (64px) modes
  - Smooth CSS transition animation
  - Tooltips appear on hover when collapsed
  - State persisted in localStorage across page refreshes
- **CORS**: Backend now explicitly allows `https://dartbit-production.up.railway.app`
- **AppLayout**: Updated to use flexbox spacer pattern so content area resizes correctly with sidebar

### Railway Environment Variables to Set

**Backend service:**
```
DATABASE_URL=<auto-set by Railway PostgreSQL plugin>
JWT_SECRET=your-secure-random-string-here
BACKEND_URL=https://dartbit-production.up.railway.app
FRONTEND_URL=https://dartbit-production.up.railway.app
NODE_ENV=production
PORT=4000
```

**Frontend service:**
```
NEXT_PUBLIC_API_URL=https://dartbit-production.up.railway.app
```
