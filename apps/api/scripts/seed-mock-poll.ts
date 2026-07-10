/**
 * scripts/seed-mock-poll.ts
 *
 * Runs the edgeline polling loop for 2 minutes against mock fixture data.
 * Uses mongodb-memory-server — no local MongoDB install required.
 *
 * Usage (from monorepo root):
 *   pnpm --filter @edgeline/api ts-node scripts/seed-mock-poll.ts
 *
 * What it does:
 *   - Spins up an in-memory MongoDB instance
 *   - Seeds 3 mock World Cup fixtures
 *   - Runs the same persist logic as TxlineDataScheduler every POLL_INTERVAL_MS
 *   - After 2 minutes (or Ctrl+C), dumps example documents and exits cleanly
 */

import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import {
  OddsSnapshot,
  OddsSnapshotSchema,
} from '../src/txline-data/schemas/odds-snapshot.schema';
import {
  MatchState,
  MatchStateSchema,
} from '../src/txline-data/schemas/match-state.schema';

// ---------------------------------------------------------------------------
// Mock fixture data (realistic World Cup fixtures)
// ---------------------------------------------------------------------------

const MOCK_FIXTURES = [
  { fixtureId: '1001', homeTeam: 'Brazil', awayTeam: 'Argentina', competition: 'FIFA World Cup 2026' },
  { fixtureId: '1002', homeTeam: 'France', awayTeam: 'England', competition: 'FIFA World Cup 2026' },
  { fixtureId: '1003', homeTeam: 'Spain', awayTeam: 'Germany', competition: 'FIFA World Cup 2026' },
];

const BOOKMAKERS = ['Pinnacle', 'Bet365', 'Betfair', 'DraftKings'];
const MARKETS = ['1X2', 'OVER_UNDER_2.5', 'ASIAN_HANDICAP'];

// ---------------------------------------------------------------------------
// Mock data generators
// ---------------------------------------------------------------------------

function jitter(base: number, pct = 0.04): number {
  return base + (Math.random() - 0.5) * 2 * base * pct;
}

function mockOddsEntries(fixtureId: string) {
  const entries = [];
  for (const bookmaker of BOOKMAKERS) {
    for (const market of MARKETS) {
      // Base probabilities that jitter slightly each poll (simulates live movement)
      const h = jitter(0.42);
      const d = jitter(0.27);
      const a = 1 - h - d; // ensure they roughly sum to 1 (overround ignored for mock)

      entries.push({
        fixtureId,
        market,
        bookmaker,
        impliedProbHome: Math.max(0.05, h),
        impliedProbDraw: Math.max(0.05, d),
        impliedProbAway: Math.max(0.05, a),
        rawResponse: {
          FixtureId: parseInt(fixtureId),
          Bookmaker: bookmaker,
          SuperOddsType: market,
          Pct: [h.toFixed(3), d.toFixed(3), a.toFixed(3)],
          InRunning: true,
          Ts: Date.now(),
        },
        fetchedAt: new Date(),
      });
    }
  }
  return entries;
}

