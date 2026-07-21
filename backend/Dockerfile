FROM node:20-alpine AS builder
WORKDIR /app
# Toolchain for native modules (better-sqlite3, bcrypt) compiled by node-gyp.
RUN apk add --no-cache python3 make g++
COPY package*.json ./
# vendor/ must be present before npm ci: ntlm is a local dependency
# ("ntlm": "file:./vendor/ntlm", our AGPL replacement for the unlicensed package).
COPY vendor ./vendor
# langchain ecosystem has known peer-dependency conflicts → --legacy-peer-deps (as in CI).
RUN npm ci --legacy-peer-deps
COPY . .
RUN npm run build
# Strip devDependencies → production node_modules (native modules already compiled).
RUN npm prune --omit=dev --legacy-peer-deps

FROM node:20-alpine
WORKDIR /app
# pg_dump (+ tar) for the admin backup feature — must match the Postgres 16 server.
RUN apk add --no-cache postgresql16-client tar
# Reuse the production node_modules (with compiled native bindings) from the builder,
# so the runtime image needs no build toolchain and no recompilation.
COPY package*.json ./
COPY vendor ./vendor
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
RUN mkdir -p uploads/pdfs
# OpenSSL legacy provider: kept as a precaution for any legacy DES/MD4 path
# (the vendored pure-JS ntlm no longer requires it).
ENV NODE_OPTIONS=--openssl-legacy-provider
EXPOSE 3000
CMD ["node", "dist/main"]
