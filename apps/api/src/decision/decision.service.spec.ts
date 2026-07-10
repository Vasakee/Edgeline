/**
 * decision.service.spec.ts
 *
 * Unit tests for PositionSizingService.sizePosition().
 * All tests use the pure function directly — no NestJS container, no DB.
 */

jest.mock('../scanner/scanner.service', () => ({}));
jest.mock('../txline-auth/txline-auth.service', () => ({}));
jest.mock('../txline-auth/wallet.provider', () => ({}));

import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import {
  PositionSizingService,
  OpportunityInput,
  CONFIDENCE_MULTIPLIERS,
} from './position-sizing.service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Record<string, string> = {}): ConfigService {
  const defaults: Record<string, string> = {
    MAX_POSITION_SIZE: '0.5',
    MAX_DAILY_EXPOSURE: '2.0',
    MAX_CONCURRENT_POSITIONS_PER_FIXTURE: '1',
  };
  const cfg = { ...defaults, ...overrides };
  return {
    get: jest.fn((key: string) => cfg[key]),
    getOrThrow: jest.fn((key: string) => cfg[key]),
  } as unknown as ConfigService;
}

function makeOpportunity(
  overrides: Partial<OpportunityInput> = {},
): OpportunityInput {
  return {
    opportunityId: 'opp-001',
    fixtureId: 'fix-1001',
    outcome: 'home',
    divergencePct: 0.15,          // 15pp divergence
    confidence: 'high',
    ...overrides,
  };
}

async function buildService(configOverrides: Record<string, string> = {}) {
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      PositionSizingService,
      { provide: ConfigService, useValue: makeConfig(configOverrides) },
    ],
  }).compile();
  return module.get<PositionSizingService>(PositionSizingService);
}

// ---------------------------------------------------------------------------
// Test 1: Normal sizing — high confidence, no caps triggered
// ---------------------------------------------------------------------------

describe('PositionSizingService — normal sizing', () => {
  it('computes correct size for high-confidence 15pp divergence', async () => {
    const service = await buildService();
    const opp = makeOpportunity({ divergencePct: 0.15, confidence: 'high' });

    const result = service.sizePosition(opp, 0, 0);

    // baseSize = 0.15 * 1.0 * 0.5 = 0.075
    // multiplier = 1.0 (high)
    // finalSize = 0.075
    expect(result.size).toBeCloseTo(0.075, 5);
    expect(result.skipReason).toBeNull();
    expect(result.reasoning.fixtureCap).toBe('passed');
    expect(result.reasoning.dailyExposureCap).toBe('passed');
    expect(result.reasoning.confidenceMultiplier).toBe(1.0);
  });

  it('applies medium confidence multiplier (0.7×) correctly', async () => {
    const service = await buildService();
    const opp = makeOpportunity({ divergencePct: 0.20, confidence: 'medium' });

    const result = service.sizePosition(opp, 0, 0);

    // baseSize = 0.20 * 0.5 = 0.10
    // multiplier = 0.7
    // finalSize = 0.07
    expect(result.size).toBeCloseTo(0.07, 5);
    expect(result.reasoning.confidenceMultiplier).toBe(CONFIDENCE_MULTIPLIERS.medium);
  });

  it('applies low confidence multiplier (0.3×) correctly', async () => {
    const service = await buildService();
    const opp = makeOpportunity({ divergencePct: 0.10, confidence: 'low' });

    const result = service.sizePosition(opp, 0, 0);

    // baseSize = 0.10 * 0.5 = 0.05
    // multiplier = 0.3
    // finalSize = 0.015
    expect(result.size).toBeCloseTo(0.015, 5);
    expect(result.reasoning.confidenceMultiplier).toBe(CONFIDENCE_MULTIPLIERS.low);
  });

  it('caps base size at MAX_POSITION_SIZE before multiplier', async () => {
    const service = await buildService();
    // divergencePct > 1.0 is unrealistic but tests the clamp
    const opp = makeOpportunity({ divergencePct: 5.0, confidence: 'high' });

    const result = service.sizePosition(opp, 0, 0);

    // rawBase would be 5.0 * 0.5 = 2.5, clamped to 0.5
    // multiplier = 1.0 → finalSize = 0.5
    expect(result.size).toBeCloseTo(0.5, 5);
    expect(result.reasoning.baseSize).toBe(0.5);
  });
});

// ---------------------------------------------------------------------------
// Test 2: Per-fixture concurrent position cap
// ---------------------------------------------------------------------------

