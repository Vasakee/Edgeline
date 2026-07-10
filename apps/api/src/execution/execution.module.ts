import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { ScheduleModule } from '@nestjs/schedule';
import { TxlineAuthModule } from '../txline-auth/txline-auth.module';
import { TxlineDataModule } from '../txline-data/txline-data.module';
import { SolanaExecutionService } from './solana-execution.service';
import { SettlementService } from './settlement.service';
import { Position, PositionSchema } from '../decision/schemas/position.schema';
import { MatchState, MatchStateSchema } from '../txline-data/schemas/match-state.schema';
import { Opportunity, OpportunitySchema } from '../scanner/schemas/opportunity.schema';

@Module({
  imports: [
    ConfigModule,
    ScheduleModule,
    TxlineAuthModule,
    TxlineDataModule,
    MongooseModule.forFeature([
      { name: Position.name, schema: PositionSchema },
      { name: MatchState.name, schema: MatchStateSchema },
      { name: Opportunity.name, schema: OpportunitySchema },
    ]),
  ],
  providers: [SolanaExecutionService, SettlementService],
  exports: [SolanaExecutionService, SettlementService],
})
export class ExecutionModule {}
