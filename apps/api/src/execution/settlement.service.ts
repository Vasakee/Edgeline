import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import * as anchor from '@coral-xyz/anchor';
import { Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { WalletProvider } from '../txline-auth/wallet.provider';
import { Position, PositionDocument } from '../decision/schemas/position.schema';
import { MatchState, MatchStateDocument } from '../txline-data/schemas/match-state.schema';
import { Opportunity, OpportunityDocument } from '../scanner/schemas/opportunity.schema';
import { TxlineDataService } from '../txline-data/txline-data.service';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const vaultIdl = require('./idl/edgeline_vault.json') as anchor.Idl;

const VAULT_PROGRAM_ID = new PublicKey('EAVB3QfGZmMhRvYmtTrsLLuaRYbe6yBRM6JMj68R4VS3');

@Injectable()
export class SettlementService implements OnModuleInit {
  private readonly logger = new Logger(SettlementService.name);
  private readonly intervalMs: number;
  private readonly rpcUrl: string;

  constructor(
    private readonly config: ConfigService,
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly walletProvider: WalletProvider,
    private readonly eventEmitter: EventEmitter2,
    private readonly txlineData: TxlineDataService,
    @InjectModel(Position.name)
    private readonly positionModel: Model<PositionDocument>,
    @InjectModel(MatchState.name)
    private readonly matchStateModel: Model<MatchStateDocument>,
    @InjectModel(Opportunity.name)
    private readonly opportunityModel: Model<OpportunityDocument>,
  ) {
    this.intervalMs = parseInt(
      this.config.get<string>('SETTLEMENT_INTERVAL_MS') ?? '120000',
      10,
    );
    this.rpcUrl =
      this.config.get<string>('SOLANA_RPC_URL') ?? 'https://api.devnet.solana.com';
  }

  onModuleInit(): void {
    this.logger.log(`Settlement checker starting — interval ${this.intervalMs / 1000}s`);
    const interval = setInterval(() => { void this.checkAndSettle(); }, this.intervalMs);
    this.schedulerRegistry.addInterval('settlement-check', interval);
  }

  // -------------------------------------------------------------------------
  // checkAndSettle — main settlement loop
  // -------------------------------------------------------------------------

  async checkAndSettle(): Promise<void> {
    // Find all executed positions not yet settled
    const pendingSettlement = await this.positionModel.find({
      status: 'executed',
    }).lean();

    if (pendingSettlement.length === 0) {
      this.logger.debug('[settlement] no executed positions to settle');
      return;
    }

    this.logger.log(
      `[settlement] checking ${pendingSettlement.length} executed position(s)`,
    );

    for (const pos of pendingSettlement) {
      await this.trySettle(pos as unknown as PositionDocument);
    }
  }

  // -------------------------------------------------------------------------
  // trySettle — settle a single position if the match has finished
  //
  // Match completion is determined by fetching the raw TxLINE event stream
  // and checking for:
  //   - Action === "status" with StatusId >= 5  (full-time)
  //   - Action === "game_finalised"             (finalised)
  //
  // The GameState field from MongoDB/API is IGNORED — it is always "scheduled"
  // regardless of real match progress.
  //
  // Final score is extracted from the most recent event carrying a Score object.
  // -------------------------------------------------------------------------

  private async trySettle(position: PositionDocument): Promise<void> {
    const posId = (position._id as Types.ObjectId).toHexString();

    let matchResult;
    try {
      matchResult = await this.txlineData.getMatchResult(position.fixtureId);
    } catch (err) {
      this.logger.warn(
        `[settlement] position=${posId} — failed to fetch event stream for fixture=${position.fixtureId}: ${String(err)}`,
      );
      return;
    }

    if (!matchResult.finished) {
      this.logger.debug(
        `[settlement] position=${posId} fixture=${position.fixtureId} — match not finished yet (no status/game_finalised event)`,
      );
      return;
    }

    const { homeScore, awayScore, finishedAction, finishedStatusId } = matchResult;

    this.logger.log(
      `[settlement] position=${posId} fixture=${position.fixtureId} ` +
        `FINISHED via ${finishedAction}(statusId=${finishedStatusId}) ` +
        `score=${homeScore}-${awayScore} — settling`,
    );

    // ── Update the MatchState document with correct final state ────────────
    // This ensures the dashboard/API sees the real final score, not the stale
    // "scheduled" gameState.
    await this.matchStateModel.findOneAndUpdate(
      { fixtureId: position.fixtureId },
      {
        $set: {
          gameState: 'F',
          homeScore,
          awayScore,
          updatedAt: new Date(),
        },
      },
      { upsert: false },
    );

    // ── Determine outcome correctness ─────────────────────────────────────────
    //
    // We derive the actual result from final scores:
    //   homeScore > awayScore → home won
    //   homeScore < awayScore → away won
    //   homeScore === awayScore → draw
    const actualOutcome =
      homeScore > awayScore ? 'home' : homeScore < awayScore ? 'away' : 'draw';

    const outcomeCorrect = position.outcome === actualOutcome;

    // ── Compute notional PnL ───────────────────────────────────────────────────
    //
    // Simple Kelly-adjacent formula:
    //   win:  pnl = size × (1/marketProb - 1)  [implied decimal odds minus stake]
    //   loss: pnl = -size
    //
    // marketProb comes from the reasoning object (stored at decision time).
    // Fallback: if reasoning lacks marketProb (pre-fix positions), look it up
    // from the linked Opportunity document.
    let marketProb = (position.reasoning['marketProb'] as number | undefined) ?? 0;
    if (marketProb === 0 && position.opportunityId) {
      const opp = await this.opportunityModel.findById(position.opportunityId).lean();
      if (opp && opp.marketProb > 0) {
        marketProb = opp.marketProb;
        this.logger.warn(
          `[settlement] position=${posId} — marketProb missing from reasoning, backfilled from opportunity: ${marketProb}`,
        );
      }
    }
    if (marketProb === 0) {
      this.logger.error(
        `[settlement] position=${posId} — marketProb is 0, PnL will be computed as a full loss even if outcome is correct!`,
      );
    }
    const sizeInLamports = Math.round(position.size * LAMPORTS_PER_SOL);

    let pnlLamports: number;
    if (outcomeCorrect && marketProb > 0) {
      const impliedDecimalOdds = 1 / marketProb;
      pnlLamports = Math.round(sizeInLamports * (impliedDecimalOdds - 1));
    } else {
      pnlLamports = -sizeInLamports;
    }

    this.logger.log(
      `[settlement] position=${posId} outcome=${position.outcome} actual=${actualOutcome} ` +
        `correct=${outcomeCorrect} pnl=${pnlLamports} lamports (${(pnlLamports / LAMPORTS_PER_SOL).toFixed(4)} SOL)`,
    );

    // ── Call settle_position on-chain ──────────────────────────────────────────
    const txSig = await this.callSettleOnChain(position, outcomeCorrect, pnlLamports);

    // ── Update MongoDB Position document ──────────────────────────────────────
    const updated = await this.positionModel.findByIdAndUpdate(position._id, {
      $set: {
        status: 'settled',
        pnl: pnlLamports / LAMPORTS_PER_SOL,
        'reasoning.settledAt': new Date().toISOString(),
        'reasoning.actualOutcome': actualOutcome,
        'reasoning.outcomeCorrect': outcomeCorrect,
        'reasoning.settlementTxSig': txSig ?? 'not-confirmed',
        'reasoning.finalScore': `${homeScore}-${awayScore}`,
      },
    }, { new: true });

    if (updated) {
      this.eventEmitter.emit('position.updated', updated);
    }

    this.logger.log(
      `[settlement] position=${posId} → status=settled pnl=${(pnlLamports / LAMPORTS_PER_SOL).toFixed(4)} SOL`,
    );
  }

  // -------------------------------------------------------------------------
  // callSettleOnChain — calls settle_position instruction
  // -------------------------------------------------------------------------

  private async callSettleOnChain(
    position: PositionDocument,
    outcomeCorrect: boolean,
    pnlLamports: number,
  ): Promise<string | null> {
    const posId = (position._id as Types.ObjectId).toHexString();

    try {
      const keypair = this.walletProvider.getKeypair();
      const connection = new Connection(this.rpcUrl, 'confirmed');
      const wallet = new anchor.Wallet(keypair);
      const provider = new anchor.AnchorProvider(connection, wallet, {
        commitment: 'confirmed',
      });
      anchor.setProvider(provider);
      const program = new anchor.Program(vaultIdl, provider);

      // Reconstruct PDA using the counter stored at execution time
      const counter = (position.reasoning['onChainCounter'] as number | undefined) ?? 0;
      const counterBuf = Buffer.alloc(8);
      counterBuf.writeBigUInt64LE(BigInt(counter));

      const [positionPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from('position_v2'),
          Buffer.from(position.fixtureId),
          counterBuf,
        ],
        VAULT_PROGRAM_ID,
      );

      const txSig = await program.methods
        .settlePosition(outcomeCorrect, new anchor.BN(pnlLamports))
        .accounts({
          authority: keypair.publicKey,
          positionRecord: positionPda,
        })
        .rpc({ commitment: 'confirmed' });

      this.logger.log(
        `[settlement] on-chain settle confirmed position=${posId} txSig=${txSig}`,
      );
      return txSig;
    } catch (err) {
      this.logger.error(
        `[settlement] on-chain settle FAILED position=${posId}: ${String(err)}`,
      );
      return null;
    }
  }
}
