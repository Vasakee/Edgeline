import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { PositionSizingService } from './position-sizing.service';
import { DecisionService } from './decision.service';
import { Position, PositionSchema } from './schemas/position.schema';

@Module({
  imports: [
    ConfigModule,
    MongooseModule.forFeature([{ name: Position.name, schema: PositionSchema }]),
  ],
  providers: [PositionSizingService, DecisionService],
  exports: [PositionSizingService, DecisionService],
})
export class DecisionModule {}
