# V1 Product Modes

## Protected market runtime

Risk Training and Challenge both use the performance foundation from commit
`dd5e287`. There is one browser market runtime and one advancement path:

- `MarketClock` queues visual steps.
- `MarketBuffer` holds a bounded rolling 1m window.
- `requestAnimationFrame` coalesces rapid clicks.
- released 1m rows incrementally update every loaded timeframe cache.
- `MarketChart` receives the same incremental candle arrays.
- execution scans the released 1m rows before a visual step is committed.

Product modes do not issue a request per click and do not own separate replay,
timeframe-loading, fast-forward, or chart-update implementations.

## Risk Training

Risk Training uses a session state machine with `SETUP`, `QUESTION`,
`PREPARING_REPLAY`, `REPLAY`, `RESULT`, `REVIEW`, and `ENDED` states.

Lot size is calculated from the current balance, selected risk, entry, and stop
distance. It is always floored to the configured 0.01 step. The result is capped
by the maximum affordable lot and never rounded up beyond the target risk.

Question allocation selects a historical starting point only. The rolling
buffer can continue refilling until the dataset ends. A PASS changes question
and pass counts but not balance or trade count. A completed trade updates the
balance before the next question is sized.

Future reveal is accepted only from a server `RESULT` state. The server caps it
at four hours after the recorded exit and moves the session to `REVIEW`.

## Challenge

Challenge uses `SETUP`, `ACTIVE`, `POSITION_OPEN`, `ENDED`, and `BLOWN` states.
It displays anonymous elapsed days and does not expose Question, PASS, Result,
or Reveal Future controls.

The user selects a manual lot. Opening is rejected when required margin exceeds
free margin. V1 supports one active market position, manual close, TP, SL,
stop-out, sequential trades, user end, and dataset end.

Account values are recalculated from the latest released 1m close: balance,
equity, floating PnL, used margin, free margin, and margin level. Broker rules
are centralized in `src/config/broker-simulation.ts`.

## Persistence boundary

Product sessions remain anonymous and process-local in V1. Server sessions
store the opaque mode and actual historical timestamp. Domain types and trade
records are separated from UI state so durable users, sessions, and trades can
be added later without replacing the market runtime.

