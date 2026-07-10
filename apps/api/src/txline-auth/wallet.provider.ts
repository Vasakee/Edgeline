import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Keypair } from '@solana/web3.js';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Loads a Solana keypair from the file path specified by SOLANA_WALLET_PATH.
 * The file must be a solana-keygen–style JSON array of 64 bytes, e.g.:
 *   [12,34,56,...] (64 numbers)
 *
 * Never hardcodes or logs secret key bytes.
 */
@Injectable()
export class WalletProvider implements OnModuleInit {
  private readonly logger = new Logger(WalletProvider.name);
  private keypair!: Keypair;

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    const walletPath = this.config.getOrThrow<string>('SOLANA_WALLET_PATH');
    const resolved = path.resolve(walletPath);

    if (!fs.existsSync(resolved)) {
      throw new Error(
        `Wallet file not found at ${resolved}. ` +
          `Set SOLANA_WALLET_PATH to a valid solana-keygen JSON keypair.`,
      );
    }

    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(resolved, 'utf-8'));
    } catch (err) {
      throw new Error(`Failed to parse wallet file at ${resolved}: ${String(err)}`);
    }

    if (!Array.isArray(raw) || raw.length !== 64) {
      throw new Error(
        `Wallet file at ${resolved} must be a JSON array of exactly 64 bytes. ` +
          `Got ${Array.isArray(raw) ? raw.length : typeof raw} element(s).`,
      );
    }

    this.keypair = Keypair.fromSecretKey(Uint8Array.from(raw as number[]));
    this.logger.log(`Wallet loaded: ${this.keypair.publicKey.toBase58()}`);
  }

  getKeypair(): Keypair {
    return this.keypair;
  }

  getPublicKeyBase58(): string {
    return this.keypair.publicKey.toBase58();
  }
}
