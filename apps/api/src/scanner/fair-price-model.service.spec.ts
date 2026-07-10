/**
 * fair-price-model.service.spec.ts
 *
 * Unit tests for the fair-price model pure function.
 * Tests run entirely without NestJS — computeFairProbability is a pure function.
 */
import {
  computeFairProbability,
  normalise,
  MatchStateInput,
  PreMatchOdds,
} from './fair-price-model.service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Baseline pre-match odds for a roughly even match */
const EVEN_MATCH: PreMatchOdds = { home: 0.40, draw: 0.26, away: 0.34 };

/** A pre-match state — no goals, no cards, minute null */
function preMatchState(): MatchStateInput {
  return {
    minute: null,
    gameState: null,
    homeScore: 0,
    awayScore: 0,
    redCards: { home: 0, away: 0 },
  };
}

function inPlayState(
  minute: number,
  homeScore = 0,
  awayScore = 0,
  homeRed = 0,
  awayRed = 0,
  gameState = 'H1',
): MatchStateInput {
  return { minute, gameState, homeScore, awayScore, redCards: { home: homeRed, away: awayRed } };
}

// ---------------------------------------------------------------------------
// 1. Pre-match / no state → returns prior unchanged
// ---------------------------------------------------------------------------

describe('computeFairProbability — kickoff / no match state', () => {
  it('returns the prior exactly when minute is null', () => {
    const result = computeFairProbability(preMatchState(), EVEN_MATCH);
    // After normalise() the prior sums to 1.0 already, so output ≈ input
    expect(result.home).toBeCloseTo(EVEN_MATCH.home, 3);
    expect(result.draw).toBeCloseTo(EVEN_MATCH.draw, 3);
    expect(result.away).toBeCloseTo(EVEN_MATCH.away, 3);
  });

  it('returns the prior unchanged when game state is "F" (finished)', () => {
    const state: MatchStateInput = {
      minute: 90,
      gameState: 'F',
      homeScore: 1,
      awayScore: 0,
      redCards: { home: 0, away: 0 },
    };
    const result = computeFairProbability(state, EVEN_MATCH);
    expect(result.home).toBeCloseTo(EVEN_MATCH.home, 3);
    expect(result.draw).toBeCloseTo(EVEN_MATCH.draw, 3);
    expect(result.away).toBeCloseTo(EVEN_MATCH.away, 3);
  });
});

// ---------------------------------------------------------------------------
// 2. Home team 1-0 up at minute 5 — minimal shift
// ---------------------------------------------------------------------------

describe('computeFairProbability — home leading early', () => {
  it('shifts home probability up but only slightly at minute 5', () => {
    const state = inPlayState(5, 1, 0);
    const result = computeFairProbability(state, EVEN_MATCH);

    // Home should be higher than prior, but the early-game weight means shift is small
    expect(result.home).toBeGreaterThan(EVEN_MATCH.home);
    // At minute 5 (weight = 5/90 ≈ 0.056), shift ≈ 1 * 0.15 * 0.056 ≈ 0.0083
    // So home should be roughly 0.40 + small delta
    expect(result.home).toBeLessThan(0.45);

    // Away and draw should be lower
    expect(result.away).toBeLessThan(EVEN_MATCH.away);
    expect(result.draw).toBeLessThan(EVEN_MATCH.draw);
  });
});

// ---------------------------------------------------------------------------
// 3. Home team 1-0 up at minute 85 — large shift
// ---------------------------------------------------------------------------

describe('computeFairProbability — home leading late', () => {
  it('heavily favours home win with 1-0 lead at minute 85', () => {
    const state = inPlayState(85, 1, 0);
    const result = computeFairProbability(state, EVEN_MATCH);

    // timeWeight = 85/90 ≈ 0.944; shift ≈ 0.15 * 0.944 ≈ 0.142
    // home ≈ 0.40 + 0.142 ≈ 0.542 before normalisation
    expect(result.home).toBeGreaterThan(0.50);
    expect(result.away).toBeLessThan(EVEN_MATCH.away);
    expect(result.draw).toBeLessThan(EVEN_MATCH.draw);
  });

  it('produces a larger home advantage at minute 85 than at minute 5 for same scoreline', () => {
    const earlyResult = computeFairProbability(inPlayState(5, 1, 0), EVEN_MATCH);
    const lateResult = computeFairProbability(inPlayState(85, 1, 0), EVEN_MATCH);
    expect(lateResult.home).toBeGreaterThan(earlyResult.home);
    expect(lateResult.away).toBeLessThan(earlyResult.away);
  });
});

// ---------------------------------------------------------------------------
// 4. Away team 2-0 up at minute 70 — strong away signal
// ---------------------------------------------------------------------------

