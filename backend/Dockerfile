FROM node:20-alpine

RUN apk add --no-cache openssl openssl-dev libc6-compat

WORKDIR /app

COPY package*.json ./
COPY prisma ./prisma/
COPY tsconfig.json ./

RUN npm install

# Generate Prisma client with dummy URL at build time
RUN DATABASE_URL="postgresql://user:pass@localhost:5432/dummy" npx prisma generate

COPY src ./src/
RUN npm run build

EXPOSE 4000

# Run migrations then start — DATABASE_URL from Railway env is available here
CMD ["sh", "-c", "npx prisma migrate deploy --schema=./prisma/schema.prisma && node dist/index.js"]
