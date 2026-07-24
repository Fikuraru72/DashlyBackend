# syntax=docker/dockerfile:1

FROM ghcr.io/voidzero-dev/vite-plus:0.2.4 AS build

WORKDIR /app
COPY --chown=vp:vp package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN vp install --frozen-lockfile
COPY --chown=vp:vp . .
RUN vp run build

FROM oven/bun:1.3.14-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production

# Keep the toolchain dependencies because the same image runs Drizzle migrations.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/src ./src
COPY --from=build /app/drizzle.config.ts /app/package.json ./

USER bun
EXPOSE 3000

CMD ["bun", "dist/src/main.js"]
