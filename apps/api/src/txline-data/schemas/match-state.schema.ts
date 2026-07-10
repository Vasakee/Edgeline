import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type MatchStateDocument = HydratedDocument<MatchState>;

@Schema({ collection: 'match_states', timestamps: false })
export class MatchState {
  /** TxLINE fixture ID */
  @Prop({ required: true })
  fixtureId!: string;

  /** Home team name (from fixture snapshot, Participant1IsHome mapping) */
  @Prop({ type: String, default: null })
  homeTeam!: string | null;

  /** Away team name */
  @Prop({ type: String, default: null })
  awayTeam!: string | null;

  /** Match minute from dataSoccer.Minutes (null if not yet started or unavailable) */
  @Prop({ type: Number, default: null })
  minute!: number | null;

  /** Game state code from statusSoccerId, e.g. 'H1', 'HT', 'H2', 'F' */
  @Prop({ type: String, default: null })
  gameState!: string | null;

  /** Home team total goals (from scoreSoccer.Participant1.Total.Goals) */
  @Prop({ required: true, default: 0 })
  homeScore!: number;

  /** Away team total goals (from scoreSoccer.Participant2.Total.Goals) */
  @Prop({ required: true, default: 0 })
  awayScore!: number;

  /**
   * _id: false suppresses the Mongoose subdocument _id that otherwise
   * appears nested inside redCards in the raw document output.
   */
  @Prop({
    type: {
      _id: false,
      home: { type: Number, default: 0 },
      away: { type: Number, default: 0 },
    },
    default: { home: 0, away: 0 },
  })
  redCards!: { home: number; away: number };

  @Prop({ required: true })
  updatedAt!: Date;
}

export const MatchStateSchema = SchemaFactory.createForClass(MatchState);

MatchStateSchema.index({ fixtureId: 1 }, { unique: true });
