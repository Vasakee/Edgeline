import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type OddsSnapshotDocument = HydratedDocument<OddsSnapshot>;

@Schema({ collection: 'odds_snapshots', timestamps: false })
export class OddsSnapshot {
  /** TxLINE fixture ID (int64 from API, stored as string for safety) */
  @Prop({ required: true, index: true })
  fixtureId!: string;

  @Prop({ required: true })
  homeTeam!: string;

  @Prop({ required: true })
  awayTeam!: string;

  /**
   * Market type string, e.g. '1X2', 'ASIAN_HANDICAP', 'OVER_UNDER'.
   * Derived from the API's SuperOddsType field.
   */
  @Prop({ required: true })
  market!: string;

  /** Bookmaker name (from API Bookmaker field) */
  @Prop({ required: true })
  bookmaker!: string;

  /** Implied probability for home win (0–1), derived from Pct[0] or Prices[0] */
  @Prop({ required: true })
  impliedProbHome!: number;

  /** Implied probability for draw (0–1), derived from Pct[1] or Prices[1] */
  @Prop({ required: true })
  impliedProbDraw!: number;

  /** Implied probability for away win (0–1), derived from Pct[2] or Prices[2] */
  @Prop({ required: true })
  impliedProbAway!: number;

  /** Raw API response payload stored for debugging / reprocessing */
  @Prop({ type: Object, required: true })
  rawResponse!: Record<string, unknown>;

  @Prop({ required: true, index: true })
  fetchedAt!: Date;
}

export const OddsSnapshotSchema = SchemaFactory.createForClass(OddsSnapshot);

// Compound index: look up latest odds for a fixture efficiently
OddsSnapshotSchema.index({ fixtureId: 1, fetchedAt: -1 });
