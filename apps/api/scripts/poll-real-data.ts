/**
 * scripts/poll-real-data.ts
 *
 * Runs the confirmed polling flow against the real TxLINE devnet API
 * for 2 minutes, persists real OddsSnapshot and MatchState documents
 * to MongoDB (in-memory via mongodb-memory-server), and prints real documents.
 *
 * Usage:
 *   pnpm --filter @edgeline/api ts-node scripts/poll-real-data.ts
 *
 * Prerequisites:
 *   - apps/api/.env must contain SOLANA_WALLET_PATH and a valid static
 *     API token from a completed auth flow as TXLINE_API_TOKEN
 *   - Internet access to https://txline-dev.txodds.com
 */

import * as path from 'path';
import * as fs from 'fs';
import * as dotenv from 'dotenv';

const envPath = path.resolve(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
  console.log(`[env] Loaded ${envPath}`);
} else {
  console.warn(`[env] No .env file at ${envPath}`);
}

import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import axios from 'axios';
import { OddsSnapshot, OddsSnapshotSchema } from '../src/txline-data/schemas/odds-snapshot.schema';
import { MatchState, MatchStateSchema } from '../src/txline-data/schemas/match-state.schema';
import { TXLINE_ENDPOINTS, MARKET_1X2, PRICE_NAME_HOME, PRICE_NAME_DRAW, PRICE_NAME_AWAY } from '../src/txline-data/txline-data.config';
import type { TxFixture, TxOddsEntry, TxScoreEvent } from '../src/txline-data/txline-data.service';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const BASE_URL = process.env.TXLINE_BASE_URL ?? 'https://txline-dev.txodds.com';
const STATIC_API_TOKEN = process.env.TXLINE_API_TOKEN ?? '';
const POLL_MS = parseInt(process.env.POLL_INTERVAL_MS ?? '20000', 10);
const RUN_FOR_MS = 2 * 60 * 1000;

