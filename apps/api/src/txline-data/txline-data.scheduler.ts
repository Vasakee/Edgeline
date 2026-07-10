import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { TxlineDataService, FixtureInfo } from './txline-data.service';
import { ScannerService, ScannerInput } from '../scanner/scanner.service';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { OddsSnapshot, OddsSnapshotDocument } from './schemas/odds-snapshot.schema';

@Injectable()
export class TxlineDataScheduler implements OnModuleInit {
  private readonly logger = new Logger(TxlineDataScheduler.name);
  private readonly intervalMs: number;
  private isPolling = false;

  constructor(
    private readonly config: ConfigService,
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly dataService: TxlineDataService,
    private readonly scannerService: ScannerService,
    @InjectModel(OddsSnapshot.name)
    private readonly oddsModel: Model<OddsSnapshotDocument>,
  ) {
    this.intervalMs =
      parseInt(this.config.get<string>('POLL_INTERVAL_MS') ?? '20000', 10);
  }

  onModuleInit(): void {
    this.logger.log(`Starting poller — interval ${this.intervalMs}ms`);
    const interval = setInterval(() => { void this.poll(); }, this.intervalMs);
    this.schedulerRegistry.addInterval('txline-poll', interval);
    void this.poll(); // fire immediately on startup
  }

  async poll(): Promise<void> {
    if (this.isPolling) {
      this.logger.warn('Previous poll still running — skipping tick');
      return;
    }
    this.isPolling = true;
    const pollStart = Date.now();

    try {
      const fixtures = await this.dataService.fetchFixtures();

      if (fixtures.length === 0) {
        this.logger.log('[poll] No fixtures in snapshot');
        return;
      }

      this.logger.debug(`[poll] ${fixtures.length} fixtures in snapshot`);

      let processed = 0;
      let skippedNo1X2 = 0;
      let opportunities = 0;

      // Process in batches of 5 to avoid hammering the API
      for (let i = 0; i < fixtures.length; i += 5) {
        const batch = fixtures.slice(i, i + 5);
        const results = await Promise.allSettled(
          batch.map((f) => this.pollFixture(f)),
        );
        for (const r of results) {
          if (r.status === 'fulfilled') {
            if (r.value === 'no_1x2') skippedNo1X2++;
            else if (r.value === 'opportunity') { processed++; opportunities++; }
            else processed++;
          }
        }
      }

      const totalMs = Date.now() - pollStart;
      this.logger.log(
        `[poll] cycle complete — processed=${processed} skipped_no_1x2=${skippedNo1X2} ` +
          `opportunities=${opportunities} total=${fixtures.length} in ${totalMs}ms`,
      );
    } catch (err) {
      this.logger.error(`[poll] cycle error: ${String(err)}`);
    } finally {
      this.isPolling = false;
    }
  }

  /**
   * Poll a single fixture: fetch odds + score, persist, then run the scanner.
   * Returns 'no_1x2' if no 1X2 market, 'opportunity' if divergence found, 'ok' otherwise.
   */
  private async pollFixture(fixture: FixtureInfo): Promise<'ok' | 'no_1x2' | 'opportunity'> {
    const start = Date.now();

    try {
      const [odds, score] = await Promise.all([
        this.dataService.fetchLiveOdds(fixture.fixtureId),
        this.dataService.fetchLiveScore(fixture),
      ]);

      // Always persist the match state
      await this.dataService.persistMatchState(score);

      if (!odds.onex2) {
        // Log which fixtures are missing 1X2 so coverage can be monitored
        this.logger.debug(
          `[poll] fixture="${fixture.fixtureId}" ${fixture.homeTeam} vs ${fixture.awayTeam} — ` +
            `no 1X2_PARTICIPANT_RESULT market (other_markets=${odds.otherMarketsCount})`,
        );
        return 'no_1x2';
      }

      // Persist confirmed 1X2 odds
      await this.dataService.persistOddsSnapshot(fixture, odds.onex2);

      const latency = Date.now() - start;
      this.logger.log(
        `[poll] fixture="${fixture.fixtureId}" ` +
          `home="${fixture.homeTeam}" away="${fixture.awayTeam}" ` +
          `H=${odds.onex2.impliedProbHome.toFixed(3)} ` +
          `D=${odds.onex2.impliedProbDraw.toFixed(3)} ` +
          `A=${odds.onex2.impliedProbAway.toFixed(3)} ` +
          `score=${score.homeScore}-${score.awayScore} ` +
          `min=${score.minute ?? 'N/A'} ` +
          `latency=${latency}ms`,
      );

      // ── RUN THE SCANNER — the critical missing link ──────────────────────
      // Fetch the earliest odds snapshot for this fixture to use as pre-match prior.
      // If no prior exists yet (first poll), fall back to the current live odds.
      const preMatchSnapshot = await this.oddsModel
        .findOne({ fixtureId: fixture.fixtureId })
        .sort({ fetchedAt: 1 })
        .exec();

      const preMatchOdds = preMatchSnapshot
        ? {
            home: preMatchSnapshot.impliedProbHome,
            draw: preMatchSnapshot.impliedProbDraw,
            away: preMatchSnapshot.impliedProbAway,
          }
        : {
            home: odds.onex2.impliedProbHome,
            draw: odds.onex2.impliedProbDraw,
            away: odds.onex2.impliedProbAway,
          };

      const scannerInput: ScannerInput = {
        fixtureId: fixture.fixtureId,
        homeTeam: fixture.homeTeam,
        awayTeam: fixture.awayTeam,
        preMatchOdds,
        liveMarketOdds: {
          home: odds.onex2.impliedProbHome,
          draw: odds.onex2.impliedProbDraw,
          away: odds.onex2.impliedProbAway,
        },
        matchState: score,
      };

      const opp = await this.scannerService.scan(scannerInput);
      return opp ? 'opportunity' : 'ok';
    } catch (err) {
      this.logger.error(
        `[poll] fixture="${fixture.fixtureId}" ${fixture.homeTeam} vs ${fixture.awayTeam} — error: ${String(err)}`,
      );
      return 'no_1x2';
    }
  }
}
