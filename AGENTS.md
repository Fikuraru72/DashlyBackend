# DashlyBackend — Agent Instructions

Real-time event-tracking backend for the **Dashly** application. Built with NestJS, Drizzle ORM (PostgreSQL), Redis (ioredis), MQTT (EMQX), and Socket.IO WebSockets.

**Package manager:** `npm` (a `pnpm-lock.yaml` also exists — prefer npm for consistency with scripts).

---

## Commands

### Development
```bash
npm run start:dev          # Start with file-watching (hot reload)
npm run start:debug         # Start with debugger attached
```

### Build & Production
```bash
npm run build              # Compile TypeScript → dist/
npm run start:prod         # Run compiled output
```

### Linting & Formatting
```bash
vp check                    # Oxfmt + Oxlint + TypeScript checks
vp check --fix              # Apply safe formatting/lint fixes
vp fmt --write              # Format with Oxfmt
vp lint                     # Lint with Oxlint
```

### Testing
```bash
vp test                         # Run all unit tests (Vitest)
vp test watch                   # Watch mode
vp test --coverage              # Coverage report
vp test test/app.e2e-spec.ts    # HTTP smoke test

# Run a single test file
vp test src/modules/auth/auth.service.spec.ts

# Run tests matching a name pattern
vp test -t "should register"
```

### Database (Drizzle Kit)
```bash
npx drizzle-kit generate       # Generate migration SQL from schema changes
npx drizzle-kit migrate        # Apply pending migrations (use in production)
npx drizzle-kit push           # Push schema directly (dev only — skips migrations)
npx drizzle-kit studio         # Open Drizzle Studio browser UI
```

> ⚠️ Never use `drizzle-kit push` against a production database. Always use `generate` + `migrate`.

---

## Project Structure

```
src/
├── db/
│   ├── schema.ts            # All Drizzle table definitions
│   ├── database.module.ts   # Global DB provider (DB_CONNECTION token)
│   └── seed-*.ts            # Seed scripts (run with ts-node)
└── modules/
    ├── auth/                # JWT auth, guards, strategies, decorators
    ├── events/              # CRUD + join logic for events
    ├── tracking/
    │   ├── services/mqtt/   # MQTT subscriber (EMQX)
    │   ├── services/batch/  # Cron-based batch DB writer
    │   └── events/          # Socket.IO WebSocket gateway
    ├── redis/               # ioredis wrapper (geospatial + stats)
    └── analysis/            # Anomaly detection engine (Turf.js)
```

---

## Code Style

### TypeScript
- **Target:** ES2023, CommonJS module output
- `strictNullChecks: true`, `noImplicitAny: false` (enabled in tsconfig)
- Do not use `any`; define interfaces or use Drizzle-inferred types
- Use `!` non-null assertions only when you are certain the value exists (e.g., after explicit guards)
- Use `async/await`, never raw Promise chains

### Naming Conventions
| Artifact | Convention | Example |
|----------|-----------|---------|
| Classes | PascalCase | `AuthService` |
| Files | kebab-case | `auth.service.ts` |
| Variables/functions | camelCase | `createEvent()` |
| Constants (shared) | UPPER_SNAKE | `DB_CONNECTION` |
| DB columns | snake_case (via Drizzle mapping) | `created_at` → `createdAt` |
| MQTT topics | `dashly/events/{eventId}/p/{userId}/loc` | |

### Imports
- Use **relative imports** within a module: `../dto/create-event.dto`
- Use **relative imports** across modules from within `src/`: `../../db/database.module`
- Never traverse above `src/` and re-enter it (e.g., avoid `../../../../../src/`)
- Group imports: NestJS core → third-party → internal, one blank line between groups

### NestJS Patterns
- One module per feature folder; export only what is consumed by other modules
- Services handle all business logic — controllers only delegate
- Use `@Global()` sparingly (currently only `DatabaseModule` is global)
- Inject the DB via `@Inject(DB_CONNECTION)` with type `NodePgDatabase<typeof schema>`
- Lifecycle hooks: use `OnModuleInit` / `OnModuleDestroy` for connection setup/teardown

### DTOs & Validation
- All input DTOs must use `class-validator` decorators
- Optional fields must have `@IsOptional()` before type validators
- The global `ValidationPipe` enforces `whitelist: true, forbidNonWhitelisted: true`
- Use `@IsIn([...])` to constrain string enums at the DTO level

### Database Schema (Drizzle)
- Primary keys: `serial('id').primaryKey()`
- Foreign keys: `integer('x_id').references(() => table.id)` — **never** `serial()` for FKs
- Prefer `pgEnum` over `varchar` for columns with a fixed set of values
- Geographic coordinates: use `doublePrecision()`, not `varchar`
- Define `relations()` alongside the table they describe

### Error Handling
- Throw NestJS HTTP exceptions from services: `NotFoundException`, `ForbiddenException`, `ConflictException`, `UnauthorizedException`
- In lifecycle hooks and background processes (MQTT, batch cron), catch errors and log with `this.logger.error()`
- Never swallow errors silently — always log before returning/continuing

### Security
- **JWT_SECRET** must be set via environment variable; use `configService.getOrThrow()`
- All protected HTTP routes must have `@UseGuards(JwtAuthGuard, RolesGuard)`
- WebSocket connections must validate JWT from handshake `auth` header
- Use `crypto.randomBytes()` for any security-sensitive token generation, never `Math.random()`

### Environment Variables
| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | ✅ | PostgreSQL connection string |
| `JWT_SECRET` | ✅ | JWT signing secret |
| `REDIS_HOST` | ✅ | Redis hostname |
| `REDIS_PORT` | ✅ | Redis port (default 6379) |
| `MQTT_HOST` | ✅ | EMQX hostname |
| `MQTT_PORT` | ✅ | MQTT port (default 1883) |
| `PORT` | — | HTTP listen port (default 3000) |

Copy `.env.example` → `.env` and fill in all required values before starting.

---

## See Also
- [prd.json](./prd.json) — Structured code review with all 24 identified issues (5 critical, 5 high, 7 medium, 7 low)
- [prototype/](./prototype/) — Admin and participant simulation scripts for MVP testing
- [README.md](./README.md) — General project overview
