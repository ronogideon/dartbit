# Dartbit v1.1.4 — Local Setup Guide

## Prerequisites
- Node.js 18+
- PostgreSQL running locally (any version)

---

## Step 1 — Configure the database

Open `backend/.env` and update the `DATABASE_URL` to match your PostgreSQL setup:

```env
# Default (works if postgres user has no password):
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/dartbit"

# If your postgres has a different password:
DATABASE_URL="postgresql://postgres:YOUR_PASSWORD@localhost:5432/dartbit"

# If you use a different username:
DATABASE_URL="postgresql://YOUR_USER:YOUR_PASSWORD@localhost:5432/dartbit"
```

Create the database first if it doesn't exist:
```sql
-- In psql or pgAdmin:
CREATE DATABASE dartbit;
```

---

## Step 2 — Run the backend

```cmd
cd backend
npm install
npx prisma migrate dev --name init
npm run seed
npm run dev
```

You should see:
```
🚀 Dartbit v1.1.4 backend running
   Local:   http://localhost:4000
   Health:  http://localhost:4000/health
   DB:      ✓ DATABASE_URL set
```

Visit http://localhost:4000 — you should see the API info page.
Visit http://localhost:4000/health — you should see {"status":"ok"}.

---

## Step 3 — Run the frontend

```cmd
cd frontend
npm install --legacy-peer-deps
npm run dev
```

Visit http://localhost:3000 — you will be redirected to the login page.

---

## Step 4 — Login

Click one of the **Quick Login** buttons on the login page, or type:

| Role         | Email                       | Password       |
|--------------|-----------------------------|----------------|
| Tenant Admin | admin@demoisp.com           | Test12345      |
| Superadmin   | superadmin@dartbit.local    | SuperAdmin123! |

---

## Troubleshooting

### "Environment variable not found: DATABASE_URL"
- Make sure `backend/.env` exists (not just `.env.example`)
- Make sure `DATABASE_URL` is set correctly in it
- Run `npm run dev` from the `backend/` folder, not the root

### "Cannot GET /"
- Old version issue — fixed in v1.1.4. The root route now returns API info.

### Seed failed
- Make sure the database exists and migrations ran first:
  ```cmd
  npx prisma migrate dev --name init
  npm run seed
  ```

### Frontend can't connect to backend
- Make sure `frontend/.env.local` has: `NEXT_PUBLIC_API_URL=http://localhost:4000`
- Make sure the backend is running on port 4000

### For MikroTik ZTP (local dev)
- Find your PC's LAN IP: run `ipconfig` in CMD
- Update `backend/.env`: `BACKEND_URL=http://YOUR_LAN_IP:4000`
- Allow port 4000 in Windows Firewall:
  ```cmd
  netsh advfirewall firewall add rule name="Dartbit" dir=in action=allow protocol=TCP localport=4000
  ```
- Delete and re-link the router in the UI to get a new bootstrap command with the correct IP
