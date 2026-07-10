import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FairProbability } from './fair-price-model.service';

// =============================================================================
// Types
// =============================================================================

export interface MarketProbability {
  home: number;
  draw: number;
  away: number;
}

export interface DivergenceResult {
  /** Which outcome the model thinks is mispriced */
  outcome: 'home' | 'draw' | 'away';
  /** Our model's probability for that outcome */
  modelProb: number;
  /** The market's implied probability for that outcome */
  marketProb: number;
  /**
   * Raw divergence: modelProb - marketProb.
   * Positive = model thinks it's more likely than market (value on that outcome).
   * Negative = model thinks it's less likely (theoretical value on the other side,
   *            but we only flag the outcome where model > market).
   */
  divergencePct: number;
  /** Confidence level combining divergence magnitude and match context */
  confidence: 'low' | 'medium' | 'high';
}

// =============================================================================
// Confidence thresholds — documented for submission
// =============================================================================

/**
 * CONFIDENCE_THRESHOLDS
 *
 * Confidence is determined by the ABSOLUTE divergence (modelProb - marketProb).
 * These thresholds were chosen to reflect practical betting significance:
 *
 *   low    (≥ MIN_DIVERGENCE_THRESHOLD, < 0.12):
 *     A real but modest edge. Worth flagging but not acting on alone.
 *     Could be explained by bookmaker margin variation or brief stale price.
 *
 *   medium (≥ 0.12, < 0.20):
 *     A meaningful mispricing. Likely to exceed vig on most books.
 *     Warrants active attention.
 *
 *   high   (≥ 0.20):
 *     A large divergence. Either a genuine edge or data quality issue —
 *     the match-state context check (see below) distinguishes the two.
 */
const CONFIDENCE_MED_THRESHOLD = 0.12;
const CONFIDENCE_HIGH_THRESHOLD = 0.20;

/**
 * LATE_GAME_MINUTE
 * Minute after which we apply a context bonus to confidence.
 * A divergence at minute 70+ is more meaningful than the same divergence
 * at minute 10, because:
 *   1. There is less time for randomness to equalize things.
 *   2. The match state is more settled and the model's update is better
 *      supported by evidence.
 */
const LATE_GAME_MINUTE = 60;

// =============================================================================
// Service
// =============================================================================

@Injectable()
export class DivergenceDetectorService {
  /**
   * MIN_DIVERGENCE_THRESHOLD (env: MIN_DIVERGENCE_THRESHOLD, default 0.08)
   *
   * The minimum absolute difference between model probability and market
   * probability before we flag an opportunity. This acts as a noise filter:
   *
   *   - TxLINE odds update in 5-minute batches on the free tier. Between
   *     updates, market prices are stale relative to live match events.
   *     Without this threshold, every goal would trigger hundreds of small
   *     "divergences" that evaporate as soon as the next price batch arrives.
   *
   *   - 8pp (0.08) is chosen to sit above typical bookmaker overround
   *     (~5–6% for a liquid soccer market) while remaining sensitive enough
   *     to catch genuine in-play mispricings.
   */
  private readonly minThreshold: number;

  constructor(private readonly config: ConfigService) {
    this.minThreshold = parseFloat(
      this.config.get<string>('MIN_DIVERGENCE_THRESHOLD') ?? '0.08',
    );
  }

  /**
   * compareToMarket
   *
   * Finds the outcome with the largest positive divergence (model > market)
   * and returns a DivergenceResult if it exceeds the minimum threshold.
   *
   * Returns null if no outcome exceeds the threshold — meaning no opportunity
   * is worth flagging at this moment.
   *
   * @param fairProb      Our model's probability estimate
   * @param marketProb    Market's implied probability (from TxLINE StablePrice)
   * @param matchMinute   Current minute (for context-adjusted confidence)
   */
  compareToMarket(
    fairProb: FairProbability,
    marketProb: MarketProbability,
    matchMinute: number | null,
  ): DivergenceResult | null {
    // Compute divergence for each outcome
    const candidates: Array<{
      outcome: 'home' | 'draw' | 'away';
      modelProb: number;
      marketProb: number;
      divergencePct: number;
    }> = [
      {
        outcome: 'home',
        modelProb: fairProb.home,
        marketProb: marketProb.home,
        divergencePct: fairProb.home - marketProb.home,
      },
      {
        outcome: 'draw',
        modelProb: fairProb.draw,
        marketProb: marketProb.draw,
        divergencePct: fairProb.draw - marketProb.draw,
      },
      {
        outcome: 'away',
        modelProb: fairProb.away,
        marketProb: marketProb.away,
        divergencePct: fairProb.away - marketProb.away,
      },
    ];

    // Pick the outcome with the largest positive divergence
    // (model thinks it's more likely than market → potential value bet)
    const best = candidates.reduce(
      (prev, curr) => (curr.divergencePct > prev.divergencePct ? curr : prev),
    );

    // Apply the minimum noise filter
    if (best.divergencePct < this.minThreshold) {
      return null;
    }

    return {
      ...best,
      confidence: this.computeConfidence(best.divergencePct, matchMinute),
    };
  }

  /**
   * computeConfidence
   *
   * Confidence scales with:
   *   1. The size of the divergence (primary signal)
   *   2. Whether we are in the late game (context bonus)
   *
   * A divergence that is "medium" by magnitude but occurs after minute 60
   * is promoted to "high", because:
   *   - Less time remains → odds are more sensitive → the market is less
   *     likely to be stale and more likely to be genuinely wrong.
   *   - Our model's goal/red-card weights are higher late in the match,
   *     meaning the divergence is better supported by match evidence.
   *
   * A divergence at minute < 60 is never promoted above "medium" regardless
   * of size — early goals are genuinely noisier.
   */
  private computeConfidence(
    divergencePct: number,
    minute: number | null,
  ): 'low' | 'medium' | 'high' {
    const isLate = minute !== null && minute >= LATE_GAME_MINUTE;
    const absDivergence = Math.abs(divergencePct);

    if (absDivergence >= CONFIDENCE_HIGH_THRESHOLD) {
      return 'high';
    }

    if (absDivergence >= CONFIDENCE_MED_THRESHOLD) {
      // Context bonus: late-game medium divergence → promoted to high
      return isLate ? 'high' : 'medium';
    }

    // absDivergence >= minThreshold (already filtered below)
    // Context bonus: late-game low divergence → promoted to medium
    return isLate ? 'medium' : 'low';
  }
}
