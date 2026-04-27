FROM node:20-alpine

RUN apk add --no-cache openssl openssl-dev libc6-compat

WORKDIR /app

COPY package*.json ./
COPY prisma ./prisma/
COPY tsconfig.json ./

RUN npm install

# Dummy URL so prisma generate works at build time without a real DB
RUN DATABASE_URL="postgresql://user:pass@localhost:5432/dummy" npx prisma generate

COPY src ./src/

RUN npm run build

EXPOSE 4000

# At runtime Railway injects the real DATABASE_URL
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/index.js"]
