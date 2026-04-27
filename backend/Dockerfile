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

# Run smart migration then start
CMD ["sh", "-c", "node dist/migrate.js && node dist/index.js"]
