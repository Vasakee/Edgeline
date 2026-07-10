# EdgeLine: Autonomous Sports Trading Agent (Solana)

**EdgeLine** is an autonomous sports trading agent that detects and executes profitable live trades on Solana devnet with zero manual intervention. The agent continuously monitors in-play football matches, computes a mathematically defensible "fair-price" probability model using live match state, compares its outputs to the real-time TxLINE StablePrice consensus odds to find structural value (divergence edges), and automatically executes position entries and settlements directly on-chain using an Anchor Rust program.

---

## Architecture Pipeline

```
┌─────────────────┐      ┌─────────────────────────┐      ┌───────────────────────────┐
│   TxLINE API    ├─────►│  Fair-Price Model (API) ├─────►│ Divergence Scanner (API)  │
│ In-Play Ingestion│      │  (Bayesian update prior)│      │  (Divergence > 8% Threshold)│
└─────────────────┘      └─────────────────────────┘      └─────────────┬─────────────┘
                                                                        │
┌─────────────────┐      ┌─────────────────────────┐      ┌─────────────▼─────────────┐
│  Live Dashboard ◄──────┼──  WebSockets Stream    │      │  Decision Engine (API)    │
│ (React/Next.js) │      │  (Socket.IO broadcast)  │      │  (Risk check & position)  │
└─────────────────┘      └─────────────────────────┘      └─────────────┬─────────────┘
                                                                        │
                                                                        ▼
                                                          ┌───────────────────────────┐
                                                          │   Solana Devnet Program   │
                                                          │  (record/settle position) │
                                                          └───────────────────────────┘
```

1. **In-Play Ingestion**: Sourced via HTTP polling of TxLINE live odds and scoring feeds.
2. **Fair-Price Model**: Treats pre-match consensus odds as a Bayesian prior and updates it dynamically based on goal differences and net red cards, scaled by match duration elapsed.
3. **Divergence Scanner**: Compares model outcomes to live consensus odds to flag opportunities exceeding the threshold (e.g. 8%+ edge).
4. **Decision Engine**: Performs sizing via a risk cap system (daily limit, per-fixture limit) and approves entry.
5. **Solana Execution**: Initiates Solana transactions using the wallet keypair to record the trade PDA, with auto-airdrop and retries.
6. **Live Dashboard & Settlement**: Pushes updates instantly to Next.js clients via WebSockets, periodically checks for finished matches, computes realized PnL, and settles them on-chain.

---

## Mathematically Defensible Fair-Price Model

Rather than fitting a parameter-heavy predictive model, EdgeLine uses a **Bayesian Prior-Update model**. It establishes the initial prior from the consensus market price (TxLINE StablePrice), which incorporates broad market intelligence, and then applies a time-weighted update based on live match actions.

### 1. Urgency Weighting (Time Weight)
The significance of any live event (goals, dismissals) increases linearly as the match progresses:
$$t = \min\left( \frac{\text{minuteElapsed}}{90}, 1 \right) \quad \in [0, 1]$$

### 2. Event-Driven Shift Inputs
* **Goal Differential Shift**:
  $$\Delta_{\text{goals}} = (\text{homeScore} - \text{awayScore}) \times 0.15 \times t$$
* **Red Card Shift (Disadvantage)**:
  $$\Delta_{\text{red\_cards}} = -(\text{homeRedCards} - \text{awayRedCards}) \times 0.12 \times t$$

The combined event shift represents the net change in win probability:
$$\Delta = \Delta_{\text{goals}} + \Delta_{\text{red\_cards}}$$

### 3. Probability Distribution Adjustments
If $\Delta \ge 0$ (Home team is favored by match events):
* $P_{\text{home}} = P_{\text{home\_prior}} + \Delta$
* $P_{\text{draw}} = P_{\text{draw\_prior}} - 0.5 \times \Delta$ (Draw compresses faster)
* $P_{\text{away}} = P_{\text{away\_prior}} - 0.5 \times \Delta$

