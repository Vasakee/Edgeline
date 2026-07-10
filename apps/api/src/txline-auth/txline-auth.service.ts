import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as anchor from '@coral-xyz/anchor';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
} from '@solana/spl-token';
import { Connection, PublicKey, SystemProgram } from '@solana/web3.js';
import axios, { AxiosError } from 'axios';
import nacl from 'tweetnacl';
import { WalletProvider } from './wallet.provider';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const txoracleIdl = require('./idl/txoracle-devnet.json') as anchor.Idl;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ActivatedToken {
  /**
   * The static API key returned by /api/token/activate.
   * Confirmed format: "txoracle_api_<hex>" — long-lived (23h+).
   */
  token: string;
  /** ISO timestamp when we last activated — used to detect re-activation */
  activatedAt: Date;
}

/**
 * AuthHeaders
 *
 * Both headers are required on every data API call (confirmed from live testing):
 *   Authorization: Bearer <guestJwt>   — short-lived, must be fresh each poll cycle
 *   X-Api-Token:   <staticApiKey>      — long-lived, cached for 23h
 *
 * The guest JWT expires within minutes. It must NOT be cached across poll cycles.
 */
export interface AuthHeaders extends Record<string, string> {
  Authorization: string;
  'X-Api-Token': string;
}

// ---------------------------------------------------------------------------
// Network config (docs: https://txline.txodds.com/documentation/quickstart)
// ---------------------------------------------------------------------------

const DEVNET_CONFIG = {
  rpcUrl: 'https://api.devnet.solana.com',
  apiOrigin: 'https://txline-dev.txodds.com',
  programId: new PublicKey('6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J'),
  txlTokenMint: new PublicKey('4Zao8ocPhmMgq7PdsYWyxvqySMGx7xb9cMftPMkEokRG'),
} as const;

/**
 * Free World Cup tier:
 *   SERVICE_LEVEL_ID = 1  → World Cup & Int Friendlies, 60-second delay
 *   SELECTED_LEAGUES = [] → standard bundle; message becomes `${txSig}::${jwt}`
 *
 * No TxL tokens are required — the on-chain price for service level 1 is 0.
 * Source: https://txline.txodds.com/documentation/worldcup
 */
const FREE_TIER_SERVICE_LEVEL_ID = 1;
const FREE_TIER_DURATION_WEEKS = 4;

@Injectable()
export class TxlineAuthService {
  private readonly logger = new Logger(TxlineAuthService.name);

  /** Cached activated token; null until first activation */
  private cachedToken: ActivatedToken | null = null;

  /** Approximate token lifetime — the API doesn't expose expiry in the
   *  response, so we conservatively re-activate after 23 hours. */
  private readonly TOKEN_TTL_MS = 23 * 60 * 60 * 1000;

  private readonly apiOrigin: string;
  private readonly apiBaseUrl: string;
  private readonly rpcUrl: string;
  private readonly selectedLeagues: number[];
  private readonly useFreeWorldCupTier: boolean;

  constructor(
    private readonly config: ConfigService,
    private readonly walletProvider: WalletProvider,
  ) {
    this.apiOrigin =
      this.config.get<string>('TXLINE_BASE_URL') ?? DEVNET_CONFIG.apiOrigin;
    this.apiBaseUrl = `${this.apiOrigin}/api`;
    this.rpcUrl =
      this.config.get<string>('SOLANA_RPC_URL') ?? DEVNET_CONFIG.rpcUrl;

    const leaguesRaw = this.config.get<string>('SELECTED_LEAGUES') ?? '';
    this.selectedLeagues = leaguesRaw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map(Number);

    this.useFreeWorldCupTier =
      this.config.get<string>('USE_FREE_WORLDCUP_TIER') === 'true';
  }

  // -------------------------------------------------------------------------
  // Step 1: Get a short-lived guest JWT
  // -------------------------------------------------------------------------

  /**
   * POST {apiOrigin}/auth/guest/start — no body required.
   * Returns the `token` field from the response.
   */
  async getGuestJwt(): Promise<string> {
    this.logger.debug('Requesting guest JWT…');
    try {
      const res = await axios.post<{ token: string }>(
        `${this.apiOrigin}/auth/guest/start`,
      );
      const jwt = res.data.token;
      if (!jwt) {
        throw new Error(
          `guest/start response missing 'token' field: ${JSON.stringify(res.data)}`,
        );
      }
      this.logger.debug('Guest JWT acquired.');
      return jwt;
    } catch (err) {
      throw this.wrapAxiosError('getGuestJwt', err);
    }
  }

