FROM node:20-alpine

# Install OpenSSL and required libs for Prisma
RUN apk add --no-cache openssl openssl-dev libc6-compat

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY prisma ./prisma/

# Install all dependencies
RUN npm install

# Generate Prisma client explicitly (no postinstall)
RUN npx prisma generate

# Copy rest of source and build
COPY . .
RUN npm run build

EXPOSE 4000

# Migrate and start at runtime (DATABASE_URL available here)
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/index.js"]
