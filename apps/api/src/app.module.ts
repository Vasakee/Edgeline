import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { HealthModule } from './health/health.module';
import { TxlineAuthModule } from './txline-auth/txline-auth.module';
import { TxlineDataModule } from './txline-data/txline-data.module';
import { ScannerModule } from './scanner/scanner.module';
import { DecisionModule } from './decision/decision.module';
import { ExecutionModule } from './execution/execution.module';
import { OrchestrationModule } from './orchestration/orchestration.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: '.env' }),
    MongooseModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        uri: config.get<string>('MONGODB_URI') ?? 'mongodb://localhost:27017/edgeline',
      }),
    }),
    EventEmitterModule.forRoot(),
    HealthModule,
    TxlineAuthModule,
    TxlineDataModule,
    ScannerModule,
    DecisionModule,
    ExecutionModule,
    OrchestrationModule,
  ],
})
export class AppModule {}
