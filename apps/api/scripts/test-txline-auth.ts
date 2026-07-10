/**
 * scripts/test-txline-auth.ts
 *
 * End-to-end test of the TxLINE authentication flow.
 * Runs standalone — does NOT boot the full NestJS application.
 *
 * Usage (from edgeline root):
 *   pnpm --filter @edgeline/api ts-node scripts/test-txline-auth.ts
 *
 * Or from apps/api:
 *   npx ts-node -P tsconfig.json scripts/test-txline-auth.ts
 *
 * Prerequisites:
 *   1. Copy .env.example → apps/api/.env and fill in SOLANA_WALLET_PATH.
 *   2. The wallet must have enough SOL for transaction fees (devnet airdrop if needed).
 */

// Load .env from apps/api/.env (ts-node runs from apps/api)
import * as path from 'path';
import * as fs from 'fs';
import * as dotenv from 'dotenv';

// Resolve .env relative to this script's directory parent (apps/api)
const envPath = path.resolve(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
  console.log(`[env] Loaded ${envPath}`);
} else {
  console.warn(`[env] No .env file found at ${envPath} — relying on process.env`);
}

import * as anchor from '@coral-xyz/anchor';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
} from '@solana/spl-token';
import { Connection, Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import axios, { AxiosError } from 'axios';
import nacl from 'tweetnacl';

// ---------------------------------------------------------------------------
// Config from environment
// ---------------------------------------------------------------------------

function requireEnv(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Missing required env var: ${key}`);
  return v;
}

const WALLET_PATH = requireEnv('SOLANA_WALLET_PATH');
const RPC_URL = process.env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com';
const API_ORIGIN =
  process.env.TXLINE_BASE_URL ?? 'https://txline-dev.txodds.com';
const API_BASE_URL = `${API_ORIGIN}/api`;
const USE_FREE_TIER = process.env.USE_FREE_WORLDCUP_TIER !== 'false'; // default true
const SELECTED_LEAGUES: number[] = (process.env.SELECTED_LEAGUES ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map(Number);

// Devnet program constants (docs: https://txline.txodds.com/documentation/programs/devnet)
const PROGRAM_ID = new PublicKey('6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J');
const TXL_TOKEN_MINT = new PublicKey('4Zao8ocPhmMgq7PdsYWyxvqySMGx7xb9cMftPMkEokRG');

// Free tier constants (docs: https://txline.txodds.com/documentation/worldcup)
const FREE_SERVICE_LEVEL_ID = 1;
const FREE_DURATION_WEEKS = 4;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadKeypair(walletPath: string): Keypair {
  const resolved = path.resolve(walletPath.replace('~', process.env.HOME ?? '~'));
  const raw: number[] = JSON.parse(fs.readFileSync(resolved, 'utf-8')) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function axiosErrorBody(err: unknown): string {
  if (err instanceof AxiosError && err.response?.data) {
    return JSON.stringify(err.response.data, null, 2);
  }
  return String(err);
}

// ---------------------------------------------------------------------------
// Step 1: Get guest JWT
// ---------------------------------------------------------------------------

async function getGuestJwt(): Promise<string> {
  console.log('\n[1/3] Requesting guest JWT…');
  try {
    const res = await axios.post<{ token: string }>(
      `${API_ORIGIN}/auth/guest/start`,
    );
    const jwt = res.data.token;
    if (!jwt) throw new Error(`Response missing 'token': ${JSON.stringify(res.data)}`);
    console.log('      ✓ Guest JWT acquired');
    return jwt;
  } catch (err) {
    console.error('      ✗ getGuestJwt failed:', axiosErrorBody(err));
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Step 2: Subscribe on-chain (free World Cup tier)
// ---------------------------------------------------------------------------

async function subscribeOnChain(keypair: Keypair): Promise<string> {
  console.log(
    `\n[2/3] Subscribing on-chain (service level ${FREE_SERVICE_LEVEL_ID}, ${FREE_DURATION_WEEKS} weeks, no TxL required)…`,
  );
  console.log(`      Wallet: ${keypair.publicKey.toBase58()}`);
  console.log(`      RPC:    ${RPC_URL}`);

  const connection = new Connection(RPC_URL, 'confirmed');
  const wallet = new anchor.Wallet(keypair);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: 'confirmed',
  });
  anchor.setProvider(provider);

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const idl = require(
    path.resolve(__dirname, '../src/txline-auth/idl/txoracle-devnet.json'),
  ) as anchor.Idl;

  const program = new anchor.Program(idl, provider);

  if (!program.programId.equals(PROGRAM_ID)) {
    throw new Error(
      `IDL program ID ${program.programId.toBase58()} does not match expected ${PROGRAM_ID.toBase58()}`,
    );
  }

  const [tokenTreasuryPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('token_treasury_v2')],
    program.programId,
  );

  const tokenTreasuryVault = getAssociatedTokenAddressSync(
    TXL_TOKEN_MINT,
    tokenTreasuryPda,
    true,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );

  const [pricingMatrixPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('pricing_matrix')],
    program.programId,
  );

  // Derive the user's TxL ATA address
  const userTokenAccount = getAssociatedTokenAddressSync(
    TXL_TOKEN_MINT,
    keypair.publicKey,
    false,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );

  // The subscribe instruction requires the ATA to already exist.
  // Create it now if it doesn't (no-op if it does).
  console.log('      Ensuring TxL token account exists…');
  await getOrCreateAssociatedTokenAccount(
    connection,
    keypair,           // fee payer
    TXL_TOKEN_MINT,
    keypair.publicKey,
    false,
    'confirmed',
    undefined,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  console.log(`      TxL ATA: ${userTokenAccount.toBase58()}`);

  try {
    const txSig = await program.methods
      .subscribe(FREE_SERVICE_LEVEL_ID, FREE_DURATION_WEEKS)
      .accounts({
        user: keypair.publicKey,
        pricingMatrix: pricingMatrixPda,
        tokenMint: TXL_TOKEN_MINT,
        userTokenAccount,
        tokenTreasuryVault,
        tokenTreasuryPda,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    console.log(`      ✓ Subscription confirmed: ${txSig}`);
    return txSig;
  } catch (err) {
    console.error('      ✗ subscribeOnChain failed:', String(err));
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Step 3: Activate token
// ---------------------------------------------------------------------------

async function activateToken(
  txSig: string,
  jwt: string,
  keypair: Keypair,
): Promise<string> {
  console.log('\n[3/3] Activating API token…');
  console.log(
    `      leagues=${JSON.stringify(SELECTED_LEAGUES)}, txSig=${txSig.slice(0, 8)}…`,
  );

  const messageString = `${txSig}:${SELECTED_LEAGUES.join(',')}:${jwt}`;
  const message = new TextEncoder().encode(messageString);
  const signatureBytes = nacl.sign.detached(message, keypair.secretKey);
  const walletSignature = Buffer.from(signatureBytes).toString('base64');

  try {
    const res = await axios.post<{ token?: string } | string>(
      `${API_BASE_URL}/token/activate`,
      {
        txSig,
        walletSignature,
        leagues: SELECTED_LEAGUES,
      },
      {
        headers: { Authorization: `Bearer ${jwt}` },
      },
    );

    const raw = res.data;
    const token =
      typeof raw === 'string' ? raw : (raw as { token?: string }).token;

    if (!token) {
      throw new Error(
        `Activation response missing token field.\nFull response: ${JSON.stringify(raw, null, 2)}`,
      );
    }

    console.log('      ✓ Token activated');
    return token;
  } catch (err) {
    console.error('      ✗ activateToken failed.\n      Full response body:');
    console.error(axiosErrorBody(err));
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  TxLINE Auth Flow — End-to-End Test');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  API origin:      ${API_ORIGIN}`);
  console.log(`  RPC URL:         ${RPC_URL}`);
  console.log(`  Free World Cup:  ${USE_FREE_TIER}`);
  console.log(`  Selected leagues: ${SELECTED_LEAGUES.length ? SELECTED_LEAGUES.join(', ') : '(empty — standard bundle)'}`);

  const keypair = loadKeypair(WALLET_PATH);
  console.log(`  Wallet:          ${keypair.publicKey.toBase58()}`);

  const jwt = await getGuestJwt();
  const txSig = await subscribeOnChain(keypair);
  const apiToken = await activateToken(txSig, jwt, keypair);

  const activatedAt = new Date();
  // Token TTL is not included in the activation response; 23h is a safe assumption
  const expiresAt = new Date(activatedAt.getTime() + 23 * 60 * 60 * 1000);

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  ✅  Authentication successful!');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  API Token:   ${apiToken}`);
  console.log(`  Activated:   ${activatedAt.toISOString()}`);
  console.log(`  Expires ~:   ${expiresAt.toISOString()} (estimated 23h TTL)`);
  console.log('');
  console.log('  Use these headers for data API calls:');
  console.log(`    Authorization: Bearer <guest-jwt>`);
  console.log(`    X-Api-Token:   ${apiToken}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
}

main().catch((err) => {
  console.error('\n❌  Auth flow failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
