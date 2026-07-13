import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

// =============================================================================
// Types
// =============================================================================

export interface OpportunityInput {
  opportunityId: string;
  fixtureId: string;
  outcome: string;
  divergencePct: number;
  confidence: 'low' | 'medium' | 'high';
  /** Market's implied probability for this outcome — needed for PnL computation at settlement */
  marketProb: number;
}

export type SkipReason =
  | 'fixture_cap_exceeded'
  | 'daily_exposure_cap_exceeded'
  | null;

export interface PositionDecision {
  /** Final position size in notional units (0 = skipped) */
  size: number;
  /** Non-null only when size === 0 */
  skipReason: SkipReason;
  /** Complete breakdown of every step — stored verbatim in Position.reasoning */
  reasoning: PositionReasoning;
}

export interface PositionReasoning {
  opportunityId: string;
  fixtureId: string;
  outcome: string;
  // --- Inputs ---
  divergencePct: number;
  confidence: string;
  /** Market's implied probability for this outcome — used by settlement PnL formula */
  marketProb: number;
  // --- Sizing steps ---
  maxPositionSize: number;
  baseSize: number;             // before confidence multiplier
  confidenceMultiplier: number;
  sizedBeforeCaps: number;      // after multiplier, before cap checks
  // --- Cap checks ---
  maxConcurrentPerFixture: number;
  openPositionsForFixture: number;
  fixtureCap: 'passed' | 'blocked';
  maxDailyExposure: number;
  currentDailyExposure: number;
  exposureAfterThis: number;
  dailyExposureCap: 'passed' | 'blocked';
  // --- Final decision ---
  finalSize: number;
  skipReason: SkipReason;
  decidedAt: string; // ISO timestamp
}

// =============================================================================
// Constants — documented for submission
// =============================================================================

/**
 * DIVERGENCE_SCALE_FACTOR
 *
 * The base position size scales linearly with divergence:
 *   baseSize = divergencePct × DIVERGENCE_SCALE_FACTOR × maxPositionSize
 *
 * A divergence of exactly 1.0 (100pp — impossible in practice, but the
 * theoretical maximum) would produce a position of maxPositionSize.
 * A realistic high-confidence divergence of 0.20 (20pp) produces:
 *   baseSize = 0.20 × 1.0 × maxPositionSize = 20% of max.
 *
 * This linear relationship is intentionally conservative: we don't use
 * a convex function (e.g. divergence²) because the model's edge estimates
 * are uncertain at hackathon time, and linear scaling limits downside.
 */
const DIVERGENCE_SCALE_FACTOR = 1.0;

/**
 * CONFIDENCE_MULTIPLIERS
 *
 * Applied on top of the linear base size. Values chosen to reflect:
 *   low    (0.3×): Edge is above noise threshold but context is weak.
 *                  Size is reduced to 30% — enough to have skin in the game
 *                  but not enough to matter if the signal is false.
 *   medium (0.7×): Meaningful edge with some context support.
 *   high   (1.0×): Strong edge, late-game or large divergence. Full size.
 */
export const CONFIDENCE_MULTIPLIERS: Record<string, number> = {
  low: 0.3,
  medium: 0.7,
  high: 1.0,
};

// =============================================================================
// Service
// =============================================================================

@Injectable()
export class PositionSizingService {
  private readonly logger = new Logger(PositionSizingService.name);

  /**
   * MAX_POSITION_SIZE (env: MAX_POSITION_SIZE, default 0.5)
   * Maximum notional position size in devnet SOL-equivalent units.
   * On devnet this is a simulation — no real funds are at risk.
   * The default of 0.5 SOL keeps devnet transactions small enough to
   * fund comfortably from a 2 SOL airdrop.
   */
  readonly maxPositionSize: number;

  /**
   * MAX_DAILY_EXPOSURE (env: MAX_DAILY_EXPOSURE, default 2.0)
   * Sum of all open position sizes in a rolling 24-hour window.
   * Once this cap is hit, new positions are skipped until existing ones
   * settle, reducing the agent's aggregate risk exposure.
   */
  readonly maxDailyExposure: number;

  /**
   * MAX_CONCURRENT_POSITIONS_PER_FIXTURE (env: MAX_CONCURRENT_POSITIONS_PER_FIXTURE, default 1)
   * Prevents the agent from piling into the same fixture with multiple
   * overlapping positions. One active position per fixture is the rule —
   * the agent should let an existing position play out before opening another.
   */
  readonly maxConcurrentPerFixture: number;

