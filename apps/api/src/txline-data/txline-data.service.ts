import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import axios, { AxiosError, AxiosInstance } from 'axios';
import { TxlineAuthService } from '../txline-auth/txline-auth.service';
import {
  TXLINE_ENDPOINTS,
  MARKET_1X2,
  PRICE_NAME_HOME,
  PRICE_NAME_DRAW,
  PRICE_NAME_AWAY,
} from './txline-data.config';
import { OddsSnapshot, OddsSnapshotDocument } from './schemas/odds-snapshot.schema';
import { MatchState, MatchStateDocument } from './schemas/match-state.schema';

// ---------------------------------------------------------------------------
// Confirmed API response types (verified against live TxLINE devnet responses)
// ---------------------------------------------------------------------------

/**
 * TxFixture — confirmed fields from GET /api/fixtures/snapshot
 */
export interface TxFixture {
  Ts: number;
  StartTime: number;
  Competition: string;
  CompetitionId: number;
  FixtureGroupId: number;
  Participant1Id: number;
  Participant1: string;
  Participant2Id: number;
  Participant2: string;
  FixtureId: number;
  /** true = Participant1 is the home team */
  Participant1IsHome: boolean;
  /** e.g. "NS" (not started), "H1", "HT", "H2", "F" */
  GameState?: string;
}

/**
 * TxOddsEntry — confirmed fields from GET /api/odds/snapshot/{fixtureId}
 *
 * The API returns multiple entries per fixture covering different market types.
 * For match-winner odds, filter on SuperOddsType === "1X2_PARTICIPANT_RESULT".
 *
 * Confirmed for 1X2_PARTICIPANT_RESULT entries:
 *   Bookmaker   = "TXLineStablePriceDemargined" (single consensus price)
 *   PriceNames  = ["part1", "draw", "part2"]
 *   Pct         = ["33.333", "26.667", "40.000"] — already de-margined, sum ≈ 100
 */
export interface TxOddsEntry {
  FixtureId: number;
  Ts: number;
  Bookmaker: string;
  SuperOddsType: string;
  InRunning: boolean;
  GameState?: string;
  MarketParameters?: string;
  MarketPeriod?: string;
  PriceNames?: string[];
  Prices?: number[];
  /** De-margined implied probabilities as percentage strings, e.g. "33.333" */
  Pct?: string[];
}

interface SoccerPeriodScore {
  Goals?: number;
  YellowCards?: number;
  RedCards?: number;
  Corners?: number;
}

interface SoccerParticipantScore {
  H1?: SoccerPeriodScore;
  HT?: SoccerPeriodScore;
  H2?: SoccerPeriodScore;
  Total?: SoccerPeriodScore;
}

export interface TxScoreEvent {
  fixtureId: number;
  gameState?: string;
  statusSoccerId?: string;
  dataSoccer?: {
    Minutes?: number;
    RedCard?: boolean;
    YellowCard?: boolean;
    Participant?: number;
  };
  scoreSoccer?: {
    Participant1?: SoccerParticipantScore;
    Participant2?: SoccerParticipantScore;
  };
}

/**
 * TxRawEvent — the actual shape returned by GET /api/scores/snapshot/{fixtureId}.
 * Confirmed against live TxLINE devnet data 2026-07-10.
 *
 * Key fields for settlement:
 *  - Action: "status" with StatusId >= 5  →  match finished (full-time)
 *  - Action: "game_finalised" with StatusId 100  →  match finalised
 *  - Score.Participant1.Total.Goals / Score.Participant2.Total.Goals  →  final score
 *  - GameState is ALWAYS "scheduled" regardless of real match progress — IGNORE it.
 */
export interface TxRawEvent {
  FixtureId: number;
  GameState?: string;  // UNRELIABLE — always "scheduled"
  StartTime?: number;
  Action?: string;
  StatusId?: number;
  Ts: number;
  Seq?: number;
  Type?: string;
  Confirmed?: boolean;
  Participant1IsHome?: boolean;
  Participant1Id?: number;
  Participant2Id?: number;
  CompetitionId?: number;
  Clock?: {
    Running?: boolean;
    Seconds?: number;
  };
  Score?: {
    Participant1?: SoccerParticipantScore;
    Participant2?: SoccerParticipantScore;
  };
  Data?: Record<string, unknown>;
  Stats?: Record<string, number>;
  PlayerStats?: Record<string, Record<string, Record<string, number>>>;
  Participant?: number;
  [key: string]: unknown;
}

/**
 * Parsed result of match completion detection from the raw event stream.
 */
