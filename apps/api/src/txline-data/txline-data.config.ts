/**
 * txline-data.config.ts
 *
 * Confirmed TxLINE API endpoint paths, verified against live API responses
 * on 2026-07-08 using real credentials.
 *
 * Base URL: https://txline-dev.txodds.com (devnet)
 * Auth required on every call:
 *   Authorization: Bearer <guest JWT>   — short-lived, refresh every poll cycle
 *   X-Api-Token:   <static API key>     — long-lived (txoracle_api_* format)
 */
export const TXLINE_ENDPOINTS = {
  /**
   * GET /api/fixtures/snapshot
   * Returns array of fixtures for the subscribed leagues.
   * Confirmed real fields: Ts, StartTime, Competition, CompetitionId,
   *   FixtureGroupId, Participant1Id, Participant1, Participant2Id, Participant2,
   *   FixtureId, Participant1IsHome, GameState
   * Optional query params: startEpochDay, competitionId
   */
  fixturesSnapshot: '/api/fixtures/snapshot',

  /**
   * GET /api/odds/snapshot/{fixtureId}
   * Returns array of odds objects across multiple market types.
   * Confirmed: filter on SuperOddsType === "1X2_PARTICIPANT_RESULT" for match winner.
   * Confirmed bookmaker value: "TXLineStablePriceDemargined" — single synthetic
   *   consensus price, NOT per-bookmaker. Do not compare across bookmakers.
   * Confirmed fields: FixtureId, Ts, Bookmaker, SuperOddsType,
   *   PriceNames (["part1","draw","part2"]), Prices, Pct
   * Pct values are string percentages that already sum to ~100 — use directly.
   * Not every fixture has 1X2 odds populated; handle missing market gracefully.
   */
  oddsSnapshot: '/api/odds/snapshot',

  /**
   * GET /api/scores/snapshot/{fixtureId}
   * Returns array of score events for a fixture.
   * Soccer data in scoreSoccer / dataSoccer fields.
   */
  scoresSnapshot: '/api/scores/snapshot',
} as const;

/** The exact SuperOddsType value for match-winner market (confirmed from live data) */
export const MARKET_1X2 = '1X2_PARTICIPANT_RESULT';

/** PriceNames mapping for 1X2 market (confirmed from live data) */
export const PRICE_NAME_HOME = 'part1';
export const PRICE_NAME_DRAW = 'draw';
export const PRICE_NAME_AWAY = 'part2';

/** Bookmaker field value for the consensus synthetic price (confirmed from live data) */
export const STABLE_PRICE_BOOKMAKER = 'TXLineStablePriceDemargined';

export type TxlineEndpointKey = keyof typeof TXLINE_ENDPOINTS;