describe('PositionSizingService — fixture cap', () => {
  it('blocks a second position for the same fixture when cap=1', async () => {
    const service = await buildService({ MAX_CONCURRENT_POSITIONS_PER_FIXTURE: '1' });
    const opp = makeOpportunity({ fixtureId: 'fix-1001' });

    // 1 open position already exists for this fixture
    const result = service.sizePosition(opp, 1, 0);

    expect(result.size).toBe(0);
    expect(result.skipReason).toBe('fixture_cap_exceeded');
    expect(result.reasoning.fixtureCap).toBe('blocked');
    expect(result.reasoning.openPositionsForFixture).toBe(1);
    expect(result.reasoning.finalSize).toBe(0);
  });

  it('allows a position when no open positions exist for the fixture', async () => {
    const service = await buildService();
    const opp = makeOpportunity({ fixtureId: 'fix-1001' });

    const result = service.sizePosition(opp, 0, 0);

    expect(result.size).toBeGreaterThan(0);
    expect(result.skipReason).toBeNull();
    expect(result.reasoning.fixtureCap).toBe('passed');
  });

  it('allows multiple positions when cap is raised to 3', async () => {
    const service = await buildService({ MAX_CONCURRENT_POSITIONS_PER_FIXTURE: '3' });
    const opp = makeOpportunity();

    // 2 open positions — should pass with cap=3
    const result = service.sizePosition(opp, 2, 0);

    expect(result.size).toBeGreaterThan(0);
    expect(result.reasoning.fixtureCap).toBe('passed');
  });
});

// ---------------------------------------------------------------------------
// Test 3: Daily exposure cap
// ---------------------------------------------------------------------------

describe('PositionSizingService — daily exposure cap', () => {
  it('blocks a position that would exceed MAX_DAILY_EXPOSURE', async () => {
    const service = await buildService({
      MAX_DAILY_EXPOSURE: '2.0',
      MAX_POSITION_SIZE: '0.5',
    });
    const opp = makeOpportunity({ divergencePct: 0.20, confidence: 'high' });
    // size would be 0.10; current exposure is already 1.95 → total would be 2.05 > 2.0
    const result = service.sizePosition(opp, 0, 1.95);

    expect(result.size).toBe(0);
    expect(result.skipReason).toBe('daily_exposure_cap_exceeded');
    expect(result.reasoning.dailyExposureCap).toBe('blocked');
    expect(result.reasoning.currentDailyExposure).toBe(1.95);
    expect(result.reasoning.exposureAfterThis).toBeGreaterThan(2.0);
    expect(result.reasoning.finalSize).toBe(0);
  });

  it('allows a position that fits within the daily exposure cap', async () => {
    const service = await buildService({ MAX_DAILY_EXPOSURE: '2.0' });
    const opp = makeOpportunity({ divergencePct: 0.15, confidence: 'high' });
    // size = 0.075; current = 1.9 → total = 1.975 < 2.0
    const result = service.sizePosition(opp, 0, 1.9);

    expect(result.size).toBeCloseTo(0.075, 5);
    expect(result.skipReason).toBeNull();
    expect(result.reasoning.dailyExposureCap).toBe('passed');
  });

  it('logs the full exposure breakdown in reasoning', async () => {
    const service = await buildService({ MAX_DAILY_EXPOSURE: '2.0' });
    const opp = makeOpportunity({ divergencePct: 0.15, confidence: 'high' });
    const result = service.sizePosition(opp, 0, 1.0);

    expect(result.reasoning.currentDailyExposure).toBe(1.0);
    expect(result.reasoning.maxDailyExposure).toBe(2.0);
    expect(result.reasoning.exposureAfterThis).toBeCloseTo(1.075, 5);
  });
});

// ---------------------------------------------------------------------------
// Test 4: Reasoning completeness — every field present
// ---------------------------------------------------------------------------

describe('PositionSizingService — reasoning log completeness', () => {
  it('always includes every reasoning field regardless of outcome', async () => {
    const service = await buildService();
    const opp = makeOpportunity();
    const result = service.sizePosition(opp, 0, 0);
    const r = result.reasoning;

    const requiredFields: Array<keyof typeof r> = [
      'opportunityId', 'fixtureId', 'outcome',
      'divergencePct', 'confidence',
      'maxPositionSize', 'baseSize', 'confidenceMultiplier', 'sizedBeforeCaps',
      'maxConcurrentPerFixture', 'openPositionsForFixture', 'fixtureCap',
      'maxDailyExposure', 'currentDailyExposure', 'exposureAfterThis', 'dailyExposureCap',
      'finalSize', 'skipReason', 'decidedAt',
    ];

    for (const field of requiredFields) {
      expect(r).toHaveProperty(field);
    }
  });

  it('includes all fields when position is skipped', async () => {
    const service = await buildService();
    const opp = makeOpportunity();
    // Trigger fixture cap
    const result = service.sizePosition(opp, 1, 0);

    expect(result.reasoning.opportunityId).toBe('opp-001');
    expect(result.reasoning.skipReason).toBe('fixture_cap_exceeded');
    expect(result.reasoning.decidedAt).toBeTruthy();
  });
});
