import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { FairPriceModelService } from './fair-price-model.service';
import { DivergenceDetectorService } from './divergence-detector.service';
import { Opportunity, OpportunityDocument } from './schemas/opportunity.schema';
import { LiveScore } from '../txline-data/txline-data.service';

// ---------------------------------------------------------------------------
// Event payload type — subscribers (decision engine, execution) receive this
// ---------------------------------------------------------------------------

export interface OpportunityDetectedPayload {
  fixtureId: string;
  opportunity: OpportunityDocument;
}

export const OPPORTUNITY_DETECTED_EVENT = 'opportunity.detected';

// ---------------------------------------------------------------------------
// Input type for the scanner — what the polling scheduler provides
// ---------------------------------------------------------------------------

export interface ScannerInput {
  fixtureId: string;
  homeTeam: string;
  awayTeam: string;
  /** Pre-match implied probs sourced from the earliest odds snapshot for this fixture */
  preMatchOdds: { home: number; draw: number; away: number };
  /** Current live market odds (TxLINE StablePrice consensus) */
  liveMarketOdds: { home: number; draw: number; away: number };
  /** Current match state */
  matchState: LiveScore;
}

@Injectable()
export class ScannerService {
  private readonly logger = new Logger(ScannerService.name);

  constructor(
    private readonly fairPriceModel: FairPriceModelService,
    private readonly divergenceDetector: DivergenceDetectorService,
    private readonly eventEmitter: EventEmitter2,
    @InjectModel(Opportunity.name)
    private readonly opportunityModel: Model<OpportunityDocument>,
  ) {}

  /**
   * scan
   *
   * Orchestrates one full scan cycle for a single fixture:
   *   1. Compute fair probability from match state + pre-match prior
   *   2. Compare to live market (divergence detection)
   *   3. If divergence exceeds threshold → persist Opportunity + emit event
   *
   * Called by TxlineDataScheduler after each successful poll tick.
   * Returns the created Opportunity document, or null if no edge found.
   */
  async scan(input: ScannerInput): Promise<OpportunityDocument | null> {
    // Step 1: Compute our model's fair probability
    const fairProb = this.fairPriceModel.compute(input.matchState, input.preMatchOdds);

    this.logger.debug(
      `[scan] fixture=${input.fixtureId} ` +
        `fairProb=H:${fairProb.home.toFixed(3)} D:${fairProb.draw.toFixed(3)} A:${fairProb.away.toFixed(3)} ` +
        `marketProb=H:${input.liveMarketOdds.home.toFixed(3)} D:${input.liveMarketOdds.draw.toFixed(3)} A:${input.liveMarketOdds.away.toFixed(3)}`,
    );

    // Step 2: Detect divergence
    const divergence = this.divergenceDetector.compareToMarket(
      fairProb,
      input.liveMarketOdds,
      input.matchState.minute,
    );

    if (!divergence) {
      this.logger.debug(`[scan] fixture=${input.fixtureId} — no divergence above threshold`);
      return null;
    }

    this.logger.log(
      `[scan] OPPORTUNITY fixture=${input.fixtureId} ` +
        `outcome=${divergence.outcome} ` +
        `model=${divergence.modelProb.toFixed(3)} ` +
        `market=${divergence.marketProb.toFixed(3)} ` +
        `divergence=+${(divergence.divergencePct * 100).toFixed(1)}pp ` +
        `confidence=${divergence.confidence}`,
    );

    // Deduplication: Check if we flagged this outcome on this fixture in the last 5 minutes
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    const existingOpp = await this.opportunityModel
      .findOne({
        fixtureId: input.fixtureId,
        outcome: divergence.outcome,
        detectedAt: { $gte: fiveMinutesAgo },
      })
      .exec();

    if (existingOpp) {
      this.logger.debug(
        `[scan] DEDUPED: Opportunity for fixture=${input.fixtureId} outcome=${divergence.outcome} already flagged recently (detectedAt=${existingOpp.detectedAt.toISOString()})`,
      );
      return null;
    }

    // Step 3: Persist the Opportunity
    const doc = await this.opportunityModel.create({
      fixtureId: input.fixtureId,
      homeTeam: input.homeTeam,
      awayTeam: input.awayTeam,
      outcome: divergence.outcome,
      modelProb: divergence.modelProb,
      marketProb: divergence.marketProb,
      divergencePct: divergence.divergencePct,
      confidence: divergence.confidence,
      detectedAt: new Date(),
      actedOn: false,
      matchStateSnapshot: input.matchState as unknown as Record<string, unknown>,
    });

    // Step 4: Emit event for downstream consumers (decision engine, execution)
    const payload: OpportunityDetectedPayload = {
      fixtureId: input.fixtureId,
      opportunity: doc,
    };
    this.eventEmitter.emit(OPPORTUNITY_DETECTED_EVENT, payload);

    return doc;
  }
}
