/**
 * scripts/demo-decision.ts
 *
 * Demonstrates the position-sizing engine against several opportunity scenarios,
 * producing example Position documents including cap-blocked ones.
 * No NestJS container, no DB, no network required.
 *
 * Usage:
 *   pnpm --filter @edgeline/api ts-node scripts/demo-decision.ts
 */

import {
  PositionSizingService,
  OpportunityInput,
} from '../src/decision/position-sizing.service';
import { ConfigService } from '@nestjs/config';

// ---------------------------------------------------------------------------
// Minimal config stub
// ---------------------------------------------------------------------------

const config = {
  get: (key: string) =>
    ({
      MAX_POSITION_SIZE: '0.5',
      MAX_DAILY_EXPOSURE: '2.0',
      MAX_CONCURRENT_POSITIONS_PER_FIXTURE: '1',
    }[key]),
} as unknown as ConfigService;

const sizing = new PositionSizingService(config);

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

interface Scenario {
  label: string;
  opportunity: OpportunityInput;
  openPositionsForFixture: number;
  currentDailyExposure: number;
}

const scenarios: Scenario[] = [
  {
    label: 'S1 — Normal approval: Spain 1-0, min 78, high confidence',
    opportunity: {
      opportunityId: 'opp-aaaa1111',
      fixtureId: 'fix-1001',
      outcome: 'home',
      divergencePct: 0.130,
      confidence: 'high',
    },
    openPositionsForFixture: 0,
    currentDailyExposure: 0,
  },
  {
    label: 'S2 — Medium confidence: Italy 0-2, min 65',
    opportunity: {
      opportunityId: 'opp-bbbb2222',
      fixtureId: 'fix-1002',
      outcome: 'away',
      divergencePct: 0.167,
      confidence: 'medium',
    },
    openPositionsForFixture: 0,
    currentDailyExposure: 0.065,
  },
  {
    label: 'S3 — SKIPPED: fixture cap (already have open position on fix-1001)',
    opportunity: {
      opportunityId: 'opp-cccc3333',
      fixtureId: 'fix-1001',
      outcome: 'home',
      divergencePct: 0.145,
      confidence: 'high',
    },
    openPositionsForFixture: 1, // cap=1 already reached
    currentDailyExposure: 0.065,
  },
  {
    label: 'S4 — SKIPPED: daily exposure cap (running close to 2.0 SOL limit)',
    opportunity: {
      opportunityId: 'opp-dddd4444',
      fixtureId: 'fix-1003',
      outcome: 'away',
      divergencePct: 0.126,
      confidence: 'high',
    },
    openPositionsForFixture: 0,
    currentDailyExposure: 1.97, // 1.97 + 0.063 = 2.033 > 2.0
  },
  {
    label: 'S5 — Low confidence: Morocco red card, min 55',
    opportunity: {
      opportunityId: 'opp-eeee5555',
      fixtureId: 'fix-1004',
      outcome: 'away',
      divergencePct: 0.085,
      confidence: 'low',
    },
    openPositionsForFixture: 0,
    currentDailyExposure: 0.191,
  },
];

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

console.log('\n══════════════════════════════════════════════════════');
console.log('  Edgeline Decision Engine — Position Sizing Demo');
console.log('══════════════════════════════════════════════════════');
console.log(`  MAX_POSITION_SIZE                    : ${sizing.maxPositionSize} SOL`);
console.log(`  MAX_DAILY_EXPOSURE                   : ${sizing.maxDailyExposure} SOL`);
console.log(`  MAX_CONCURRENT_POSITIONS_PER_FIXTURE : ${sizing.maxConcurrentPerFixture}`);

for (const scenario of scenarios) {
  const result = sizing.sizePosition(
    scenario.opportunity,
    scenario.openPositionsForFixture,
    scenario.currentDailyExposure,
  );

  const approved = result.size > 0;
  const status = approved ? 'pending' : 'skipped';

  const positionDoc = {
    opportunityId: scenario.opportunity.opportunityId,
    fixtureId: scenario.opportunity.fixtureId,
    outcome: scenario.opportunity.outcome,
    size: result.size,
    status,
    pnl: null,
    decidedAt: new Date().toISOString(),
    reasoning: result.reasoning,
  };

  console.log(`\n──────────────────────────────────────────────────────`);
  console.log(`  ${scenario.label}`);
  console.log(`  → status: ${approved ? '✅ APPROVED' : '⛔ SKIPPED'}`);
  console.log(``);
  console.log(JSON.stringify(positionDoc, null, 4));
}

console.log('\n══════════════════════════════════════════════════════\n');
