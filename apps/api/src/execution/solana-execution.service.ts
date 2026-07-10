import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnEvent, EventEmitter2 } from '@nestjs/event-emitter';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import * as anchor from '@coral-xyz/anchor';
import { Connection, PublicKey, SystemProgram, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { WalletProvider } from '../txline-auth/wallet.provider';
import {
  POSITION_APPROVED_EVENT,
  PositionApprovedPayload,
} from '../decision/decision.service';
import { Position, PositionDocument } from '../decision/schemas/position.schema';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const vaultIdl = require('./idl/edgeline_vault.json') as anchor.Idl;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Devnet program ID — must match declare_id! in lib.rs */
const VAULT_PROGRAM_ID = new PublicKey('EAVB3QfGZmMhRvYmtTrsLLuaRYbe6yBRM6JMj68R4VS3');

/**
 * Minimum SOL balance before requesting a devnet airdrop.
 * Transactions cost ~5000 lamports; we keep at least 0.05 SOL as cushion.
 */
const MIN_BALANCE_SOL = 0.05;
const AIRDROP_SOL = 1;

/** Maximum number of send+confirm attempts before marking position failed */
const MAX_TX_ATTEMPTS = 3;

@Injectable()
export class SolanaExecutionService {
  private readonly logger = new Logger(SolanaExecutionService.name);
  private readonly rpcUrl: string;

  /**
   * Per-fixture mutex: serializes executePosition calls for the same fixtureId.
   * Without this, concurrent calls read the same on-chain counter, derive the
   * same PDA, and Solana deduplicates the identical transactions — causing two
   * Position documents to share the same txSig.
   */
  private readonly fixtureExecLocks = new Map<string, Promise<void>>();

  constructor(
    private readonly config: ConfigService,
    private readonly walletProvider: WalletProvider,
    private readonly eventEmitter: EventEmitter2,
    @InjectModel(Position.name)
    private readonly positionModel: Model<PositionDocument>,
  ) {
    this.rpcUrl =
      this.config.get<string>('SOLANA_RPC_URL') ?? 'https://api.devnet.solana.com';
  }

  // -------------------------------------------------------------------------
  // Per-fixture mutex — ensures only one executePosition runs at a time
  // -------------------------------------------------------------------------

  private async withFixtureLock(fixtureId: string, fn: () => Promise<void>): Promise<void> {
    // Wait for any prior execution on this fixture to finish
    const prior = this.fixtureExecLocks.get(fixtureId) ?? Promise.resolve();

    // Chain our work onto the prior promise so the next caller waits for us
    const current = prior.then(fn, fn); // run fn even if prior rejected
    this.fixtureExecLocks.set(fixtureId, current);

    try {
      await current;
    } finally {
      // Clean up the map entry if we're still the latest in the chain
      if (this.fixtureExecLocks.get(fixtureId) === current) {
        this.fixtureExecLocks.delete(fixtureId);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Event handler — fires when DecisionService approves a position
  // -------------------------------------------------------------------------

  @OnEvent(POSITION_APPROVED_EVENT)
  async handlePositionApproved(payload: PositionApprovedPayload): Promise<void> {
    const { position } = payload;
    const posId = (position._id as Types.ObjectId).toHexString();

    this.logger.log(
      `[execution] received position=${posId} ` +
        `fixture=${position.fixtureId} outcome=${position.outcome} size=${position.size}`,
    );

    try {
      await this.withFixtureLock(position.fixtureId, () =>
        this.executePosition(position),
      );
    } catch (err) {
      // executePosition handles its own status updates — this catch is a safety net
      this.logger.error(`[execution] unhandled error for position=${posId}: ${String(err)}`);
    }
  }

  // -------------------------------------------------------------------------
  // executePosition — calls record_position on-chain with retries
  // -------------------------------------------------------------------------

  async executePosition(position: PositionDocument): Promise<void> {
    const posId = (position._id as Types.ObjectId).toHexString();
    const keypair = this.walletProvider.getKeypair();
    const connection = new Connection(this.rpcUrl, 'confirmed');

    // ── 1. Balance check — auto-airdrop on devnet if needed ──────────────────
    await this.ensureSufficientBalance(connection, posId);

    // ── 2. Set up Anchor provider + program ──────────────────────────────────
    const wallet = new anchor.Wallet(keypair);
    const provider = new anchor.AnchorProvider(connection, wallet, {
      commitment: 'confirmed',
      preflightCommitment: 'confirmed',
    });
    anchor.setProvider(provider);
    const program = new anchor.Program(vaultIdl, provider);

    if (!program.programId.equals(VAULT_PROGRAM_ID)) {
      throw new Error(`IDL program ID mismatch: ${program.programId.toBase58()}`);
    }

    // ── 3. Derive PDA ─────────────────────────────────────────────────────────
    const [counterPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('counter_v2'), Buffer.from(position.fixtureId)],
      VAULT_PROGRAM_ID,
    );

    // ── 4. Convert floats to on-chain u64 (× 1_000_000) ──────────────────────
    const modelProb = Math.round((position.reasoning['modelProb'] as number ?? 0) * 1_000_000);
    const marketProb = Math.round((position.reasoning['marketProb'] as number ?? 0) * 1_000_000);
    const sizeInLamports = Math.round(position.size * LAMPORTS_PER_SOL);

    // ── 5. Send with retry + backoff ──────────────────────────────────────────
    let txSig: string | null = null;
    let lastError: string = '';
    let finalOnChainCount = 0;
    let finalPositionPda = counterPda; // fallback

    for (let attempt = 1; attempt <= MAX_TX_ATTEMPTS; attempt++) {
      try {
        this.logger.log(
          `[execution] attempt ${attempt}/${MAX_TX_ATTEMPTS} position=${posId}`,
        );

        let onChainCount = 0;
        try {
          const counterAccount = await (program.account as any).fixtureCounter.fetch(counterPda);
          onChainCount = (counterAccount as any).count.toNumber();
        } catch {
          // If it doesn't exist yet, it will be initialized on-chain with count = 0
          onChainCount = 0;
        }

        const counterBuf = Buffer.alloc(8);
        counterBuf.writeBigUInt64LE(BigInt(onChainCount));

        const [positionPda] = PublicKey.findProgramAddressSync(
          [
            Buffer.from('position_v2'),
            Buffer.from(position.fixtureId),
            counterBuf,
          ],
          VAULT_PROGRAM_ID,
        );

        this.logger.debug(
          `[execution] PDA=${positionPda.toBase58()} counter=${onChainCount}`,
        );

        // Defensive check: verify if an account already exists at the derived PDA address
        const accountInfo = await connection.getAccountInfo(positionPda);
        if (accountInfo !== null) {
          const errMessage = `COLLISION DETECTED: PDA account ${positionPda.toBase58()} (fixture=${position.fixtureId}, count=${onChainCount}) already exists on-chain before transaction call!`;
          this.logger.error(`[execution] ${errMessage}`);
          throw new Error(errMessage);
        }

        txSig = await program.methods
          .recordPosition(
            position.fixtureId,
            position.outcome,
            new anchor.BN(sizeInLamports),
            new anchor.BN(modelProb),
            new anchor.BN(marketProb),
            new anchor.BN(onChainCount),
          )
          .accounts({
            authority: keypair.publicKey,
            positionRecord: positionPda,
            fixtureCounter: counterPda,
            systemProgram: SystemProgram.programId,
          })
          .rpc({ commitment: 'confirmed' });

        this.logger.log(
          `[execution] CONFIRMED position=${posId} txSig=${txSig} attempt=${attempt}`,
        );
        finalOnChainCount = onChainCount;
        finalPositionPda = positionPda;
        break;
      } catch (err: any) {
        if (err && typeof err === 'object' && 'logs' in err) {
          this.logger.error(`[execution] SendTransactionError logs: ${JSON.stringify(err.logs, null, 2)}`);
          lastError = `Error: Simulation failed. Message: ${err.message}. Logs: ${JSON.stringify(err.logs)}`;
        } else {
          this.logger.error(`[execution] Raw error object: ${JSON.stringify(err, null, 2)}`);
          lastError = String(err);
        }
        this.logger.warn(
          `[execution] attempt ${attempt} FAILED position=${posId}: ${lastError}`,
        );

        if (attempt < MAX_TX_ATTEMPTS) {
          const waitMs = Math.pow(2, attempt) * 1000; // 2s, 4s
          this.logger.debug(`[execution] backing off ${waitMs}ms before retry`);
          await new Promise((r) => setTimeout(r, waitMs));
        }
      }
    }

    // ── 6. Persist final status ───────────────────────────────────────────────
    if (txSig) {
      const updated = await this.positionModel.findByIdAndUpdate(position._id, {
        $set: {
          status: 'executed',
          'reasoning.txSignature': txSig,
          'reasoning.positionPda': finalPositionPda.toBase58(),
          'reasoning.onChainCounter': finalOnChainCount,
        },
      }, { new: true });
      if (updated) {
        this.eventEmitter.emit('position.updated', updated);
      }
      this.logger.log(
        `[execution] position=${posId} → status=executed txSig=${txSig}`,
      );
    } else {
      // All attempts exhausted — mark failed, never leave in ambiguous state
      const updated = await this.positionModel.findByIdAndUpdate(position._id, {
        $set: {
          status: 'failed',
          'reasoning.failureReason': lastError,
          'reasoning.failedAt': new Date().toISOString(),
        },
      }, { new: true });
      if (updated) {
        this.eventEmitter.emit('position.updated', updated);
      }
      this.logger.error(
        `[execution] position=${posId} → status=failed after ${MAX_TX_ATTEMPTS} attempts: ${lastError}`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Balance helper — auto-airdrop if below threshold (devnet only)
  // -------------------------------------------------------------------------

  private async ensureSufficientBalance(
    connection: Connection,
    posId: string,
  ): Promise<void> {
    const keypair = this.walletProvider.getKeypair();
    const balance = await connection.getBalance(keypair.publicKey);
    const balanceSol = balance / LAMPORTS_PER_SOL;

    if (balanceSol >= MIN_BALANCE_SOL) {
      this.logger.debug(
        `[execution] balance=${balanceSol.toFixed(4)} SOL — sufficient`,
      );
      return;
    }

    this.logger.warn(
      `[execution] balance=${balanceSol.toFixed(4)} SOL is below ${MIN_BALANCE_SOL} SOL threshold ` +
        `for position=${posId} — requesting devnet airdrop of ${AIRDROP_SOL} SOL`,
    );

    try {
      const sig = await connection.requestAirdrop(
        keypair.publicKey,
        AIRDROP_SOL * LAMPORTS_PER_SOL,
      );
      await connection.confirmTransaction(sig, 'confirmed');
      const newBalance = await connection.getBalance(keypair.publicKey);
      this.logger.log(
        `[execution] airdrop confirmed — new balance=${(newBalance / LAMPORTS_PER_SOL).toFixed(4)} SOL`,
      );
    } catch (err) {
      // Airdrop failure is non-fatal — attempt the transaction anyway
      this.logger.warn(
        `[execution] airdrop request failed (devnet rate limit?): ${String(err)}`,
      );
    }
  }
}
