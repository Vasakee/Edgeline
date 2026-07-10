import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type PositionDocument = HydratedDocument<Position>;

/**
 * Position status values:
 *   pending   — sized and approved, waiting for execution phase
 *   executed  — submitted to on-chain / simulated execution
 *   failed    — execution attempted but failed
 *   settled   — match finished, pnl calculated
 *   skipped   — size was 0 due to a cap or policy; logged for audit trail
 */
export type PositionStatus = 'pending' | 'executed' | 'failed' | 'settled' | 'skipped';

@Schema({ collection: 'positions', timestamps: false })
export class Position {
  /** Reference to the Opportunity that triggered this decision */
  @Prop({ type: Types.ObjectId, ref: 'Opportunity', required: true, index: true })
  opportunityId!: Types.ObjectId;

  @Prop({ required: true, index: true })
  fixtureId!: string;

  @Prop({ required: false, default: '' })
  homeTeam!: string;

  @Prop({ required: false, default: '' })
  awayTeam!: string;

  /** Outcome we are backing: 'home' | 'draw' | 'away' */
  @Prop({ required: true })
  outcome!: string;

  /**
   * Notional position size in devnet SOL-equivalent units.
   * 0 means the position was evaluated but skipped (see status='skipped').
   */
  @Prop({ required: true })
  size!: number;

  @Prop({ required: true })
  status!: PositionStatus;

  /**
   * Realised PnL once the match settles.
   * null until status transitions to 'settled'.
   */
  @Prop({ type: Number, default: null })
  pnl!: number | null;

  @Prop({ required: true, index: true })
  decidedAt!: Date;

  /**
   * On-chain transaction signature set by SolanaExecutionService on success.
   * null until status transitions to 'executed'.
   */
  @Prop({ type: String, default: null })
  txSignature!: string | null;

  /**
   * Full structured reasoning from the position-sizing engine.
   * Stored verbatim for audit, debugging, and judging evidence.
   */
  @Prop({ type: Object, required: true })
  reasoning!: Record<string, unknown>;
}

export const PositionSchema = SchemaFactory.createForClass(Position);

PositionSchema.index({ fixtureId: 1, decidedAt: -1 });
