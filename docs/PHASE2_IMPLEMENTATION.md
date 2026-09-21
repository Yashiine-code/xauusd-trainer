# Phase 2 implementation status

Phase 2 is staged behind `PHASE2_ENABLED=true`. The default remains false so the
already accepted V1 market path stays usable until the database migration and
Auth credentials have been verified together. Enabling the flag without the
prerequisites intentionally fails closed.

## Activation prerequisites

1. Back up the target PostgreSQL database and inspect existing rows in
   `users`, `training_sessions`, and `trades`.
2. Apply tracked migrations `0002` through `0004` with `npm run db:migrate` in an
   environment with `DATABASE_URL`. The migration retains legacy trades under
   `training_session_id`; they have no product `session_id` until separately
   reconciled. Never overwrite their ownership heuristically.
3. Configure `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` (or the legacy
   `SUPABASE_ANON_KEY`), and server-only `DATABASE_URL`. The market-data
   `SUPABASE_SERVICE_ROLE_KEY` remains server-only and is not used as an Auth
   publishable key.
4. Verify email confirmation and sign-in with a disposable test account. New
   users have `access_status='active'` and can enter immediately after email
   verification; `suspended` users cannot create, resume or operate sessions.
   Migration `0004` converts historical `pending`/`approved` profiles to
   `active` and preserves `suspended`. There is no manual whitelist flow.
5. Exercise Risk Training and Challenge through create, trade, reload/resume,
   and end on a staging database. Compare persisted balance, statistics,
   position, and trade rows with the UI. Test duplicate settlement requests,
   rollback on injected failure, and cross-user access denial.
6. Run `npm test`, `npm run lint`, `npx tsc --noEmit`, `npm run build`,
   `scripts/verify_v1_performance.mjs`, and `scripts/verify_v1_modes.mjs`
   against the staging deployment with the flag enabled. Only then enable it
   in production.

## Data boundaries

- `sessions.session_id` is the product run ID and the resume key.
- `training_sessions.session_id` is the current question/market child ID.
- Trade insertion and product balance/statistics/position/phase updates share
  one PostgreSQL transaction. `operation_id` is unique for retry safety.
- A hidden result is stored only in the child row and is omitted from resume
  responses until the child reaches `RESULT` or `REVIEW`.
- Progress checkpoints run at most every 30 seconds. Market buffer refills
  also save an at-most-30-second checkpoint of authorization state. No writes
  occur for an individual click, 1m candle, animation frame, timeframe switch,
  or chart render.
- The market-data Supabase HTTP adapter and the 1m execution engine were not
  modified for Phase 2.

## Known verification gap

The Phase 2 schema migrations have been applied to the current test database.
Supabase email-delivery rate limiting still prevents an independently completed
email signup/confirmation acceptance. An enabled-state remote Risk settlement
request has also timed out. Do not turn on the feature flag permanently or
claim Phase 2 production acceptance until those checks and the enabled-state
performance comparison pass.
