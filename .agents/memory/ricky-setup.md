---
name: Ricky project setup
description: XAU/USD trading bot — architecture, stack, and key env vars
---

## Architecture
- `artifacts/ricky` — React + Vite dashboard at `/`, uses tRPC client + superjson to call the API
- `artifacts/api-server` — Express 5 + tRPC server at `/api/trpc`, runs Telegram bot loops on startup
- `lib/db` — Drizzle ORM schema: signals, activeSetups, activeTrades, telegramLog, users

## Telegram bot
- Starts automatically when TELEGRAM_TOKEN is set (in `src/index.ts`)
- Three loops: 1-minute auto-scan, 5-second trade monitoring, and 15-second Telegram polling
- TELEGRAM_TOKEN and TELEGRAM_CHAT_ID are set as shared environment variables
- TWELVE_DATA_API_KEY is stored as a secret for 30M, 5M, and 1H candle data

## Key packages
- Frontend: @trpc/client, @trpc/react-query, superjson, wouter, sonner, @tanstack/react-query
- Backend: @trpc/server, superjson, express, drizzle-orm, pino

**Why:** tRPC replaces the OpenAPI/codegen flow for this project — the frontend calls /api/trpc directly.
**How to apply:** When adding new backend procedures, add to artifacts/api-server/src/bot/router.ts under botRouter. When adding frontend data fetching, use trpc.bot.<procedure>.useQuery().