if (!STATIC_API_TOKEN) {
  console.error('ERROR: TXLINE_API_TOKEN not set in .env — run test-txline-auth.ts first');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Auth helpers — fresh guest JWT per call, cached static token
// ---------------------------------------------------------------------------

async function getFreshJwt(): Promise<string> {
  const res = await axios.post<{ token: string }>(`${BASE_URL}/auth/guest/start`);
  return res.data.token;
}

async function authHeaders(): Promise<Record<string, string>> {
  const jwt = await getFreshJwt();
  return {
    Authorization: `Bearer ${jwt}`,
    'X-Api-Token': STATIC_API_TOKEN,
  };
}

// ---------------------------------------------------------------------------
// API calls
// ---------------------------------------------------------------------------

async function fetchFixtures(): Promise<TxFixture[]> {
  const headers = await authHeaders();
  const res = await axios.get<TxFixture[]>(`${BASE_URL}${TXLINE_ENDPOINTS.fixturesSnapshot}`, { headers, timeout: 8000 });
  return res.data;
}

async function fetchOdds(fixtureId: string): Promise<TxOddsEntry[]> {
  const headers = await authHeaders();
  const res = await axios.get<TxOddsEntry[]>(`${BASE_URL}${TXLINE_ENDPOINTS.oddsSnapshot}/${fixtureId}`, { headers, timeout: 8000 });
  return res.data;
}

async function fetchScore(fixtureId: string): Promise<TxScoreEvent[]> {
  const headers = await authHeaders();
  const res = await axios.get<TxScoreEvent[]>(`${BASE_URL}${TXLINE_ENDPOINTS.scoresSnapshot}/${fixtureId}`, { headers, timeout: 8000 });
  return res.data;
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

function parseOnex2(fixtureId: string, entry: TxOddsEntry) {
  const names = entry.PriceNames ?? [];
  const pct = entry.Pct ?? [];
  const idx = (name: string) => {
    const i = names.indexOf(name);
    return i !== -1 ? i : names.findIndex(n => n.toLowerCase() === name.toLowerCase());
  };
  const prob = (name: string): number => {
    const i = idx(name);
    if (i === -1 || !pct[i] || pct[i] === 'NA') return 0;
    return parseFloat(pct[i]) / 100;
  };
  return {
    fixtureId,
    bookmaker: entry.Bookmaker,
    impliedProbHome: prob(PRICE_NAME_HOME),
    impliedProbDraw: prob(PRICE_NAME_DRAW),
    impliedProbAway: prob(PRICE_NAME_AWAY),
    rawResponse: entry as unknown as Record<string, unknown>,
    fetchedAt: new Date(),
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('\n══════════════════════════════════════════════════════');
  console.log('  Edgeline — Real TxLINE Data Poller');
  console.log('══════════════════════════════════════════════════════');
  console.log(`  API:     ${BASE_URL}`);
  console.log(`  Token:   ${STATIC_API_TOKEN.slice(0, 20)}...`);
  console.log(`  Poll:    every ${POLL_MS / 1000}s for ${RUN_FOR_MS / 60000} minutes`);

  // Start in-memory MongoDB
  const mongod = await MongoMemoryServer.create();
  const uri = mongod.getUri();
  await mongoose.connect(uri);
  console.log(`  MongoDB: in-memory at ${uri}\n`);

  const OddsModel = mongoose.model(OddsSnapshot.name, OddsSnapshotSchema);
  const MatchModel = mongoose.model(MatchState.name, MatchStateSchema);

  const startTime = Date.now();
  let tick = 0;

  const runPoll = async () => {
    tick++;
    const pollStart = Date.now();
    console.log(`\n── Tick ${tick} (${new Date().toISOString()}) ──────────────────`);

    let fixtures: TxFixture[];
    try {
      fixtures = await fetchFixtures();
    } catch (err) {
      console.error(`  fetchFixtures failed: ${String(err)}`);
      return;
    }

    console.log(`  ${fixtures.length} fixture(s) in snapshot`);

    let persisted = 0;
    let skippedNo1X2 = 0;

    for (const f of fixtures) {
      const fixtureId = String(f.FixtureId);
      const homeTeam = f.Participant1IsHome ? f.Participant1 : f.Participant2;
      const awayTeam = f.Participant1IsHome ? f.Participant2 : f.Participant1;

      try {
        const [oddsEntries, scoreEvents] = await Promise.all([
          fetchOdds(fixtureId),
          fetchScore(fixtureId),
        ]);

        // Persist match state
        const latestScore = scoreEvents.reduce<TxScoreEvent | null>((best, ev) => {
          if (!best) return ev;
          return ((ev as {ts?:number}).ts ?? 0) > ((best as {ts?:number}).ts ?? 0) ? ev : best;
        }, null);

        const soccer = latestScore?.scoreSoccer;
        await MatchModel.findOneAndUpdate(
          { fixtureId },
          { $set: {
            fixtureId, homeTeam, awayTeam,
            minute: latestScore?.dataSoccer?.Minutes ?? null,
            gameState: latestScore?.statusSoccerId ?? latestScore?.gameState ?? null,
            homeScore: soccer?.Participant1?.Total?.Goals ?? 0,
            awayScore: soccer?.Participant2?.Total?.Goals ?? 0,
            redCards: { home: soccer?.Participant1?.Total?.RedCards ?? 0, away: soccer?.Participant2?.Total?.RedCards ?? 0 },
            updatedAt: new Date(),
          }},
          { upsert: true, new: true },
        ); else {
          await MatchModel.findOneAndUpdate(
            { fixtureId },
            { $set: { fixtureId, homeTeam, awayTeam, minute: null, gameState: null, homeScore: 0, awayScore: 0, redCards: { home: 0, away: 0 }, updatedAt: new Date() } },
            { upsert: true, new: true },
          );
        }

        // Filter for confirmed 1X2 market
        const onex2Entry = oddsEntries.find(e => e.SuperOddsType === MARKET_1X2) ?? null;
        const otherCount = oddsEntries.filter(e => e.SuperOddsType !== MARKET_1X2).length;

        if (!onex2Entry) {
          console.log(`  [skip-no-1x2] fixture=${fixtureId} ${homeTeam} vs ${awayTeam} (other_markets=${otherCount})`);
          skippedNo1X2++;
          continue;
        }

        const parsed = parseOnex2(fixtureId, onex2Entry);
        await OddsModel.create({
          fixtureId, homeTeam, awayTeam,
          market: MARKET_1X2,
          bookmaker: parsed.bookmaker,
          impliedProbHome: parsed.impliedProbHome,
          impliedProbDraw: parsed.impliedProbDraw,
          impliedProbAway: parsed.impliedProbAway,
          rawResponse: parsed.rawResponse,
          fetchedAt: parsed.fetchedAt,
        });

        console.log(
          `  [ok] fixture=${fixtureId} ${homeTeam} vs ${awayTeam} ` +
          `H=${parsed.impliedProbHome.toFixed(3)} D=${parsed.impliedProbDraw.toFixed(3)} A=${parsed.impliedProbAway.toFixed(3)} ` +
          `score=${latestScore?.scoreSoccer?.Participant1?.Total?.Goals ?? 0}-${latestScore?.scoreSoccer?.Participant2?.Total?.Goals ?? 0}`,
        );
        persisted++;
      } catch (err) {
        console.error(`  [error] fixture=${fixtureId}: ${String(err)}`);
      }
    }

    console.log(`  Tick ${tick}: persisted=${persisted} skipped_no_1x2=${skippedNo1X2} in ${Date.now() - pollStart}ms`);
  };

  await runPoll();

  const interval = setInterval(async () => {
    if (Date.now() - startTime >= RUN_FOR_MS) {
      clearInterval(interval);
      await finish();
      return;
    }
    await runPoll();
  }, POLL_MS);

  process.on('SIGINT', async () => { clearInterval(interval); await finish(); });

  async function finish() {
    console.log('\n══════════════════════════════════════════════════════');
    console.log('  Results — Real Documents Written to MongoDB');
    console.log('══════════════════════════════════════════════════════\n');

    const oddsCount = await OddsModel.countDocuments();
    const matchCount = await MatchModel.countDocuments();
    console.log(`  odds_snapshots : ${oddsCount} documents`);
    console.log(`  match_states   : ${matchCount} documents\n`);

    if (oddsCount > 0) {
      console.log('── Example OddsSnapshot (most recent) ───────────────');
      const example = await OddsModel.findOne().sort({ fetchedAt: -1 }).lean() as Record<string, unknown> | null;
      if (example) {
        const { _id, __v, rawResponse, ...display } = example;
        void _id; void __v;
        console.log(JSON.stringify({ ...display, rawResponse: '{ ...omitted... }' }, null, 2));
      }

      console.log('\n── All OddsSnapshot fixtures seen ────────────────────');
      const fixtures = await OddsModel.distinct('fixtureId');
      for (const fid of fixtures) {
        const latest = await OddsModel.findOne({ fixtureId: fid }).sort({ fetchedAt: -1 }).lean() as Record<string, unknown> | null;
        if (latest) {
          console.log(`  fixture=${fid} ${latest.homeTeam} vs ${latest.awayTeam}: H=${(latest.impliedProbHome as number).toFixed(3)} D=${(latest.impliedProbDraw as number).toFixed(3)} A=${(latest.impliedProbAway as number).toFixed(3)}`);
        }
      }
    } else {
      console.log('  No OddsSnapshot documents written — all fixtures returned no 1X2 market in this window.');
      console.log('  (World Cup fixtures may be pre-match with odds not yet published. Check match_states for raw fixture coverage.)');
    }

    if (matchCount > 0) {
      console.log('\n── All MatchState documents ──────────────────────────');
      const states = await MatchModel.find().lean();
      for (const s of states) {
        const { _id, __v, ...display } = s as Record<string, unknown>;
        void _id; void __v;
        console.log(JSON.stringify(display, null, 2));
      }
    }

    console.log('\n══════════════════════════════════════════════════════\n');
    await mongoose.disconnect();
    await mongod.stop();
    process.exit(0);
  }
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
