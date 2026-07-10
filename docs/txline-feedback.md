# TxLINE API Friction Log

Notes recorded during edgeline hackathon development (2026-07-08).
This log is for the submission's "API feedback" section.

---

## Odds schema — `Pct` field

**Endpoint:** `GET /api/odds/snapshot/{fixtureId}` and `GET /api/odds/updates/{fixtureId}`

**Issue:** The `Pct` field is documented as an array of strings strictly formatted to
3 decimal places (`^(NA|\d+\.\d{3})$`), but its relationship to `Prices` (integer
array) is not explained. It took trial-and-error to establish that `Prices` are
raw implied odds in millipercent (e.g. `2500` = 2.500 = implied prob ~0.40), while
`Pct` appears to be the de-margined implied probability already. Since `Pct` is
the cleaner signal for our use case, we use it and fall back to `1/(Prices[i]/1000)`
when a `Pct` value is `"NA"`.

**Request:** Please document the exact relationship between `Prices` and `Pct`,
whether `Pct` is de-margined or raw, and what `"NA"` means for quarter handicap lines.

---

## Scores snapshot — `dataSoccer.Minutes` availability

**Endpoint:** `GET /api/scores/snapshot/{fixtureId}`

**Issue:** The `dataSoccer.Minutes` field (current match minute) is present in
the API reference response schema, but it's unclear whether it is always populated
during `H1`/`H2` or only on certain event types (e.g. goal, card). During mock
testing we assumed it is present on each event update; if it is only present on
goal/card events, the fair-price model's time-weighting will stall between events.

**Request:** Clarify whether `dataSoccer.Minutes` is emitted on every score event
or only on scoring/card events. If the latter, document the best way to derive
the current match clock continuously.

---

## Scores snapshot — response is an array of events, not a single state

**Endpoint:** `GET /api/scores/snapshot/{fixtureId}`

**Issue:** The snapshot endpoint returns an array of events rather than a single
current-state object. To get the current score and minute we have to reduce the
array by `ts` to find the latest event, then read `scoreSoccer.*.Total.Goals`.
This is fine but non-obvious — the word "snapshot" implies a single document.

**Request:** Consider adding a `GET /api/scores/current/{fixtureId}` endpoint
that returns a single aggregated current state (score + minute + game state),
which is the primary use case for in-play models like ours.

---

## Pre-match odds as model prior

**Implementation note (not an API issue):**
We use the market's own TxLINE StablePrice as the Bayesian prior for our fair-price
model. This is intentional: TxLINE's consensus pricing already incorporates sharp
bookmaker intelligence, so it is a better prior than any parametric model we could
fit at hackathon time. The scanner then adjusts this prior based on in-play events
(goals, red cards) weighted by time remaining.

---

## Auth token TTL not returned by activation endpoint

**Endpoint:** `POST /api/token/activate`

**Issue:** The response contains the `token` (or `token.token`) but no expiry
timestamp. Our implementation conservatively re-activates every 23 hours. If the
real TTL is shorter or longer this wastes on-chain subscription transactions.

**Request:** Include a `expiresAt` (ISO timestamp or Unix seconds) in the
activation response so clients can cache tokens accurately.

---

## Devnet execution integration notes (2026-07-08)

### On-chain timing vs live data

The TxLINE free tier delivers prices in 5-minute batches. The Anchor program's
`record_position` instruction fires as soon as a divergence is detected by the
scanner — but the next TxLINE batch update may close that divergence within the
same 5-minute window. In practice this means:

- A position may be recorded on-chain during the gap between two TxLINE price
  batches, when our model and the (stale) market price diverge.
- By the time the next batch arrives, the market may have already corrected to
  the same price our model was computing — so the "edge" disappears immediately.
- **Implication for judging:** On devnet with the free 60-second-delayed tier,
  the scanner will flag divergences that real-time data would not. This is
  expected behaviour on the free tier and is noted here for transparency.

### Airdrop rate limiting

`solana airdrop` on devnet is rate-limited (1–2 SOL per request, ~30s cooldown).
The execution service auto-requests an airdrop when balance drops below 0.05 SOL,
but if multiple positions fire in rapid succession the airdrop may be rate-limited.
The service degrades gracefully: it logs a warning and attempts the transaction
anyway — a transaction will fail at the RPC level rather than hanging indefinitely.

### Position PDA counter race

The `counter` used as a PDA seed is derived by counting existing
`executed|pending` positions for the fixture in MongoDB. If two positions for
the same fixture are approved simultaneously (unlikely given MAX_CONCURRENT=1
cap but theoretically possible on restart), they could attempt to write the
same PDA and one would fail with `AccountAlreadyInUse`. The per-fixture cap
prevents this in normal operation; the failure mode is logged and the position
is marked `failed` rather than left ambiguous.

### IDL stub vs built IDL

`src/execution/idl/edgeline_vault.json` is a hand-authored stub with the correct
instruction signatures. After `anchor build`, replace it with the generated
`target/idl/edgeline_vault.json` to get exact discriminators. The stub's
discriminators are placeholders (all zeros/ones) — they won't match a deployed
program. The real IDL must be in place before calling the program on devnet.
