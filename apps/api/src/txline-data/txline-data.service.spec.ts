/**
 * txline-data.service.spec.ts — updated for confirmed real API schema.
 */

jest.mock('../txline-auth/txline-auth.service', () => ({
  TxlineAuthService: jest.fn().mockImplementation(() => ({
    getAuthHeaders: jest.fn().mockResolvedValue({
      Authorization: 'Bearer mock-jwt',
      'X-Api-Token': 'txoracle_api_mock',
    }),
  })),
}));

jest.mock('../txline-auth/wallet.provider', () => ({
  WalletProvider: jest.fn(),
}));

import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getModelToken } from '@nestjs/mongoose';
import axios from 'axios';
import AxiosMockAdapter from 'axios-mock-adapter';

import { TxlineDataService, TxOddsEntry } from './txline-data.service';
import { TxlineAuthService } from '../txline-auth/txline-auth.service';
import { OddsSnapshot } from './schemas/odds-snapshot.schema';
import { MatchState } from './schemas/match-state.schema';
import { TXLINE_ENDPOINTS, MARKET_1X2 } from './txline-data.config';

const mockOddsModel = { create: jest.fn().mockResolvedValue({}) };
const mockMatchStateModel = { findOneAndUpdate: jest.fn().mockResolvedValue({}) };
const mockConfig = {
  get: jest.fn((key: string) =>
    ({ TXLINE_BASE_URL: 'https://txline-dev.txodds.com' } as Record<string, string>)[key],
  ),
};

// Confirmed fixture shape from live API
const sampleFixture = {
  Ts: 1720000000, StartTime: 1720010000,
  Competition: 'FIFA World Cup 2026', CompetitionId: 999,
  FixtureGroupId: 1, Participant1Id: 100, Participant1: 'Brazil',
  Participant2Id: 101, Participant2: 'Argentina',
  FixtureId: 424242, Participant1IsHome: true, GameState: 'NS',
};

// Confirmed 1X2_PARTICIPANT_RESULT entry shape
const sampleOnex2Entry: TxOddsEntry = {
  FixtureId: 424242, Ts: 1720000001,
  Bookmaker: 'TXLineStablePriceDemargined',
  SuperOddsType: MARKET_1X2,
  InRunning: false,
  PriceNames: ['part1', 'draw', 'part2'],
  Prices: [2500, 3700, 2800],
  Pct: ['38.500', '27.100', '34.400'],
};

// A non-1X2 entry — should be ignored for odds persistence
const sampleOtherEntry: TxOddsEntry = {
  FixtureId: 424242, Ts: 1720000001,
  Bookmaker: 'TXLineStablePriceDemargined',
  SuperOddsType: 'OVERUNDER_PARTICIPANT_GOALS',
  InRunning: false,
  PriceNames: ['over', 'under'],
  Pct: ['52.000', '48.000'],
};

const sampleScoreEvent = {
  fixtureId: 424242, gameState: 'H1', statusSoccerId: 'H1', ts: 1720000050,
  dataSoccer: { Minutes: 34 },
  scoreSoccer: {
    Participant1: { Total: { Goals: 1, RedCards: 0 } },
    Participant2: { Total: { Goals: 0, RedCards: 1 } },
  },
};

