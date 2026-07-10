# suggested 5-Minute Demo Video Shot List

This shot list is structured to hit every major judging criterion explicitly (Core Functionality & Data Ingestion, Mathematically Defensible Model, Solana On-Chain Integration, Autonomous Operation, and Production Readiness).

---

## Part 1: The Hook & The Problem (0:00 - 0:45)
**Goal:** Introduce Edgeline and define the opportunity (sports odds inefficiency in-play).
* **Shot 1 (Screen/Camera):** Present the live React Dashboard running at `http://localhost:3000`. Show the header stats, the active wallet (`CtDjtgpa...`), and the live-updating Monitored Fixtures count.
* **Shot 2 (Slide or Code Overlay):** Briefly highlight the issue: live market odds often lag or react inefficiently to fast-moving in-play events (goals, red cards), creating short-lived divergence opportunities.
* **Narration focus:** Explain how Edgeline automates the capture of these divergences in real time.

---

## Part 2: Data Ingestion & In-Play Model (0:45 - 1:45)
**Goal:** Show how data flows from TxLINE, and explain the mathematical logic.
* **Shot 3 (Code IDE):** Open [fair-price-model.service.ts](file:///Users/basil/Desktop/codes/edgeline/apps/api/src/scanner/fair-price-model.service.ts). Hover over the time weight calculation and goal/red card shift offsets.
* **Shot 4 (Terminal/Logs):** Show the NestJS log stream polling TxLINE endpoints:
  - `/api/fixtures/snapshot`
  - `/api/odds/snapshot/{fixtureId}`
  - `/api/scores/snapshot/{fixtureId}`
* **Narration focus:** Explain that we treat TxLINE's StablePrice consensus as an authoritative Bayesian prior. We update it using a time-weighted function based on live match events. Explain $t = \text{minute} / 90$ scaling.

---

## Part 3: Autonomous Operation & WS Gateway (1:45 - 3:00)
**Goal:** Prove the system operates without manual intervention.
* **Shot 5 (Terminal & UI Split Screen):** Set up a side-by-side view with the Next.js UI on the left and a terminal on the right.
* **Shot 6 (Action):** Run the simulation command in the terminal:
  ```bash
  curl http://localhost:3001/agent/test-event
  ```
* **Shot 7 (UI Update):** Show the dashboard immediately updating via Socket.IO:
  - An Opportunity appears instantly in the middle table.
  - A Position appears in the bottom table.
* **Narration focus:** Emphasize that the entire pipeline is reactive—WebSocket gateways broadcast the events, and the UI responds instantly with zero polling lag.

---

## Part 4: Solana On-Chain Execution (3:00 - 4:15)
**Goal:** Verify on-chain logging (record and settle) on Solana devnet.
* **Shot 8 (Solana Explorer):** Click the transaction hash link under the "Solana Explorer" column on the dashboard. Show the transaction details on `explorer.solana.com` (Devnet).
* **Shot 9 (Code/Terminal):** Briefly show the Anchor Rust instruction definitions (`record_position`, `settle_position`) in [lib.rs](file:///Users/basil/Desktop/codes/edgeline/programs/edgeline-vault/src/lib.rs).
* **Narration focus:** Detail how we use the fixture ID and a database position counter as PDA seeds to uniquely identify and log each position and its eventual settlement on-chain.

---

## Part 5: Production Readiness & Graceful Resilience (4:15 - 5:00)
**Goal:** Highlight real-world error handling and production status.
* **Shot 10 (Code IDE):** Open [global-exception.filter.ts](file:///Users/basil/Desktop/codes/edgeline/apps/api/src/orchestration/global-exception.filter.ts) and the retry loops in `solana-execution.service.ts`.
* **Shot 11 (Browser):** Reload the `/agent/status` endpoint to show the operational state summary that judges can inspect.
* **Narration focus:** Mention the global exception filter (keeps the agent running if external API data is malformed), the exponential retry backoffs, and the auto-airdrop wallet safety threshold. Conclude with where judges can test the endpoint.