describe('computeFairProbability — away team leading', () => {
  it('strongly favours away win with 2-0 lead at minute 70', () => {
    const state = inPlayState(70, 0, 2, 0, 0, 'H2');
    const result = computeFairProbability(state, EVEN_MATCH);

    // goalDiff = -2; shift = -2 * 0.15 * (70/90) ≈ -0.233
    // away increases significantly
    expect(result.away).toBeGreaterThan(0.55);
    expect(result.home).toBeLessThan(EVEN_MATCH.home);
  });
});

// ---------------------------------------------------------------------------
// 5. Red card scenarios
// ---------------------------------------------------------------------------

describe('computeFairProbability — red card scenarios', () => {
  it('reduces home win probability when home team gets a red card at minute 60', () => {
    const noCard = computeFairProbability(inPlayState(60, 0, 0, 0, 0), EVEN_MATCH);
    const homeRedCard = computeFairProbability(inPlayState(60, 0, 0, 1, 0), EVEN_MATCH);

    expect(homeRedCard.home).toBeLessThan(noCard.home);
    expect(homeRedCard.away).toBeGreaterThan(noCard.away);
  });

  it('reduces away win probability when away team gets a red card at minute 75', () => {
    const noCard = computeFairProbability(inPlayState(75, 0, 0, 0, 0), EVEN_MATCH);
    const awayRedCard = computeFairProbability(inPlayState(75, 0, 0, 0, 1), EVEN_MATCH);

    expect(awayRedCard.away).toBeLessThan(noCard.away);
    expect(awayRedCard.home).toBeGreaterThan(noCard.home);
  });

  it('goal + opposing red card compound the same direction', () => {
    // Home 1-0 up AND away team has a red card at minute 75
    const justGoal = computeFairProbability(inPlayState(75, 1, 0, 0, 0), EVEN_MATCH);
    const goalAndRed = computeFairProbability(inPlayState(75, 1, 0, 0, 1), EVEN_MATCH);

    expect(goalAndRed.home).toBeGreaterThan(justGoal.home);
  });
});

// ---------------------------------------------------------------------------
// 6. Normalisation invariant — home + draw + away always = 1.0
// ---------------------------------------------------------------------------

describe('computeFairProbability — normalisation', () => {
  const cases: Array<[string, MatchStateInput]> = [
    ['pre-match', preMatchState()],
    ['early goal', inPlayState(10, 1, 0)],
    ['late goal + red card', inPlayState(82, 2, 1, 0, 1, 'H2')],
    ['massive scoreline', inPlayState(88, 4, 0)],
    ['away 3-0 up late', inPlayState(85, 0, 3, 0, 0, 'H2')],
  ];

  test.each(cases)('sums to 1.0 — %s', (_label, state) => {
    const result = computeFairProbability(state, EVEN_MATCH);
    const sum = result.home + result.draw + result.away;
    expect(sum).toBeCloseTo(1.0, 10);
  });

  it('all outcomes stay above the 0.01 floor even for extreme scorelines', () => {
    // 5-0 at minute 89 — home should be very high but away/draw should not collapse to zero
    const result = computeFairProbability(inPlayState(89, 5, 0), EVEN_MATCH);
    expect(result.home).toBeGreaterThan(0.01);
    // After clamping to [0.01, 0.98] and renormalising, draw and away are at the floor
    expect(result.draw).toBeGreaterThanOrEqual(0.01 / (0.98 + 0.01 + 0.01));
    expect(result.away).toBeGreaterThanOrEqual(0.01 / (0.98 + 0.01 + 0.01));
  });
});

// ---------------------------------------------------------------------------
// 7. Normalise utility
// ---------------------------------------------------------------------------

describe('normalise()', () => {
  it('rescales in-range values to sum to 1.0 with correct proportions', () => {
    // 0.6 + 0.2 + 0.2 = 1.0 already, but normalise should still work correctly
    // Use 0.6, 0.3, 0.1 (all within [0.01, 0.98]) — home should be exactly 0.6
    const result = normalise({ home: 0.6, draw: 0.3, away: 0.1 });
    expect(result.home + result.draw + result.away).toBeCloseTo(1.0, 10);
    expect(result.home).toBeCloseTo(0.6, 3);
    expect(result.draw).toBeCloseTo(0.3, 3);
    expect(result.away).toBeCloseTo(0.1, 3);
  });

  it('clamps probabilities below 0.01 to the floor', () => {
    const result = normalise({ home: 0.99, draw: 0.0001, away: 0.0001 });
    expect(result.draw).toBeGreaterThanOrEqual(0.01 / 1.01); // after normalisation of clamped value
  });
});
