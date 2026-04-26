# Dartbit — ISP Billing & MikroTik Management Platform

A full-stack, multi-tenant ISP management platform with MikroTik zero-touch provisioning, subscriber management, billing, and a customer portal.

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

## Quick Start

### Prerequisites
- Node.js 18+
- PostgreSQL (local or remote)

---

### 1. Clone & Install

```bash
# Backend
cd backend
cp .env.example .env
# Edit .env with your DATABASE_URL and other values
npm install

# Frontend
cd ../frontend
cp .env.example .env.local
npm install
```

### 2. Setup Database

```bash
cd backend
npx prisma migrate dev --name init
npm run seed
```

### 3. Run

```bash
# Terminal 1 — Backend
cd backend
npm run dev

# Terminal 2 — Frontend
cd frontend
npm run dev
```

- Frontend: http://localhost:3000
- Backend API: http://localhost:4000

---

## Default Credentials

| Role        | Email                      | Password       |
|-------------|----------------------------|----------------|
| Superadmin  | superadmin@dartbit.local   | SuperAdmin123! |
| Tenant Admin| admin@demoisp.com          | Test12345      |

---

## Pages

| Route           | Description                        |
|-----------------|------------------------------------|
| `/auth/login`   | Admin login                        |
| `/dashboard`    | Main dashboard with stats          |
| `/active-users` | Live online sessions (2s refresh)  |
| `/subscribers`  | Subscriber CRUD                    |
| `/packages`     | Package CRUD (PPPoE / Hotspot)     |
| `/payments`     | Payment recording (M-Pesa ready)   |
| `/messages`     | SMS/Email message log              |
| `/routers`      | MikroTik router management         |
| `/settings`     | Tenant configuration               |
| `/admin/tenants`| Superadmin tenant management       |
| `/customer`     | Customer self-service portal       |
| `/hotspot`      | Hotspot landing page               |

---

## MikroTik Integration

### Linking a Router

1. Go to **Routers** → **Link Router**
2. Enter a name and the router IP
3. Copy the **bootstrap command** shown after linking
4. Paste and run it in your MikroTik terminal

**Bootstrap Command Format:**
```
/tool fetch url="http://YOUR_BACKEND_URL/router/ztp-script?apiKey=..." dst-path=dartbit-ztp.rsc; /import file-name=dartbit-ztp.rsc
```

### What the ZTP Script Does
- Sends a **heartbeat every 15 seconds** (CPU, uptime, identity)
- Syncs **interface list every 5 minutes**
- Router appears as **ONLINE** in the dashboard automatically

---

## API Endpoints

### Auth
- `POST /auth/login` — Admin login
- `POST /auth/subscriber-login` — Customer portal login

### Subscribers
- `GET /subscribers` — List all
- `POST /subscribers` — Create
- `PUT /subscribers/:id` — Update
- `DELETE /subscribers/:id` — Delete

### Packages
- `GET /packages` — List all
- `POST /packages` — Create
- `PUT /packages/:id` — Update
- `DELETE /packages/:id` — Delete

### Payments
- `GET /payments` — List all
- `POST /payments` — Record (auto-extends expiry)
- `DELETE /payments/:id` — Delete

### MikroTik
- `POST /mikrotiks/link` — Link router
- `GET /router/ztp-script?apiKey=` — ZTP script download
- `POST /router/heartbeat` — Router heartbeat
- `POST /router/interfaces` — Interface sync

### Online Sessions
- `GET /online-sessions` — Live sessions
- `POST /online-sessions/sync` — Router reports active users

---

## Railway Deployment

1. Create two Railway services: one for backend, one for frontend
2. Add a PostgreSQL plugin to the backend service
3. Set environment variables:
   - Backend: `DATABASE_URL`, `JWT_SECRET`, `BACKEND_URL`, `FRONTEND_URL`
   - Frontend: `NEXT_PUBLIC_API_URL`
4. Deploy — Railway auto-detects Node.js and runs `npm start`

---

## Project Structure

```
dartbit/
├── backend/
│   ├── prisma/
│   │   └── schema.prisma
│   └── src/
│       ├── index.ts
│       ├── middleware/auth.ts
│       ├── routes/
│       │   ├── auth.ts
│       │   ├── subscribers.ts
│       │   ├── packages.ts
│       │   ├── payments.ts
│       │   ├── messages.ts
│       │   ├── routers.ts
│       │   ├── routerZtp.ts
│       │   ├── onlineSessions.ts
│       │   ├── tenants.ts
│       │   └── settings.ts
│       ├── utils/
│       │   ├── prisma.ts
│       │   ├── jwt.ts
│       │   └── response.ts
│       └── seed.ts
└── frontend/
    └── src/
        ├── app/
        │   ├── dashboard/
        │   ├── subscribers/
        │   ├── packages/
        │   ├── payments/
        │   ├── messages/
        │   ├── routers/
        │   ├── active-users/
        │   ├── settings/
        │   ├── admin/tenants/
        │   ├── customer/
        │   ├── hotspot/
        │   └── auth/login/
        ├── components/
        │   ├── layout/
        │   └── ui/
        └── lib/
            ├── api.ts
            └── auth.tsx
```
