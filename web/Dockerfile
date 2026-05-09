# Multi-stage: install deps + build SPA, then run the server with tsx.
# Frontend lives at /app/public, server at /app/src/server, persistent state
# at /app/data (volume-mounted via docker-compose).

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json ./
# No lockfile yet — install fresh on every image build. Add a lockfile and
# switch to `npm ci` once the dependency set stabilises.
RUN npm install --no-audit --no-fund

FROM deps AS build
COPY . .
RUN npm run build:client

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/app/data
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/src ./src
COPY --from=build /app/public ./public
RUN mkdir -p /app/data
EXPOSE 3000
CMD ["npm", "run", "start"]
