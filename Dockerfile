FROM oven/bun:1.3.9-slim

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN bun install

COPY . .
RUN bun run build

ENV NODE_ENV=production
EXPOSE 3000

CMD ["bun", "run", "start:prod"]