export interface MatchResult {
  finished: boolean;
  homeScore: number;
  awayScore: number;
  /** The Action that triggered the finished signal ("status" or "game_finalised") */
  finishedAction?: string;
  /** StatusId of the finishing event (5 = full-time, 100 = game_finalised) */
  finishedStatusId?: number;
}

// ---------------------------------------------------------------------------
// Parsed / normalised return types
// ---------------------------------------------------------------------------

export interface FixtureInfo {
  fixtureId: string;
  homeTeam: string;
  awayTeam: string;
  competition: string;
  startTime: number;
  gameState: string | null;
}

/**
 * ParsedOnex2Odds — the normalised form of a 1X2_PARTICIPANT_RESULT entry.
 * Probabilities are in [0, 1] range (divided from the Pct percentage values).
 */
export interface ParsedOnex2Odds {
  fixtureId: string;
  ts: number;
  /** Always "TXLineStablePriceDemargined" for confirmed market */
  bookmaker: string;
  impliedProbHome: number;
  impliedProbDraw: number;
  impliedProbAway: number;
  /** Full raw entry stored for debugging */
  raw: TxOddsEntry;
}

export interface LiveOdds {
  fixtureId: string;
  /**
   * Parsed 1X2 consensus odds, or null if no 1X2_PARTICIPANT_RESULT
   * market was present in the response for this fixture.
   */
  onex2: ParsedOnex2Odds | null;
  /** Count of non-1X2 market entries returned (for logging) */
  otherMarketsCount: number;
}

export interface LiveScore {
  fixtureId: string;
  homeTeam: string | null;
  awayTeam: string | null;
  minute: number | null;
  gameState: string | null;
  homeScore: number;
  awayScore: number;
  redCards: { home: number; away: number };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Injectable()
export class TxlineDataService {
  private readonly logger = new Logger(TxlineDataService.name);
  private readonly http: AxiosInstance;
  private readonly baseUrl: string;

  constructor(
    private readonly config: ConfigService,
    private readonly auth: TxlineAuthService,
    @InjectModel(OddsSnapshot.name)
    private readonly oddsModel: Model<OddsSnapshotDocument>,
    @InjectModel(MatchState.name)
    private readonly matchStateModel: Model<MatchStateDocument>,
  ) {
    this.baseUrl =
      this.config.get<string>('TXLINE_BASE_URL') ?? 'https://txline-dev.txodds.com';

    this.http = axios.create({
      baseURL: this.baseUrl,
      timeout: 5_000,
    });
  }

  // -------------------------------------------------------------------------
  // Auth headers — fresh guest JWT + cached static API key on every call
  // -------------------------------------------------------------------------

  private async authHeaders(): Promise<Record<string, string>> {
    // getAuthHeaders() always fetches a fresh guest JWT (it expires in minutes)
    // and pairs it with the cached static API key.
    return this.auth.getAuthHeaders();
  }

  // -------------------------------------------------------------------------
  // Retry helper — retries once with 2s backoff
  // -------------------------------------------------------------------------

  private async withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (firstErr) {
      this.logger.warn(`[${label}] failed, retrying in 2s…`);
      await new Promise((r) => setTimeout(r, 2_000));
      try {
        return await fn();
      } catch (secondErr) {
        const msg = this.axiosMsg(secondErr);
        this.logger.error(`[${label}] retry failed: ${msg}`);
        throw new Error(`[${label}] ${msg}`);
      }
    }
  }

  private axiosMsg(err: unknown): string {
    if (err instanceof AxiosError) {
      const status = err.response?.status ?? 'no-status';
      const body = err.response?.data
        ? JSON.stringify(err.response.data)
        : err.message;
      return `HTTP ${status}: ${body}`;
    }
    return String(err);
  }

  // -------------------------------------------------------------------------
  // fetchFixtures — GET /api/fixtures/snapshot
  // -------------------------------------------------------------------------

  async fetchFixtures(competitionId?: number): Promise<FixtureInfo[]> {
    return this.withRetry('fetchFixtures', async () => {
      const headers = await this.authHeaders();
      const params = competitionId ? { competitionId } : {};
      const res = await this.http.get<TxFixture[]>(
        TXLINE_ENDPOINTS.fixturesSnapshot,
        { headers, params },
      );
      return res.data.map((f) => ({
        fixtureId: String(f.FixtureId),
        // Participant1IsHome=true → Participant1 is home, Participant2 is away
        homeTeam: f.Participant1IsHome ? f.Participant1 : f.Participant2,
        awayTeam: f.Participant1IsHome ? f.Participant2 : f.Participant1,
        competition: f.Competition,
        startTime: f.StartTime,
        gameState: f.GameState ?? null,
      }));
    });
  }

