FROM node:18-alpine AS build

RUN apk add --no-cache git

WORKDIR /app

# Copy and build igv.js
COPY package.json ./
RUN npm install --ignore-scripts

COPY . .
RUN npm run build

# Production stage
FROM node:18-alpine

WORKDIR /app/server

# Copy server package and install deps
COPY server/package.json ./
RUN npm install --omit=dev

# Copy server source. The *.js glob covers new TOP-LEVEL modules automatically, but it
# stops there: every SUBDIRECTORY needs its own line below, and forgetting one leaves the
# image missing a module that resolves fine in the repo. That is not hypothetical — adding
# server/export/ and not adding it here is precisely how this build broke. The RUN guard at
# the end is what catches it, so keep them together: a new subdirectory means a new COPY.
COPY server/*.js ./
COPY server/export/ ./export/
COPY server/providers/ ./providers/
COPY server/data/ ./data/
COPY server/public/ ./public/
COPY server/example_data/ ./example_data/

# Copy built igv.js dist from build stage
COPY --from=build /app/dist/ /app/dist/

# Guard: fail the build now (not at container start) if server.js can't resolve
# every module it requires. server.js is safe to load here — it only calls
# app.listen() under `require.main === module`.
RUN node -e "require('./server.js')" && echo "server module graph OK"

EXPOSE 3000

# Raise the V8 heap limit above Node's ~4 GB default (large exports + species
# BED parsing can exceed it; hosts here have far more RAM). Overridable at
# runtime, e.g. Singularity --env NODE_OPTIONS="--max-old-space-size=16384".
ENV NODE_OPTIONS="--max-old-space-size=8192"

# Default command — users override --variants and --data-dir at runtime
# Bind 0.0.0.0 inside container so Singularity port mapping works
ENTRYPOINT ["node", "server.js", "--host", "0.0.0.0"]
CMD ["--port", "3000"]
