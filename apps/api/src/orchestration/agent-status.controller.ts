import { Controller, Get } from '@nestjs/common';
import { Types } from 'mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ConfigService } from '@nestjs/config';
import { AgentLifecycleService } from './agent-lifecycle.service';
import { Position, PositionDocument } from '../decision/schemas/position.schema';
import { Opportunity, OpportunityDocument } from '../scanner/schemas/opportunity.schema';
import { WalletProvider } from '../txline-auth/wallet.provider';

interface AgentStatus {
  agent: string;
  status: 'running' | 'degraded';
  uptime: string;
  startedAt: string;
  wallet: string;
  auth: string;
  fixtures: {
    monitored: number;
    live: number;
    upcoming: number;
  };
  today: {
    opportunitiesDetected: number;
    positionsOpen: number;
    positionsExecuted: number;
    positionsSettled: number;
    positionsFailed: number;
    positionsSkipped: number;
    totalPnl: number;
  };
  exposure: {
    currentDaily: number;
    maxDaily: number;
    utilisation: string;
  };
}

@Controller('agent')
export class AgentStatusController {
  constructor(
    private readonly lifecycle: AgentLifecycleService,
    private readonly walletProvider: WalletProvider,
    private readonly config: ConfigService,
    private readonly eventEmitter: EventEmitter2,
    @InjectModel(Position.name)
    private readonly positionModel: Model<PositionDocument>,
    @InjectModel(Opportunity.name)
    private readonly opportunityModel: Model<OpportunityDocument>,
  ) {}

  @Get('status')
  async getStatus(): Promise<AgentStatus> {
    const dayStart = new Date();
    dayStart.setUTCHours(0, 0, 0, 0);

    // Parallel queries for performance
    const [
      opportunitiesToday,
      positionsOpen,
      positionsExecuted,
      positionsSettled,
      positionsFailed,
      positionsSkipped,
      pnlAgg,
      exposureAgg,
    ] = await Promise.all([
      this.opportunityModel.countDocuments({ detectedAt: { $gte: dayStart } }),
      this.positionModel.countDocuments({
        status: { $in: ['pending', 'executed'] },
        decidedAt: { $gte: dayStart }
      }),
      this.positionModel.countDocuments({
        status: 'executed',
        decidedAt: { $gte: dayStart }
      }),
      this.positionModel.countDocuments({
        status: 'settled',
        'reasoning.settledAt': { $gte: dayStart.toISOString() }
      }),
      this.positionModel.countDocuments({
        status: 'failed',
        decidedAt: { $gte: dayStart }
      }),
      this.positionModel.countDocuments({
        status: 'skipped',
        decidedAt: { $gte: dayStart }
      }),
      this.positionModel.aggregate<{ total: number }>([
        {
          $match: {
            status: 'settled',
            'reasoning.settledAt': { $gte: dayStart.toISOString() }
          }
        },
        { $group: { _id: null, total: { $sum: '$pnl' } } },
      ]),
      this.positionModel.aggregate<{ total: number }>([
        { $match: { status: { $in: ['pending', 'executed'] }, decidedAt: { $gte: dayStart } } },
        { $group: { _id: null, total: { $sum: '$size' } } },
      ]),
    ]);

    const maxDaily = parseFloat(this.config.get<string>('MAX_DAILY_EXPOSURE') ?? '2.0');
    const currentExposure = exposureAgg[0]?.total ?? 0;

    const uptimeMs = this.lifecycle.getUptime();
    const hours = Math.floor(uptimeMs / 3600000);
    const mins = Math.floor((uptimeMs % 3600000) / 60000);

    const liveFixtures = this.lifecycle.activeFixtures.filter(
      (f) => f.gameState && !['NS', 'F', 'FET', 'FPE'].includes(f.gameState),
    );

    return {
      agent: 'edgeline-autonomous-agent',
      status: this.lifecycle.authStatus === 'ok' ? 'running' : 'degraded',
      uptime: `${hours}h ${mins}m`,
      startedAt: this.lifecycle.getStartedAt().toISOString(),
      wallet: this.walletProvider.getPublicKeyBase58(),
      auth: this.lifecycle.authStatus,
      fixtures: {
        monitored: this.lifecycle.activeFixtures.length,
        live: liveFixtures.length,
        upcoming: this.lifecycle.activeFixtures.length - liveFixtures.length,
      },
      today: {
        opportunitiesDetected: opportunitiesToday,
        positionsOpen,
        positionsExecuted,
        positionsSettled,
        positionsFailed,
        positionsSkipped,
        totalPnl: pnlAgg[0]?.total ?? 0,
      },
      exposure: {
        currentDaily: currentExposure,
        maxDaily,
        utilisation: `${((currentExposure / maxDaily) * 100).toFixed(1)}%`,
      },
    };
  }

  @Get('opportunities')
  async getOpportunities() {
    return this.opportunityModel.find().sort({ detectedAt: -1 }).limit(50).exec();
  }

  @Get('positions')
  async getPositions() {
    return this.positionModel.find().sort({ decidedAt: -1 }).limit(50).exec();
  }

  @Get('clear-db')
  async clearDb() {
    await this.opportunityModel.deleteMany({});
    await this.positionModel.deleteMany({});
    return { success: true, message: 'Opportunities and positions cleared successfully' };
  }

  @Get('test-event')
  async triggerTestEvent() {
    const oppId = new Types.ObjectId();
    const mockOpp = {
      _id: oppId,
      fixtureId: '18209181',
      homeTeam: 'France',
      awayTeam: 'Morocco',
      outcome: 'home',
      modelProb: 0.72,
      marketProb: 0.61,
      divergencePct: 0.11,
      confidence: 'high',
      detectedAt: new Date().toISOString(),
      actedOn: false,
      matchStateSnapshot: { homeTeam: 'France', awayTeam: 'Morocco', gameState: 'H1' }
    };

    this.eventEmitter.emit('opportunity.detected', {
      fixtureId: '18209181',
      opportunity: mockOpp as any
    });

    setTimeout(() => {
      const posId = new Types.ObjectId();
      const mockPos = {
        _id: posId,
        fixtureId: '18209181',
        homeTeam: 'France',
        awayTeam: 'Morocco',
        outcome: 'home',
        size: 0.05,
        status: 'pending',
        pnl: null,
        decidedAt: new Date().toISOString(),
        txSignature: null,
        reasoning: {}
      };

      this.eventEmitter.emit('position.approved', {
        fixtureId: '18209181',
        position: mockPos as any
      });

      setTimeout(() => {
        const mockPosExecuted = {
          ...mockPos,
          status: 'executed',
          txSignature: '2GHWdnQuFbqFUh6iqohkYcgoTQzumiDBYURj4co77BfYh193AfhizKLk8ybj6G1VbpXLdPckQCvBoGAW69giFSz2'
        };

        this.eventEmitter.emit('position.updated', mockPosExecuted as any);

        setTimeout(() => {
          const mockPosSettled = {
            ...mockPosExecuted,
            status: 'settled',
            pnl: 0.045
          };

          this.eventEmitter.emit('position.updated', mockPosSettled as any);
        }, 3000);
      }, 2000);
    }, 1000);

    return { success: true };
  }
}