If $\Delta < 0$ (Away team is favored):
* $P_{\text{away}} = P_{\text{away\_prior}} + |\Delta|$
* $P_{\text{draw}} = P_{\text{draw\_prior}} - 0.5 \times |\Delta|$
* $P_{\text{home}} = P_{\text{home\_prior}} - 0.5 \times |\Delta|$

### 4. Clamping and Normalization
To reflect epistemic uncertainty (no outcome is mathematically impossible), the probabilities are clamped to a hard floor of $0.01$ and a ceiling of $0.98$:
$$P'_i = \max(0.01, \min(0.98, P_i)) \quad \Longrightarrow \quad P_{\text{final}} = \frac{P'_i}{\sum P'_j}$$

---

## Setup & Local Run Instructions

### 1. Environment Variables (`apps/api/.env`)
Ensure you create an `.env` file inside `apps/api/` with:
```env
SOLANA_WALLET_PATH=/Users/basil/.config/solana/edgeline-devnet.json
SOLANA_RPC_URL=https://api.devnet.solana.com
TXLINE_BASE_URL=https://txline-dev.txodds.com
TXLINE_API_TOKEN=your_txline_token_here
USE_FREE_WORLDCUP_TIER=true
POLL_INTERVAL_MS=20000
SETTLEMENT_INTERVAL_MS=120000
MAX_POSITION_SIZE=0.5
MAX_DAILY_EXPOSURE=2.0
MAX_CONCURRENT_POSITIONS_PER_FIXTURE=1
API_PORT=3001
API_HOST=0.0.0.0
```

### 2. Fund the Devnet Wallet
Create your devnet wallet keypair and request funds:
```bash
# Generate keypair
solana-keygen new --outfile ~/.config/solana/edgeline-devnet.json --no-bip39-passphrase

# Set config to use this keypair on devnet
solana config set --keypair ~/.config/solana/edgeline-devnet.json --url devnet

# Airdrop devnet SOL
solana airdrop 2
```

### 3. Deploy the Anchor Program to Devnet
From the root directory:
```bash
# Build SBF program and generate IDL
anchor build

# Deploy vault program to Solana Devnet
anchor deploy --provider.cluster devnet --provider.wallet ~/.config/solana/edgeline-devnet.json

# Copy the real IDL to API
cp target/idl/edgeline_vault.json apps/api/src/execution/idl/edgeline_vault.json
```

### 4. Running the Agent & Dashboard
Install dependencies and launch services from the workspace root:
```bash
pnpm install

# Start NestJS backend API
pnpm dev:api

# Start React/Next.js dashboard (on http://localhost:3000)
pnpm dev:web
```

---

## TxLINE API Endpoints Used

* **Guest Token Request**: `POST /auth/guest/start` (retrieves short-lived guest JWT)
* **Static API Token Activation**: `POST /api/token/activate` (binds signed on-chain tx signature to static API token)
* **Fixture Ingestion**: `GET /api/fixtures/snapshot` (retrieves full tournament list)
* **Real-time Consensus Odds**: `GET /api/odds/snapshot/{fixtureId}` (retrieves StablePrice odds)
* **Real-time Match Events**: `GET /api/scores/snapshot/{fixtureId}` (retrieves score updates, minutes, and card events)

---

## Judging & Testing Deliverables

* **Judge-Testable Status Endpoint**: `GET http://localhost:3001/agent/status`
* **Judge-Testable Simulation Trigger**: `GET http://localhost:3001/agent/test-event`
  * *Tip*: Trigger the simulation via `curl http://localhost:3001/agent/test-event` to instantly see live-updating Socket.IO changes on the dashboard.
* **On-Chain Program Address**: `EAVB3QfGZmMhRvYmtTrsLLuaRYbe6yBRM6JMj68R4VS3` (Solana Devnet)
