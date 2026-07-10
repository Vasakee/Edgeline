/**
 * scripts/demo-scanner.ts
 *
 * Demonstrates the fair-price model and divergence detector against
 * several simulated match states. No network or MongoDB required.
 *
 * Usage (from monorepo root):
 *   pnpm --filter @edgeline/api ts-node scripts/demo-scanner.ts
 */

import {
  computeFairProbability,
  MatchStateInput,
  PreMatchOdds,
} from '../src/scanner/fair-price-model.service';

// ---------------------------------------------------------------------------
// Minimal stub of DivergenceDetectorService (no NestJS needed)
// ---------------------------------------------------------------------------
const MIN_THRESHOLD = 0.08;
const LATE_GAME_MINUTE = 60;

function computeConfidence(
  divergencePct: number,
  minute: number | null,
): 'low' | 'medium' | 'high' {
  const abs = Math.abs(divergencePct);
  const isLate = minute !== null && minute >= LATE_GAME_MINUTE;
  if (abs >= 0.20) return 'high';
  if (abs >= 0.12) return isLate ? 'high' : 'medium';
  return isLate ? 'medium' : 'low';
}

function detectDivergence(
  fairProb: { home: number; draw: number; away: number },
  market: { home: number; draw: number; away: number },
  minute: number | null,
) {
  const candidates = [
    { outcome: 'home' as const, modelProb: fairProb.home, marketProb: market.home, divergencePct: fairProb.home - market.home },
    { outcome: 'draw' as const, modelProb: fairProb.draw, marketProb: market.draw, divergencePct: fairProb.draw - market.draw },
    { outcome: 'away' as const, modelProb: fairProb.away, marketProb: market.away, divergencePct: fairProb.away - market.away },
  ];
  const best = candidates.reduce((a, b) => (b.divergencePct > a.divergencePct ? b : a));
  if (best.divergencePct < MIN_THRESHOLD) return null;
  return { ...best, confidence: computeConfidence(best.divergencePct, minute) };
}

// ---------------------------------------------------------------------------
// Scenario runner
// ---------------------------------------------------------------------------

interface Scenario {
  label: string;
  fixture: { home: string; away: string };
  preMatchOdds: PreMatchOdds;
  /** Live market odds (simulates stale TxLINE price that hasn't updated yet) */
  liveMarketOdds: PreMatchOdds;
  matchState: MatchStateInput;
}

