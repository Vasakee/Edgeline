import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  OPPORTUNITY_DETECTED_EVENT,
  OpportunityDetectedPayload,
} from '../scanner/scanner.service';
import { PositionSizingService } from './position-sizing.service';
import { Position, PositionDocument } from './schemas/position.schema';

export const POSITION_APPROVED_EVENT = 'position.approved';

export interface PositionApprovedPayload {
  fixtureId: string;
  position: PositionDocument;
}

@Injectable()
export class DecisionService {
  private readonly logger = new Logger(DecisionService.name);

  constructor(
    private readonly sizing: PositionSizingService,
    private readonly eventEmitter: EventEmitter2,
    @InjectModel(Position.name)
    private readonly positionModel: Model<PositionDocument>,
  ) {}

  @OnEvent(OPPORTUNITY_DETECTED_EVENT)
  async handleOpportunityDetected(payload: OpportunityDetectedPayload): Promise<void> {
    const { opportunity } = payload;
    const oppId = (opportunity._id as Types.ObjectId).toHexString();

    this.logger.log(
      `[decision] received opportunity=${oppId} ` +
        `fixture=${opportunity.fixtureId} outcome=${opportunity.outcome} ` +
        `divergence=${(opportunity.divergencePct * 100).toFixed(1)}pp ` +
        `confidence=${opportunity.confidence}`,
    );

    // ── 1. Query open positions for this fixture (non-settled, non-skipped) ──
    const openForFixture = await this.positionModel.countDocuments({
      fixtureId: opportunity.fixtureId,
      status: { $in: ['pending', 'executed'] },
    });

    // ── 2. Query today's total exposure ──────────────────────────────────────
    const dayStart = new Date();
    dayStart.setUTCHours(0, 0, 0, 0);

    const exposureAgg = await this.positionModel.aggregate<{ total: number }>([
      {
        $match: {
          status: { $in: ['pending', 'executed'] },
          decidedAt: { $gte: dayStart },
        },
      },
      { $group: { _id: null, total: { $sum: '$size' } } },
    ]);
    const currentDailyExposure = exposureAgg[0]?.total ?? 0;

    // ── 3. Run position sizing ────────────────────────────────────────────────
    const decision = this.sizing.sizePosition(
      {
        opportunityId: oppId,
        fixtureId: opportunity.fixtureId,
        outcome: opportunity.outcome,
        divergencePct: opportunity.divergencePct,
        confidence: opportunity.confidence as 'low' | 'medium' | 'high',
        marketProb: opportunity.marketProb,
      },
      openForFixture,
      currentDailyExposure,
    );

    // ── 4. Persist the Position (every decision, including skips) ─────────────
    const status = decision.size > 0 ? 'pending' : 'skipped';

    const position = await this.positionModel.create({
      opportunityId: opportunity._id,
      fixtureId: opportunity.fixtureId,
      homeTeam: (opportunity as any).homeTeam ?? '',
      awayTeam: (opportunity as any).awayTeam ?? '',
      outcome: opportunity.outcome,
      size: decision.size,
      status,
      pnl: null,
      decidedAt: new Date(),
      reasoning: decision.reasoning,
    });

    const posId = (position._id as Types.ObjectId).toHexString();

    if (decision.size === 0) {
      // Skipped — log with full reason so nothing is silently dropped
      this.logger.warn(
        `[decision] SKIPPED position=${posId} ` +
          `opportunity=${oppId} ` +
          `reason=${decision.skipReason} ` +
          `fixture=${opportunity.fixtureId}`,
      );
      return;
    }

    // ── 5. Emit position.approved for the execution module ────────────────────
    this.logger.log(
      `[decision] APPROVED position=${posId} ` +
        `fixture=${opportunity.fixtureId} outcome=${opportunity.outcome} ` +
        `size=${decision.size} status=pending`,
    );

    const approvedPayload: PositionApprovedPayload = {
      fixtureId: opportunity.fixtureId,
      position,
    };
    this.eventEmitter.emit(POSITION_APPROVED_EVENT, approvedPayload);
  }
}
