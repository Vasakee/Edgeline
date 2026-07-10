import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type OpportunityDocument = HydratedDocument<Opportunity>;

@Schema({ collection: 'opportunities', timestamps: false })
export class Opportunity {
  @Prop({ required: true, index: true })
  fixtureId!: string;

  @Prop({ required: false, default: '' })
  homeTeam!: string;

  @Prop({ required: false, default: '' })
  awayTeam!: string;

  /** The outcome the model is betting on: 'home' | 'draw' | 'away' */
  @Prop({ required: true })
  outcome!: string;

  /** Our fair-price model's probability for this outcome (0–1) */
  @Prop({ required: true })
  modelProb!: number;

  /** The market's (TxLINE StablePrice) implied probability for this outcome (0–1) */
  @Prop({ required: true })
  marketProb!: number;

  /**
   * Absolute divergence: modelProb - marketProb.
   * Positive = model thinks outcome is more likely than market.
   * Negative = model thinks outcome is less likely (value on the other side).
   */
  @Prop({ required: true })
  divergencePct!: number;

  /** Confidence level based on divergence magnitude and match context */
  @Prop({ required: true })
  confidence!: string;

  @Prop({ required: true, index: true })
  detectedAt!: Date;

  /** Whether the agent has acted on this opportunity (default false) */
  @Prop({ required: true, default: false })
  actedOn!: boolean;

  /** Snapshot of the match state at detection time — for audit / replay */
  @Prop({ type: Object, required: true })
  matchStateSnapshot!: Record<string, unknown>;
}

export const OpportunitySchema = SchemaFactory.createForClass(Opportunity);

OpportunitySchema.index({ fixtureId: 1, detectedAt: -1 });
