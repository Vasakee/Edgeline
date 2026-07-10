import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { ScheduleModule } from '@nestjs/schedule';
import { TxlineAuthModule } from '../txline-auth/txline-auth.module';
import { ScannerModule } from '../scanner/scanner.module';
import { TxlineDataService } from './txline-data.service';
import { TxlineDataScheduler } from './txline-data.scheduler';
import { OddsSnapshot, OddsSnapshotSchema } from './schemas/odds-snapshot.schema';
import { MatchState, MatchStateSchema } from './schemas/match-state.schema';

@Module({
  imports: [
    ConfigModule,
    ScheduleModule.forRoot(),
    MongooseModule.forFeature([
      { name: OddsSnapshot.name, schema: OddsSnapshotSchema },
      { name: MatchState.name, schema: MatchStateSchema },
    ]),
    TxlineAuthModule,
    ScannerModule,
  ],
  providers: [TxlineDataService, TxlineDataScheduler],
  exports: [TxlineDataService],
})
export class TxlineDataModule {}