  // -------------------------------------------------------------------------
  // fetchLiveOdds — GET /api/odds/snapshot/{fixtureId}
  //
  // Filters the response for the 1X2_PARTICIPANT_RESULT market.
  // Returns null for onex2 if not present — callers must handle this.
  // -------------------------------------------------------------------------

  async fetchLiveOdds(fixtureId: string): Promise<LiveOdds> {
    return this.withRetry(`fetchLiveOdds(${fixtureId})`, async () => {
      const headers = await this.authHeaders();
      const res = await this.http.get<TxOddsEntry[]>(
        `${TXLINE_ENDPOINTS.oddsSnapshot}/${fixtureId}`,
        { headers },
      );

      const allEntries = res.data;
      const onex2Entry = allEntries.find(
        (e) => e.SuperOddsType === MARKET_1X2,
      ) ?? null;

      const otherMarketsCount = allEntries.filter(
        (e) => e.SuperOddsType !== MARKET_1X2,
      ).length;

      if (!onex2Entry) {
        return { fixtureId, onex2: null, otherMarketsCount };
      }

      const parsed = this.parseOnex2Entry(fixtureId, onex2Entry);
      return { fixtureId, onex2: parsed, otherMarketsCount };
    });
  }

  /**
   * parseOnex2Entry
   *
   * Maps a confirmed 1X2_PARTICIPANT_RESULT entry to normalised probabilities.
   *
   * PriceNames = ["part1", "draw", "part2"]
   * Pct values are percentage strings (e.g. "33.333") that already sum to ~100
   * after de-margining. Divide by 100 to get [0,1] probabilities.
   *
   * We use PriceNames to find the correct index rather than assuming position,
   * so this is robust if TxLINE ever reorders the array.
   */
  private parseOnex2Entry(fixtureId: string, entry: TxOddsEntry): ParsedOnex2Odds {
    const names = entry.PriceNames ?? [];
    const pct = entry.Pct ?? [];

    const indexOf = (name: string): number => {
      const i = names.indexOf(name);
      return i !== -1 ? i : names.findIndex((n) => n.toLowerCase() === name.toLowerCase());
    };

    const parseProb = (name: string): number => {
      const i = indexOf(name);
      if (i === -1 || !pct[i] || pct[i] === 'NA') return 0;
      // Pct values are percentages (e.g. "33.333") — divide by 100 for probability
      return parseFloat(pct[i]) / 100;
    };

    return {
      fixtureId,
      ts: entry.Ts,
      bookmaker: entry.Bookmaker,
      impliedProbHome: parseProb(PRICE_NAME_HOME),
      impliedProbDraw: parseProb(PRICE_NAME_DRAW),
      impliedProbAway: parseProb(PRICE_NAME_AWAY),
      raw: entry,
    };
  }

  // -------------------------------------------------------------------------
  // fetchLiveScore — GET /api/scores/snapshot/{fixtureId}
  // -------------------------------------------------------------------------

  async fetchLiveScore(fixture: FixtureInfo): Promise<LiveScore> {
    const { fixtureId } = fixture;
    return this.withRetry(`fetchLiveScore(${fixtureId})`, async () => {
      const headers = await this.authHeaders();
      const res = await this.http.get<TxScoreEvent[]>(
        `${TXLINE_ENDPOINTS.scoresSnapshot}/${fixtureId}`,
        { headers },
      );

      const events = res.data;
      const latest = events.reduce<TxScoreEvent | null>((best, ev) => {
        if (!best) return ev;
        const evTs = (ev as { ts?: number }).ts ?? 0;
        const bestTs = (best as { ts?: number }).ts ?? 0;
        return evTs > bestTs ? ev : best;
      }, null);

      if (!latest) {
        return { fixtureId, homeTeam: fixture.homeTeam, awayTeam: fixture.awayTeam,
          minute: null, gameState: null, homeScore: 0, awayScore: 0,
          redCards: { home: 0, away: 0 } };
      }

      const soccer = latest.scoreSoccer;
      return {
        fixtureId,
        homeTeam: fixture.homeTeam,
        awayTeam: fixture.awayTeam,
        minute: latest.dataSoccer?.Minutes ?? null,
        gameState: latest.statusSoccerId ?? latest.gameState ?? null,
        homeScore: soccer?.Participant1?.Total?.Goals ?? 0,
        awayScore: soccer?.Participant2?.Total?.Goals ?? 0,
        redCards: {
          home: soccer?.Participant1?.Total?.RedCards ?? 0,
          away: soccer?.Participant2?.Total?.RedCards ?? 0,
        },
      };
    });
  }