function run(scenario: Scenario): void {
  const { label, fixture, preMatchOdds, liveMarketOdds, matchState } = scenario;

  const fairProb = computeFairProbability(matchState, preMatchOdds);
  const divergence = detectDivergence(fairProb, liveMarketOdds, matchState.minute);

  const line = `─────────────────────────────────────────────────────────`;
  console.log(`\n${line}`);
  console.log(`  ${label}`);
  console.log(`  ${fixture.home} vs ${fixture.away}`);
  console.log(line);
  console.log(`  Match state : min=${matchState.minute ?? 'pre'} score=${matchState.homeScore}-${matchState.awayScore} reds=H${matchState.redCards.home}/A${matchState.redCards.away} state=${matchState.gameState ?? '-'}`);
  console.log(`  Pre-match   : H=${preMatchOdds.home.toFixed(3)}  D=${preMatchOdds.draw.toFixed(3)}  A=${preMatchOdds.away.toFixed(3)}`);
  console.log(`  Live market : H=${liveMarketOdds.home.toFixed(3)}  D=${liveMarketOdds.draw.toFixed(3)}  A=${liveMarketOdds.away.toFixed(3)}  (stale)`);
  console.log(`  Our model   : H=${fairProb.home.toFixed(3)}  D=${fairProb.draw.toFixed(3)}  A=${fairProb.away.toFixed(3)}`);
  console.log(`  Sum check   : ${(fairProb.home + fairProb.draw + fairProb.away).toFixed(6)}`);

  if (divergence) {
    console.log(`\n  ✅ OPPORTUNITY DETECTED`);
    console.log(
      JSON.stringify(
        {
          fixtureId: '424242',
          outcome: divergence.outcome,
          modelProb: +divergence.modelProb.toFixed(4),
          marketProb: +divergence.marketProb.toFixed(4),
          divergencePct: +divergence.divergencePct.toFixed(4),
          confidence: divergence.confidence,
          detectedAt: new Date().toISOString(),
          actedOn: false,
          matchStateSnapshot: {
            minute: matchState.minute,
            gameState: matchState.gameState,
            homeScore: matchState.homeScore,
            awayScore: matchState.awayScore,
            redCards: matchState.redCards,
          },
        },
        null,
        4,
      ),
    );
  } else {
    console.log(`\n  ⏭  No opportunity (max divergence below ${(MIN_THRESHOLD * 100).toFixed(0)}pp threshold)`);
  }
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

const scenarios: Scenario[] = [
  {
    label: 'S1 — Kickoff, no match events',
    fixture: { home: 'Brazil', away: 'Argentina' },
    preMatchOdds:   { home: 0.42, draw: 0.27, away: 0.31 },
    liveMarketOdds: { home: 0.42, draw: 0.27, away: 0.31 }, // same — no divergence expected
    matchState: { minute: null, gameState: null, homeScore: 0, awayScore: 0, redCards: { home: 0, away: 0 } },
  },
  {
    label: 'S2 — Home team 1-0 up at minute 5, market price stale',
    fixture: { home: 'France', away: 'England' },
    preMatchOdds:   { home: 0.38, draw: 0.29, away: 0.33 },
    liveMarketOdds: { home: 0.38, draw: 0.29, away: 0.33 }, // hasn't updated yet after goal
    matchState: { minute: 5, gameState: 'H1', homeScore: 1, awayScore: 0, redCards: { home: 0, away: 0 } },
  },
  {
    label: 'S3 — Home team 1-0 up at minute 78, market price stale (strong signal)',
    fixture: { home: 'Spain', away: 'Germany' },
    preMatchOdds:   { home: 0.40, draw: 0.27, away: 0.33 },
    liveMarketOdds: { home: 0.40, draw: 0.27, away: 0.33 }, // stale
    matchState: { minute: 78, gameState: 'H2', homeScore: 1, awayScore: 0, redCards: { home: 0, away: 0 } },
  },
  {
    label: 'S4 — Away team 2-0 up at minute 65, market slow to update',
    fixture: { home: 'Italy', away: 'Portugal' },
    preMatchOdds:   { home: 0.36, draw: 0.28, away: 0.36 },
    liveMarketOdds: { home: 0.32, draw: 0.27, away: 0.41 }, // partially updated
    matchState: { minute: 65, gameState: 'H2', homeScore: 0, awayScore: 2, redCards: { home: 0, away: 0 } },
  },
  {
    label: 'S5 — Home red card at minute 55, market not yet reflecting it',
    fixture: { home: 'Netherlands', away: 'USA' },
    preMatchOdds:   { home: 0.44, draw: 0.26, away: 0.30 },
    liveMarketOdds: { home: 0.44, draw: 0.26, away: 0.30 }, // stale — card just happened
    matchState: { minute: 55, gameState: 'H2', homeScore: 0, awayScore: 0, redCards: { home: 1, away: 0 } },
  },
  {
    label: 'S6 — Home 1-0, away red card, minute 82 (compounding signals)',
    fixture: { home: 'Morocco', away: 'Japan' },
    preMatchOdds:   { home: 0.38, draw: 0.28, away: 0.34 },
    liveMarketOdds: { home: 0.50, draw: 0.24, away: 0.26 }, // partially updated
    matchState: { minute: 82, gameState: 'H2', homeScore: 1, awayScore: 0, redCards: { home: 0, away: 1 } },
  },
  {
    label: 'S7 — 0-0 at minute 89, tense draw, small divergence',
    fixture: { home: 'Mexico', away: 'Ecuador' },
    preMatchOdds:   { home: 0.41, draw: 0.27, away: 0.32 },
    liveMarketOdds: { home: 0.35, draw: 0.38, away: 0.27 }, // market pushed draw
    matchState: { minute: 89, gameState: 'H2', homeScore: 0, awayScore: 0, redCards: { home: 0, away: 0 } },
  },
];

console.log('\n══════════════════════════════════════════════════════');
console.log('  Edgeline Scanner — Fair Price Model Demo');
console.log('══════════════════════════════════════════════════════');
console.log(`  MIN_DIVERGENCE_THRESHOLD : ${(MIN_THRESHOLD * 100).toFixed(0)}pp`);
console.log(`  LATE_GAME_MINUTE         : ${LATE_GAME_MINUTE}`);

for (const scenario of scenarios) {
  run(scenario);
}

console.log('\n══════════════════════════════════════════════════════\n');