function mockScore(fixtureId: string, tick: number) {
  // Slowly increment score over time to simulate a live match
  const homeScore = Math.floor(tick / 4);
  const awayScore = Math.floor(tick / 6);
  return {
    fixtureId,
    minute: Math.min(90, tick * 3),
    gameState: tick < 15 ? 'H1' : tick < 16 ? 'HT' : 'H2',
    homeScore,
    awayScore,
    redCards: { home: 0, away: tick > 10 ? 1 : 0 },
    updatedAt: new Date(),
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  Edgeline — Mock Poll Runner (2 minutes)');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // 1. Start in-memory MongoDB
  const mongod = await MongoMemoryServer.create();
  const uri = mongod.getUri();
  console.log(`[mongo] In-memory MongoDB started at ${uri}`);

  await mongoose.connect(uri);
  console.log('[mongo] Connected\n');

  // 2. Register models
  const OddsModel = mongoose.model(OddsSnapshot.name, OddsSnapshotSchema);
  const MatchModel = mongoose.model(MatchState.name, MatchStateSchema);

  // 3. Poll loop
  const POLL_MS = parseInt(process.env.POLL_INTERVAL_MS ?? '20000', 10);
  const RUN_FOR_MS = 2 * 60 * 1000; // 2 minutes
  const startTime = Date.now();
  let tick = 0;

  console.log(`[scheduler] Polling every ${POLL_MS / 1000}s for ${RUN_FOR_MS / 60000} minutes`);
  console.log(`[scheduler] ${MOCK_FIXTURES.length} mock fixtures loaded\n`);

  const runPoll = async () => {
    tick++;
    const pollStart = Date.now();
    console.log(`\n── Tick ${tick} (${new Date().toISOString()}) ──────────────────`);

    for (const fixture of MOCK_FIXTURES) {
      const fixtureStart = Date.now();

      // Generate and persist mock odds
      const oddsEntries = mockOddsEntries(fixture.fixtureId);
      await OddsModel.insertMany(
        oddsEntries.map((e) => ({ ...e, homeTeam: fixture.homeTeam, awayTeam: fixture.awayTeam })),
      );

      // Generate and upsert mock score
      const score = mockScore(fixture.fixtureId, tick);
      await MatchModel.findOneAndUpdate(
        { fixtureId: fixture.fixtureId },
        { $set: score },
        { upsert: true, new: true },
      );

      const latency = Date.now() - fixtureStart;
      console.log(
        `[poll] fixture="${fixture.fixtureId}" ` +
        `home="${fixture.homeTeam}" away="${fixture.awayTeam}" ` +
        `odds=${oddsEntries.length} ` +
        `score=${score.homeScore}-${score.awayScore} ` +
        `minute=${score.minute} ` +
        `latency=${latency}ms`,
      );
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    const remaining = ((RUN_FOR_MS - (Date.now() - startTime)) / 1000).toFixed(0);
    console.log(`[scheduler] tick ${tick} done in ${Date.now() - pollStart}ms | elapsed ${elapsed}s | ${remaining}s remaining`);
  };

  // Fire immediately then on interval
  await runPoll();

  const interval = setInterval(async () => {
    if (Date.now() - startTime >= RUN_FOR_MS) {
      clearInterval(interval);
      await finish();
      return;
    }
    await runPoll();
  }, POLL_MS);

  // Handle Ctrl+C
  process.on('SIGINT', async () => {
    clearInterval(interval);
    console.log('\n[scheduler] Interrupted — dumping results…');
    await finish();
  });

  async function finish() {
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('  Results');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    // Counts
    const oddsCount = await OddsModel.countDocuments();
    const matchCount = await MatchModel.countDocuments();
    console.log(`odds_snapshots : ${oddsCount} documents`);
    console.log(`match_states   : ${matchCount} documents\n`);

    // Example odds_snapshot
    console.log('── Example odds_snapshot ────────────────────────');
    const exampleOdds = await OddsModel.findOne({ market: '1X2' }).lean();
    if (exampleOdds) {
      const { _id, __v, rawResponse, ...display } = exampleOdds as Record<string, unknown>;
      void _id; void __v;
      console.log(JSON.stringify({ ...display, rawResponse: '{ ...omitted... }' }, null, 2));
    }

    // All match states (one per fixture)
    console.log('\n── match_states (all fixtures) ──────────────────');
    const allStates = await MatchModel.find().lean();
    for (const s of allStates) {
      const { _id, __v, ...display } = s as Record<string, unknown>;
      void _id; void __v;
      console.log(JSON.stringify(display, null, 2));
    }

    // Latest odds per fixture summary
    console.log('\n── Latest implied probs per fixture (1X2, Pinnacle) ──');
    for (const fixture of MOCK_FIXTURES) {
      const latest = await OddsModel
        .findOne({ fixtureId: fixture.fixtureId, market: '1X2', bookmaker: 'Pinnacle' })
        .sort({ fetchedAt: -1 })
        .lean() as Record<string, unknown> | null;
      if (latest) {
        console.log(
          `  ${fixture.homeTeam} vs ${fixture.awayTeam}: ` +
          `H=${(latest.impliedProbHome as number).toFixed(3)} ` +
          `D=${(latest.impliedProbDraw as number).toFixed(3)} ` +
          `A=${(latest.impliedProbAway as number).toFixed(3)}`,
        );
      }
    }

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('  ✅  Done');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    await mongoose.disconnect();
    await mongod.stop();
    process.exit(0);
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