  // -------------------------------------------------------------------------
  // fetchRawEventStream — GET /api/scores/snapshot/{fixtureId}
  // Returns the RAW event array exactly as TxLINE sends it.
  // -------------------------------------------------------------------------

  async fetchRawEventStream(fixtureId: string): Promise<TxRawEvent[]> {
    return this.withRetry(`fetchRawEventStream(${fixtureId})`, async () => {
      const headers = await this.authHeaders();
      const res = await this.http.get<TxRawEvent[]>(
        `${TXLINE_ENDPOINTS.scoresSnapshot}/${fixtureId}`,
        { headers },
      );
      return res.data;
    });
  }

  // -------------------------------------------------------------------------
  // getMatchResult — determines if a match has finished and extracts final score
  //
  // Logic (confirmed against live data 2026-07-10):
  //   1. Fetch the full raw event stream for the fixture
  //   2. Sort by Ts descending to find the most recent events
  //   3. Match finished if ANY event has:
  //        (Action === "status" && StatusId >= 5)  OR
  //        (Action === "game_finalised")
  //   4. Final score = most recent event with a Score object →
  //        Score.Participant1.Total.Goals  /  Score.Participant2.Total.Goals
  //   5. GameState field is IGNORED — it is always "scheduled".
  // -------------------------------------------------------------------------

  async getMatchResult(fixtureId: string): Promise<MatchResult> {
    const events = await this.fetchRawEventStream(fixtureId);

    if (events.length === 0) {
      return { finished: false, homeScore: 0, awayScore: 0 };
    }

    // Sort by Ts descending
    const sorted = [...events].sort((a, b) => b.Ts - a.Ts);

    // Check for match-finished signal
    const finishedEvent = sorted.find(
      (e) =>
        (e.Action === 'status' && (e.StatusId ?? 0) >= 5) ||
        e.Action === 'game_finalised',
    );

    if (!finishedEvent) {
      return { finished: false, homeScore: 0, awayScore: 0 };
    }

    // Extract final score from the most recent event that has a Score object
    const lastWithScore = sorted.find((e) => e.Score != null);
    const homeScore = lastWithScore?.Score?.Participant1?.Total?.Goals ?? 0;
    const awayScore = lastWithScore?.Score?.Participant2?.Total?.Goals ?? 0;

    // Fallback: if no event has Score, try counting goal events from PlayerStats
    // on the finished event itself.
    if (!lastWithScore && finishedEvent.PlayerStats) {
      const p1Stats = finishedEvent.PlayerStats['Participant1'] ?? {};
      const p2Stats = finishedEvent.PlayerStats['Participant2'] ?? {};
      const countGoals = (ps: Record<string, Record<string, number>>) =>
        Object.values(ps).reduce((sum, s) => sum + (s['goals'] ?? 0), 0);
      return {
        finished: true,
        homeScore: countGoals(p1Stats),
        awayScore: countGoals(p2Stats),
        finishedAction: finishedEvent.Action,
        finishedStatusId: finishedEvent.StatusId,
      };
    }

    return {
      finished: true,
      homeScore,
      awayScore,
      finishedAction: finishedEvent.Action,
      finishedStatusId: finishedEvent.StatusId,
    };
  }

  // -------------------------------------------------------------------------
  // persistOddsSnapshot — stores a confirmed 1X2 ParsedOnex2Odds document
  // -------------------------------------------------------------------------

  async persistOddsSnapshot(
    fixture: FixtureInfo,
    odds: ParsedOnex2Odds,
  ): Promise<void> {
    await this.oddsModel.create({
      fixtureId: fixture.fixtureId,
      homeTeam: fixture.homeTeam,
      awayTeam: fixture.awayTeam,
      market: MARKET_1X2,
      bookmaker: odds.bookmaker,
      impliedProbHome: odds.impliedProbHome,
      impliedProbDraw: odds.impliedProbDraw,
      impliedProbAway: odds.impliedProbAway,
      rawResponse: odds.raw as unknown as Record<string, unknown>,
      fetchedAt: new Date(),
    });
  }

  // -------------------------------------------------------------------------
  // persistMatchState — upserts a single MatchState document per fixture
  // -------------------------------------------------------------------------

  async persistMatchState(score: LiveScore): Promise<void> {
    await this.matchStateModel.findOneAndUpdate(
      { fixtureId: score.fixtureId },
      {
        $set: {
          fixtureId: score.fixtureId,
          homeTeam: score.homeTeam,
          awayTeam: score.awayTeam,
          minute: score.minute,
          gameState: score.gameState,
          homeScore: score.homeScore,
          awayScore: score.awayScore,
          redCards: score.redCards,
          updatedAt: new Date(),
        },
      },
      { upsert: true, new: true },
    );
  }
}
