import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { ScheduleModule } from '@nestjs/schedule';
import { TxlineAuthModule } from '../txline-auth/txline-auth.module';
import { TxlineDataModule } from '../txline-data/txline-data.module';
import { AgentLifecycleService } from './agent-lifecycle.service';
import { AgentStatusController } from './agent-status.controller';
import { AgentGateway } from './agent.gateway';
import { Position, PositionSchema } from '../decision/schemas/position.schema';
import { Opportunity, OpportunitySchema } from '../scanner/schemas/opportunity.schema';

@Module({
  imports: [
    ConfigModule,
    ScheduleModule,
    TxlineAuthModule,
    TxlineDataModule,
    MongooseModule.forFeature([
      { name: Position.name, schema: PositionSchema },
      { name: Opportunity.name, schema: OpportunitySchema },
    ]),
  ],
  controllers: [AgentStatusController],
  providers: [AgentLifecycleService, AgentGateway],
  exports: [AgentLifecycleService, AgentGateway],
})
export class OrchestrationModule {}
