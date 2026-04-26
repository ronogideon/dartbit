FROM node:20-alpine

# Install OpenSSL - required by Prisma on Alpine Linux
RUN apk add --no-cache openssl openssl-dev libc6-compat

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci

# Copy prisma schema and generate client
COPY prisma ./prisma/
RUN npx prisma generate

# Copy source and build TypeScript
COPY . .
RUN npm run build

EXPOSE 4000

# At runtime: migrate then start (DATABASE_URL is available here from Railway env)
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/index.js"]
