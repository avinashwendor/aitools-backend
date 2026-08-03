# Agent Instructions — Backend

See the workspace root `AGENTS.md` for full project rules. Backend-specific summary:

## Production API

**Base URL:** `https://aitools-backend-production.up.railway.app/api`

Health check: `GET /api/health`

## Repo & deploy

- Remote: `github.com:avinashwendor/aitools-backend.git`
- Push to `main` → Railway auto-deploys.
- After every change: push to GitHub, then curl `/api/health` on production.

## CORS

Production frontend origin must stay in `CORS_ORIGINS`:

`https://aitools-frontned-production.up.railway.app`

## Secrets

Never commit `.env` or `railway.backend.variables.json`.