  constructor(private readonly config: ConfigService) {
    this.maxPositionSize = parseFloat(
      this.config.get<string>('MAX_POSITION_SIZE') ?? '0.5',
    );
    this.maxDailyExposure = parseFloat(
      this.config.get<string>('MAX_DAILY_EXPOSURE') ?? '2.0',
    );
    this.maxConcurrentPerFixture = parseInt(
      this.config.get<string>('MAX_CONCURRENT_POSITIONS_PER_FIXTURE') ?? '1',
      10,
    );
    this.logger.log(
      `[startup] Sizing Config Loaded: ` +
        `MAX_POSITION_SIZE=${this.maxPositionSize}, ` +
        `MAX_DAILY_EXPOSURE=${this.maxDailyExposure}, ` +
        `MAX_CONCURRENT_POSITIONS_PER_FIXTURE=${this.maxConcurrentPerFixture}, ` +
        `CONFIDENCE_MULTIPLIERS=${JSON.stringify(CONFIDENCE_MULTIPLIERS)}`,
    );
  }

  /**
   * sizePosition
   *
   * Pure sizing logic — all state (open positions, current exposure) is passed
   * in as arguments so the function is deterministic and unit-testable without
   * database access.
   *
   * Steps:
   *   1. Compute base size from divergence (linear scale)
   *   2. Apply confidence multiplier
   *   3. Check per-fixture concurrent position cap
   *   4. Check global daily exposure cap
   *   5. Return final size (or 0 with skip reason)
   *
   * @param opportunity           The detected opportunity
   * @param openPositionsForFixture  Count of non-settled positions for this fixture
   * @param currentDailyExposure  Sum of sizes of all non-settled positions today
   */
  sizePosition(
    opportunity: OpportunityInput,
    openPositionsForFixture: number,
    currentDailyExposure: number,
  ): PositionDecision {
    // ── Step 1: Base size from divergence ────────────────────────────────────
    //
    // baseSize = divergencePct × DIVERGENCE_SCALE_FACTOR × maxPositionSize
    // Capped at maxPositionSize before multiplier to prevent edge case overflow.
    const rawBase = opportunity.divergencePct * DIVERGENCE_SCALE_FACTOR * this.maxPositionSize;
    const baseSize = Math.min(rawBase, this.maxPositionSize);

    // ── Step 2: Confidence multiplier ────────────────────────────────────────
    const multiplier = CONFIDENCE_MULTIPLIERS[opportunity.confidence] ?? 0.3;
    const sizedBeforeCaps = +(baseSize * multiplier).toFixed(6);

    // ── Step 3: Per-fixture cap ───────────────────────────────────────────────
    const fixtureCapped = openPositionsForFixture >= this.maxConcurrentPerFixture;

    // ── Step 4: Daily exposure cap ────────────────────────────────────────────
    const exposureAfterThis = currentDailyExposure + sizedBeforeCaps;
    const exposureCapped = exposureAfterThis > this.maxDailyExposure;

    let skipReason: SkipReason = null;
    if (fixtureCapped) {
      skipReason = 'fixture_cap_exceeded';
    } else if (exposureCapped) {
      skipReason = 'daily_exposure_cap_exceeded';
    }

    // ── Step 5: Full reasoning log ────────────────────────────────────────────
    this.logger.log(
      `[sizing-reasoning] Deciding on opportunity=${opportunity.opportunityId}: ` +
        `divergencePct=${opportunity.divergencePct} (${(opportunity.divergencePct * 100).toFixed(2)}%), ` +
        `confidenceTier=${opportunity.confidence}, ` +
        `confidenceMultiplierApplied=${multiplier}, ` +
        `rawCalculatedSizeBeforeCaps=${sizedBeforeCaps}, ` +
        `MAX_POSITION_SIZE=${this.maxPositionSize}, ` +
        `openPositionsForFixture=${openPositionsForFixture} (cap=${this.maxConcurrentPerFixture}), ` +
        `currentDailyExposure=${currentDailyExposure} (cap=${this.maxDailyExposure}), ` +
        `fixtureCapped=${fixtureCapped}, ` +
        `exposureCapped=${exposureCapped}, ` +
        `evalChecks={` +
          `confidenceTooLow: ${opportunity.confidence === 'low' ? 'yes (applied 0.3x multiplier)' : 'no'}, ` +
          `sizeCalculatedAs0: ${sizedBeforeCaps === 0 ? 'yes' : 'no'}, ` +
          `perFixtureCapExceeded: ${fixtureCapped ? 'yes' : 'no'}, ` +
          `dailyExposureCapExceeded: ${exposureCapped ? 'yes' : 'no'}, ` +
          `walletBalanceCheckFailed: deferred to execution` +
        `}, ` +
        `finalDecision=${skipReason ? `SKIP (${skipReason})` : `EXECUTE (size=${sizedBeforeCaps})`}`
    );

    if (fixtureCapped) {
      const reasoning = this.buildReasoning(
        opportunity,
        baseSize,
        multiplier,
        sizedBeforeCaps,
        openPositionsForFixture,
        currentDailyExposure,
        'fixture_cap_exceeded',
      );
      this.logger.warn(
        `[sizing] SKIP fixture_cap opportunity=${opportunity.opportunityId} ` +
          `fixture=${opportunity.fixtureId} ` +
          `openPositions=${openPositionsForFixture}/${this.maxConcurrentPerFixture}`,
      );
      return { size: 0, skipReason: 'fixture_cap_exceeded', reasoning };
    }

    if (exposureCapped) {
      const reasoning = this.buildReasoning(
        opportunity,
        baseSize,
        multiplier,
        sizedBeforeCaps,
        openPositionsForFixture,
        currentDailyExposure,
        'daily_exposure_cap_exceeded',
      );
      this.logger.warn(
        `[sizing] SKIP daily_exposure_cap opportunity=${opportunity.opportunityId} ` +
          `currentExposure=${currentDailyExposure.toFixed(3)} ` +
          `wouldBecome=${exposureAfterThis.toFixed(3)} ` +
          `cap=${this.maxDailyExposure}`,
      );
      return { size: 0, skipReason: 'daily_exposure_cap_exceeded', reasoning };
    }

    const reasoning = this.buildReasoning(
      opportunity,
      baseSize,
      multiplier,
      sizedBeforeCaps,
      openPositionsForFixture,
      currentDailyExposure,
      null,
    );

    this.logger.log(
      `[sizing] APPROVED opportunity=${opportunity.opportunityId} ` +
        `fixture=${opportunity.fixtureId} outcome=${opportunity.outcome} ` +
        `divergence=${(opportunity.divergencePct * 100).toFixed(1)}pp ` +
        `confidence=${opportunity.confidence} ` +
        `size=${sizedBeforeCaps} ` +
        `dailyExposure=${currentDailyExposure.toFixed(3)}→${exposureAfterThis.toFixed(3)}/${this.maxDailyExposure}`,
    );

    return { size: sizedBeforeCaps, skipReason: null, reasoning };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private buildReasoning(
    opportunity: OpportunityInput,
    baseSize: number,
    confidenceMultiplier: number,
    sizedBeforeCaps: number,
    openPositionsForFixture: number,
    currentDailyExposure: number,
    skipReason: SkipReason,
  ): PositionReasoning {
    const exposureAfterThis = currentDailyExposure + sizedBeforeCaps;
    const fixtureCapped = openPositionsForFixture >= this.maxConcurrentPerFixture;
    const dailyExposureCapped =
      skipReason === 'daily_exposure_cap_exceeded' ||
      (skipReason === null && exposureAfterThis > this.maxDailyExposure);

    return {
      opportunityId: opportunity.opportunityId,
      fixtureId: opportunity.fixtureId,
      outcome: opportunity.outcome,
      divergencePct: opportunity.divergencePct,
      confidence: opportunity.confidence,
      marketProb: opportunity.marketProb,
      maxPositionSize: this.maxPositionSize,
      baseSize: +baseSize.toFixed(6),
      confidenceMultiplier,
      sizedBeforeCaps,
      maxConcurrentPerFixture: this.maxConcurrentPerFixture,
      openPositionsForFixture,
      fixtureCap: fixtureCapped ? 'blocked' : 'passed',
      maxDailyExposure: this.maxDailyExposure,
      currentDailyExposure,
      exposureAfterThis: +exposureAfterThis.toFixed(6),
      dailyExposureCap: dailyExposureCapped ? 'blocked' : 'passed',
      finalSize: skipReason ? 0 : sizedBeforeCaps,
      skipReason,
      decidedAt: new Date().toISOString(),
    };
  }
}
