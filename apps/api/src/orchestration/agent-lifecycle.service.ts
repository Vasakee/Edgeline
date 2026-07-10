import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { TxlineAuthService } from '../txline-auth/txline-auth.service';
import { TxlineDataService, FixtureInfo } from '../txline-data/txline-data.service';
import { WalletProvider } from '../txline-auth/wallet.provider';

@Injectable()
export class AgentLifecycleService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(AgentLifecycleService.name);
  private readonly startedAt = new Date();

  /** Exposed for the status endpoint */
  activeFixtures: FixtureInfo[] = [];
  authStatus: 'pending' | 'ok' | 'failed' = 'pending';
  lastError: string | null = null;

  constructor(
    private readonly auth: TxlineAuthService,
    private readonly dataService: TxlineDataService,
    private readonly walletProvider: WalletProvider,
    private readonly schedulerRegistry: SchedulerRegistry,
  ) {}

  getUptime(): number {
    return Date.now() - this.startedAt.getTime();
  }

  getStartedAt(): Date {
    return this.startedAt;
  }

  async onApplicationBootstrap(): Promise<void> {
    this.logger.log('═══════════════════════════════════════════════════════');
    this.logger.log('  EDGELINE AUTONOMOUS AGENT — BOOTSTRAP');
    this.logger.log('═══════════════════════════════════════════════════════');

    // ── 1. Auth flow ────────────────────────────────────────────────────────
    try {
      this.logger.log('[bootstrap] Step 1/3 — Authenticating with TxLINE…');
      const tokenResult = await this.auth.getValidToken();
      this.authStatus = 'ok';
      this.logger.log(
        `[bootstrap] ✓ TxLINE auth OK — token=${tokenResult.token.slice(0, 20)}…`,
      );
    } catch (err) {
      this.authStatus = 'failed';
      this.lastError = String(err);
      this.logger.error(`[bootstrap] ✗ TxLINE auth FAILED: ${this.lastError}`);
      this.logger.warn('[bootstrap] Agent will continue — polling may retry auth on next cycle');
    }

    // ── 2. Fetch fixture list ────────────────────────────────────────────────
    try {
      this.logger.log('[bootstrap] Step 2/3 — Fetching fixture list…');
      this.activeFixtures = await this.dataService.fetchFixtures();
      this.logger.log(
        `[bootstrap] ✓ ${this.activeFixtures.length} fixtures found`,
      );

      const liveFixtures = this.activeFixtures.filter(
        (f) => f.gameState && !['NS', 'F', 'FET', 'FPE'].includes(f.gameState),
      );
      const upcomingFixtures = this.activeFixtures.filter(
        (f) => !f.gameState || f.gameState === 'NS',
      );

      if (liveFixtures.length > 0) {
        this.logger.log(`[bootstrap]   ▸ ${liveFixtures.length} LIVE:`);
        for (const f of liveFixtures.slice(0, 10)) {
          this.logger.log(
            `[bootstrap]     ${f.homeTeam} vs ${f.awayTeam} [${f.gameState}] (${f.fixtureId})`,
          );
        }
      }
      if (upcomingFixtures.length > 0) {
        this.logger.log(`[bootstrap]   ▸ ${upcomingFixtures.length} upcoming`);
      }
    } catch (err) {
      this.lastError = String(err);
      this.logger.error(`[bootstrap] ✗ Fixture fetch FAILED: ${this.lastError}`);
    }

    // ── 3. Polling is auto-started by TxlineDataScheduler.onModuleInit ──────
    this.logger.log('[bootstrap] Step 3/3 — Polling scheduler is active');

    // ── Banner ──────────────────────────────────────────────────────────────
    this.logger.log('═══════════════════════════════════════════════════════');
    this.logger.log(`  AGENT IS LIVE AND AUTONOMOUS`);
    this.logger.log(`  Wallet:   ${this.walletProvider.getPublicKeyBase58()}`);
    this.logger.log(`  Auth:     ${this.authStatus}`);
    this.logger.log(`  Fixtures: ${this.activeFixtures.length} monitored`);
    this.logger.log(`  Time:     ${new Date().toISOString()}`);
    this.logger.log('═══════════════════════════════════════════════════════');
  }

  onApplicationShutdown(signal?: string): void {
    this.logger.warn(`Graceful shutdown initiated (signal=${signal ?? 'none'})`);
    try {
      const intervals = this.schedulerRegistry.getIntervals();
      for (const name of intervals) {
        this.schedulerRegistry.deleteInterval(name);
        this.logger.log(`Stopped interval: ${name}`);
      }
    } catch {
      // scheduler may not be initialised
    }
    this.logger.log('All schedulers stopped. Agent shutdown complete.');
  }
}