  // -------------------------------------------------------------------------
  // Step 2a: Subscribe on-chain (free World Cup tier)
  // -------------------------------------------------------------------------

  /**
   * Subscribes the wallet to the free World Cup tier (service level 1) using
   * the Anchor program on devnet.
   *
   * Per the docs, free tiers require no TxL payment — the on-chain price for
   * service level 1 is 0.  The call still registers the subscription on-chain
   * and must be activated with the matching API host.
   *
   * Returns the confirmed transaction signature.
   */
  async subscribeOnChainFreeTier(): Promise<string> {
    this.logger.log(
      `Subscribing on-chain (free tier, service level ${FREE_TIER_SERVICE_LEVEL_ID}, ${FREE_TIER_DURATION_WEEKS} weeks)…`,
    );

    const keypair = this.walletProvider.getKeypair();
    const connection = new Connection(this.rpcUrl, 'confirmed');

    // Wrap keypair into an Anchor NodeWallet
    const anchorWallet = new anchor.Wallet(keypair);
    const provider = new anchor.AnchorProvider(connection, anchorWallet, {
      commitment: 'confirmed',
    });
    anchor.setProvider(provider);

    const program = new anchor.Program(txoracleIdl, provider);

    // Verify the loaded IDL matches the expected program address
    if (!program.programId.equals(DEVNET_CONFIG.programId)) {
      throw new Error(
        `IDL program ID ${program.programId.toBase58()} does not match ` +
          `expected devnet program ${DEVNET_CONFIG.programId.toBase58()}`,
      );
    }

    // Derive shared PDAs (docs: subscribe on-chain section)
    const [tokenTreasuryPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('token_treasury_v2')],
      program.programId,
    );

    const tokenTreasuryVault = getAssociatedTokenAddressSync(
      DEVNET_CONFIG.txlTokenMint,
      tokenTreasuryPda,
      true,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );

    const [pricingMatrixPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('pricing_matrix')],
      program.programId,
    );

    const userTokenAccount = getAssociatedTokenAddressSync(
      DEVNET_CONFIG.txlTokenMint,
      provider.wallet.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );

    // The subscribe instruction requires the ATA to already exist.
    // Create it now if it doesn't (no-op if it does).
    this.logger.debug('Ensuring TxL token ATA exists…');
    await getOrCreateAssociatedTokenAccount(
      connection,
      keypair,           // fee payer
      DEVNET_CONFIG.txlTokenMint,
      keypair.publicKey,
      false,
      'confirmed',
      undefined,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );

    const txSig = await program.methods
      .subscribe(FREE_TIER_SERVICE_LEVEL_ID, FREE_TIER_DURATION_WEEKS)
      .accounts({
        user: provider.wallet.publicKey,
        pricingMatrix: pricingMatrixPda,
        tokenMint: DEVNET_CONFIG.txlTokenMint,
        userTokenAccount,
        tokenTreasuryVault,
        tokenTreasuryPda,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    this.logger.log(`On-chain subscription confirmed: ${txSig}`);
    return txSig;
  }

  // -------------------------------------------------------------------------
  // Step 2b: Build activation message and sign it
  // -------------------------------------------------------------------------

  /**
   * Builds the activation message string per the docs:
   *   `${txSig}:${SELECTED_LEAGUES.join(",")}:${jwt}`
   *
   * When SELECTED_LEAGUES is empty (free World Cup tier), this becomes:
   *   `${txSig}::${jwt}`
   *
   * Signs with the wallet secret key using nacl.sign.detached and
   * returns the base64-encoded signature.
   */
  buildActivationSignature(txSig: string, jwt: string): string {
    const messageString = `${txSig}:${this.selectedLeagues.join(',')}:${jwt}`;
    const message = new TextEncoder().encode(messageString);
    const keypair = this.walletProvider.getKeypair();
    const signatureBytes = nacl.sign.detached(message, keypair.secretKey);
    return Buffer.from(signatureBytes).toString('base64');
  }

  // -------------------------------------------------------------------------
  // Step 3: Activate the API token
  // -------------------------------------------------------------------------

  /**
   * POST {apiBaseUrl}/token/activate
   * Headers: Authorization: Bearer <guestJwt>
   * Body: { txSig, walletSignature, leagues: SELECTED_LEAGUES }
   *
   * Returns the activated API token string.
   * On failure, logs the full response body before re-throwing.
   */
  async activateToken(txSig: string, jwt: string): Promise<string> {
    const walletSignature = this.buildActivationSignature(txSig, jwt);
    this.logger.debug(
      `Activating token (txSig=${txSig.slice(0, 8)}…, leagues=${JSON.stringify(this.selectedLeagues)})`,
    );

    try {
      const res = await axios.post<{ token?: string } | string>(
        `${this.apiBaseUrl}/token/activate`,
        {
          txSig,
          walletSignature,
          leagues: this.selectedLeagues,
        },
        {
          headers: { Authorization: `Bearer ${jwt}` },
        },
      );

      // The API returns either { token: "..." } or the token string directly
      const raw = res.data;
      const token =
        typeof raw === 'string' ? raw : (raw as { token?: string }).token;

      if (!token) {
        throw new Error(
          `Activation response missing token field: ${JSON.stringify(raw)}`,
        );
      }

      this.logger.log('API token activated successfully.');
      return token;
    } catch (err) {
      throw this.wrapAxiosError('activateToken', err);
    }
  }

  // -------------------------------------------------------------------------
  // Public API: getAuthHeaders()
  // -------------------------------------------------------------------------

  /**
   * Returns the two auth headers required for every TxLINE data API call.
   *
   * The guest JWT is fetched fresh on every call — it expires within minutes
   * and must not be cached across poll cycles.
   *
   * The static API key (txoracle_api_*) is cached for TOKEN_TTL_MS (23h).
   * On first call or after expiry, it re-runs the full activation flow.
   */
  async getAuthHeaders(): Promise<AuthHeaders> {
    // Always fetch a fresh guest JWT — do not cache
    const jwt = await this.getGuestJwt();

    // Cached static API key — only re-activates when stale
    const { token: apiKey } = await this.getValidToken();

    return {
      Authorization: `Bearer ${jwt}`,
      'X-Api-Token': apiKey,
    };
  }

  // -------------------------------------------------------------------------
  // Public API: getValidToken() — static API key cache
  // -------------------------------------------------------------------------

  /**
   * Returns the cached static API key, re-activating if stale.
   * Do NOT use this directly for data requests — use getAuthHeaders() instead,
   * which pairs the static key with a fresh guest JWT.
   */
  private activationPromise: Promise<ActivatedToken> | null = null;

  async getValidToken(): Promise<ActivatedToken> {
    if (this.cachedToken) {
      const ageMs = Date.now() - this.cachedToken.activatedAt.getTime();
      if (ageMs < this.TOKEN_TTL_MS) {
        this.logger.debug('Returning cached API token.');
        return this.cachedToken;
      }
      this.logger.log('Cached token is stale — re-activating…');
    }

    // Mutex: if activation is already in progress, wait for it
    if (this.activationPromise) {
      this.logger.debug('Activation already in progress — waiting…');
      return this.activationPromise;
    }

    this.activationPromise = this.doActivation();
    try {
      return await this.activationPromise;
    } finally {
      this.activationPromise = null;
    }
  }

  private async doActivation(): Promise<ActivatedToken> {
    if (this.useFreeWorldCupTier) {
      this.logger.log('USE_FREE_WORLDCUP_TIER=true — using free World Cup tier.');
    }

    // Step 1: Guest JWT
    const jwt = await this.getGuestJwt();

    // Step 2: Subscribe on-chain
    const txSig = await this.subscribeOnChainFreeTier();

    // Step 3: Activate
    const token = await this.activateToken(txSig, jwt);

    this.cachedToken = { token, activatedAt: new Date() };
    return this.cachedToken;
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /**
   * Wraps an Axios error to include the full response body in the message,
   * making it easy to debug activation failures without inspecting raw objects.
   */
  private wrapAxiosError(context: string, err: unknown): Error {
    if (err instanceof AxiosError) {
      const status = err.response?.status ?? 'no-status';
      const body = err.response?.data
        ? JSON.stringify(err.response.data, null, 2)
        : err.message;
      const message = `[${context}] HTTP ${status}: ${body}`;
      this.logger.error(message);
      return new Error(message);
    }
    return err instanceof Error ? err : new Error(String(err));
  }
}
