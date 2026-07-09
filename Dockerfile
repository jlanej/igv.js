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

# Copy server source. Glob all top-level modules (not an explicit list) so a
# newly added module can't be silently left out of the image.
COPY server/*.js ./
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
