import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { FairPriceModelService } from './fair-price-model.service';
import { DivergenceDetectorService } from './divergence-detector.service';
import { ScannerService } from './scanner.service';
import { Opportunity, OpportunitySchema } from './schemas/opportunity.schema';

@Module({
  imports: [
    ConfigModule,
    MongooseModule.forFeature([
      { name: Opportunity.name, schema: OpportunitySchema },
    ]),
  ],
  providers: [FairPriceModelService, DivergenceDetectorService, ScannerService],
  exports: [ScannerService],
})
export class ScannerModule {}