describe('TxlineDataService', () => {
  let service: TxlineDataService;
  let axiosMock: AxiosMockAdapter;

  beforeEach(async () => {
    axiosMock = new AxiosMockAdapter(axios);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TxlineDataService,
        { provide: ConfigService, useValue: mockConfig },
        {
          provide: TxlineAuthService,
          useValue: {
            getAuthHeaders: jest.fn().mockResolvedValue({
              Authorization: 'Bearer mock-jwt',
              'X-Api-Token': 'txoracle_api_mock',
            }),
          },
        },
        { provide: getModelToken(OddsSnapshot.name), useValue: mockOddsModel },
        { provide: getModelToken(MatchState.name), useValue: mockMatchStateModel },
      ],
    }).compile();
    service = module.get<TxlineDataService>(TxlineDataService);
  });

  afterEach(() => { axiosMock.reset(); jest.clearAllMocks(); });

  // ── fetchFixtures ──────────────────────────────────────────────────────────

  describe('fetchFixtures()', () => {
    it('maps Participant1IsHome=true: Participant1 is home', async () => {
      axiosMock.onGet(new RegExp(TXLINE_ENDPOINTS.fixturesSnapshot)).reply(200, [sampleFixture]);
      const [f] = await service.fetchFixtures();
      expect(f.homeTeam).toBe('Brazil');
      expect(f.awayTeam).toBe('Argentina');
      expect(f.fixtureId).toBe('424242');
      expect(f.gameState).toBe('NS');
    });

    it('swaps home/away when Participant1IsHome=false', async () => {
      axiosMock.onGet(new RegExp(TXLINE_ENDPOINTS.fixturesSnapshot))
        .reply(200, [{ ...sampleFixture, Participant1IsHome: false }]);
      const [f] = await service.fetchFixtures();
      expect(f.homeTeam).toBe('Argentina');
      expect(f.awayTeam).toBe('Brazil');
    });

    it('retries once on failure and succeeds', async () => {
      jest.spyOn(global, 'setTimeout').mockImplementation((fn) => { (fn as () => void)(); return 0 as unknown as ReturnType<typeof setTimeout>; });
      axiosMock.onGet(new RegExp(TXLINE_ENDPOINTS.fixturesSnapshot))
        .replyOnce(500).onGet(new RegExp(TXLINE_ENDPOINTS.fixturesSnapshot)).reply(200, [sampleFixture]);
      const result = await service.fetchFixtures();
      expect(result).toHaveLength(1);
    });

    it('throws after two consecutive failures', async () => {
      jest.spyOn(global, 'setTimeout').mockImplementation((fn) => { (fn as () => void)(); return 0 as unknown as ReturnType<typeof setTimeout>; });
      axiosMock.onGet(new RegExp(TXLINE_ENDPOINTS.fixturesSnapshot)).reply(503);
      await expect(service.fetchFixtures()).rejects.toThrow(/fetchFixtures/);
    });
  });

  // ── fetchLiveOdds ──────────────────────────────────────────────────────────

  describe('fetchLiveOdds()', () => {
    it('returns parsed 1X2 odds when 1X2_PARTICIPANT_RESULT present', async () => {
      axiosMock.onGet(new RegExp(`${TXLINE_ENDPOINTS.oddsSnapshot}/424242`))
        .reply(200, [sampleOnex2Entry]);
      const result = await service.fetchLiveOdds('424242');

      expect(result.onex2).not.toBeNull();
      expect(result.onex2!.bookmaker).toBe('TXLineStablePriceDemargined');
      // Pct "38.500" / 100 = 0.385
      expect(result.onex2!.impliedProbHome).toBeCloseTo(0.385, 3);
      expect(result.onex2!.impliedProbDraw).toBeCloseTo(0.271, 3);
      expect(result.onex2!.impliedProbAway).toBeCloseTo(0.344, 3);
    });

    it('returns onex2=null when only non-1X2 markets present', async () => {
      axiosMock.onGet(new RegExp(`${TXLINE_ENDPOINTS.oddsSnapshot}/424242`))
        .reply(200, [sampleOtherEntry]);
      const result = await service.fetchLiveOdds('424242');
      expect(result.onex2).toBeNull();
      expect(result.otherMarketsCount).toBe(1);
    });

    it('returns onex2=null for empty response', async () => {
      axiosMock.onGet(new RegExp(`${TXLINE_ENDPOINTS.oddsSnapshot}/424242`)).reply(200, []);
      const result = await service.fetchLiveOdds('424242');
      expect(result.onex2).toBeNull();
    });

    it('correctly finds 1X2 in mixed market response', async () => {
      axiosMock.onGet(new RegExp(`${TXLINE_ENDPOINTS.oddsSnapshot}/424242`))
        .reply(200, [sampleOtherEntry, sampleOnex2Entry]);
      const result = await service.fetchLiveOdds('424242');
      expect(result.onex2).not.toBeNull();
      expect(result.otherMarketsCount).toBe(1);
    });
  });

  // ── fetchLiveScore ─────────────────────────────────────────────────────────

  describe('fetchLiveScore()', () => {
    const fixture = { fixtureId: '424242', homeTeam: 'Brazil', awayTeam: 'Argentina', competition: 'FIFA World Cup 2026', startTime: 1720010000, gameState: 'H1' };

    it('extracts soccer score, minute and red cards', async () => {
      axiosMock.onGet(new RegExp(`${TXLINE_ENDPOINTS.scoresSnapshot}/424242`)).reply(200, [sampleScoreEvent]);
      const score = await service.fetchLiveScore(fixture);
      expect(score.minute).toBe(34);
      expect(score.homeScore).toBe(1);
      expect(score.awayScore).toBe(0);
      expect(score.redCards).toEqual({ home: 0, away: 1 });
      expect(score.gameState).toBe('H1');
      expect(score.homeTeam).toBe('Brazil');
      expect(score.awayTeam).toBe('Argentina');
    });

    it('returns zero scores for empty response', async () => {
      axiosMock.onGet(new RegExp(`${TXLINE_ENDPOINTS.scoresSnapshot}/424242`)).reply(200, []);
      const score = await service.fetchLiveScore(fixture);
      expect(score.homeScore).toBe(0);
      expect(score.minute).toBeNull();
    });
  });

  // ── persistOddsSnapshot ────────────────────────────────────────────────────

  describe('persistOddsSnapshot()', () => {
    const fixture = { fixtureId: '424242', homeTeam: 'Brazil', awayTeam: 'Argentina', competition: 'FIFA World Cup 2026', startTime: 1720010000, gameState: 'H1' };

    it('calls model.create with correctly mapped fields', async () => {
      const parsedOdds = {
        fixtureId: '424242', ts: 1720000001,
        bookmaker: 'TXLineStablePriceDemargined',
        impliedProbHome: 0.385, impliedProbDraw: 0.271, impliedProbAway: 0.344,
        raw: sampleOnex2Entry,
      };
      await service.persistOddsSnapshot(fixture, parsedOdds);
      expect(mockOddsModel.create).toHaveBeenCalledWith(
        expect.objectContaining({
          fixtureId: '424242', homeTeam: 'Brazil',
          impliedProbHome: 0.385, impliedProbDraw: 0.271, impliedProbAway: 0.344,
          bookmaker: 'TXLineStablePriceDemargined',
        }),
      );
    });
  });

  // ── persistMatchState ──────────────────────────────────────────────────────

  describe('persistMatchState()', () => {
    it('calls findOneAndUpdate with upsert:true', async () => {
      await service.persistMatchState({ fixtureId: '424242', homeTeam: 'Brazil', awayTeam: 'Argentina', minute: 34, gameState: 'H1', homeScore: 1, awayScore: 0, redCards: { home: 0, away: 1 } });
      expect(mockMatchStateModel.findOneAndUpdate).toHaveBeenCalledWith(
        { fixtureId: '424242' },
        expect.objectContaining({ $set: expect.objectContaining({ homeScore: 1, homeTeam: 'Brazil' }) }),
        { upsert: true, new: true },
      );
    });
  });
});
