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

# Copy server source
COPY server/server.js ./
COPY server/public/ ./public/
COPY server/example_data/ ./example_data/

# Copy built igv.js dist from build stage
COPY --from=build /app/dist/ /app/dist/

EXPOSE 3000

# Default command — users override --variants and --data-dir at runtime
# Bind 0.0.0.0 inside container so Singularity port mapping works
ENTRYPOINT ["node", "server.js", "--host", "0.0.0.0"]
CMD ["--port", "3000"]
