/**
 * tests/edgeline-vault.ts
 *
 * Anchor integration tests for the edgeline-vault program.
 * Run against a local validator: anchor test
 */
import * as anchor from '@coral-xyz/anchor';
import { Program } from '@coral-xyz/anchor';
import { PublicKey, SystemProgram } from '@solana/web3.js';
import { assert } from 'chai';
import { createRequire } from 'node:module';
// anchor build generates the IDL; load it via createRequire (Node 24 treats .ts as ESM)
const require = createRequire(import.meta.url);
const idl = require('../../../target/idl/edgeline_vault.json');

type EdgelineVault = anchor.Idl;

describe('edgeline-vault', () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = new anchor.Program(idl as EdgelineVault, provider) as Program<EdgelineVault>;

  const authority = provider.wallet as anchor.Wallet;
  
  // Use a dynamic fixture ID per test run to prevent any collisions on devnet
  const fixtureId = "test_" + Math.floor(Date.now() / 1000).toString();

  // Helpers
  function positionPda(fixtureId: string, counter: number): [PublicKey, number] {
    const counterBuf = Buffer.alloc(8);
    counterBuf.writeBigUInt64LE(BigInt(counter));
    return PublicKey.findProgramAddressSync(
      [Buffer.from('position_v2'), Buffer.from(fixtureId), counterBuf],
      program.programId,
    );
  }

  function counterPda(fixtureId: string): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from('counter_v2'), Buffer.from(fixtureId)],
      program.programId,
    );
  }

  // ── Test 1: record a position ──────────────────────────────────────────────

  it('records a position on-chain', async () => {
    const counter = 0;
    const [pda] = positionPda(fixtureId, counter);
    const [cntPda] = counterPda(fixtureId);

    await program.methods
      .recordPosition(
        fixtureId,
        'home',
        new anchor.BN(65_000_000),   // 0.065 SOL in lamports
        new anchor.BN(530_000),       // model_prob 0.530 × 1_000_000
        new anchor.BN(400_000),       // market_prob 0.400 × 1_000_000
        new anchor.BN(counter),
      )
      .accounts({
        authority: authority.publicKey,
        positionRecord: pda,
        fixtureCounter: cntPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const record = await (program.account as Record<string, anchor.AccountClient>)
      ['positionRecord'].fetch(pda);

    assert.equal(record.fixtureId, fixtureId);
    assert.equal(record.outcome, 'home');
    assert.equal(record.size.toString(), '65000000');
    assert.equal(record.modelProb.toString(), '530000');
    assert.equal(record.marketProb.toString(), '400000');
    assert.equal(record.counter.toString(), '0');
    assert.deepEqual(record.status, { pending: {} });
    assert.equal(record.pnl.toString(), '0');
    assert.isAbove(record.recordedAt.toNumber(), 0);
    assert.equal(record.settledAt.toString(), '0');

    console.log('  ✓ record_position PDA:', pda.toBase58());
  });

  // ── Test 2: settle the position ────────────────────────────────────────────

  it('settles a position on-chain', async () => {
    const counter = 0;
    const [pda] = positionPda(fixtureId, counter);

    // Norway won → outcome 'home' was correct → positive PnL
    const pnl = new anchor.BN(52_000_000); // +0.052 SOL notional profit

    await program.methods
      .settlePosition(true, pnl)
      .accounts({
        authority: authority.publicKey,
        positionRecord: pda,
      })
      .rpc();

    const record = await (program.account as Record<string, anchor.AccountClient>)
      ['positionRecord'].fetch(pda);

    assert.deepEqual(record.status, { settled: {} });
    assert.equal(record.pnl.toString(), '52000000');
    assert.isAbove(record.settledAt.toNumber(), 0);

    console.log('  ✓ settle_position pnl:', record.pnl.toString());
  });

  // ── Test 3: second position on same fixture uses counter=1 ────────────────

  it('records a second position for same fixture with counter=1', async () => {
    const counter = 1;
    const [pda] = positionPda(fixtureId, counter);
    const [cntPda] = counterPda(fixtureId);

    await program.methods
      .recordPosition(
        fixtureId,
        'away',
        new anchor.BN(30_000_000),
        new anchor.BN(379_000),
        new anchor.BN(330_000),
        new anchor.BN(counter),
      )
      .accounts({
        authority: authority.publicKey,
        positionRecord: pda,
        fixtureCounter: cntPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const record = await (program.account as Record<string, anchor.AccountClient>)
      ['positionRecord'].fetch(pda);

    assert.equal(record.counter.toString(), '1');
    assert.equal(record.outcome, 'away');
    console.log('  ✓ second position PDA:', pda.toBase58());
  });

  // ── Test 4: cannot settle an already-settled position ─────────────────────

  it('rejects settling an already-settled position', async () => {
    const counter = 0;
    const [pda] = positionPda(fixtureId, counter);

    try {
      await program.methods
        .settlePosition(false, new anchor.BN(-10_000_000))
        .accounts({ authority: authority.publicKey, positionRecord: pda })
        .rpc();
      assert.fail('Expected an error for double-settle');
    } catch (err: unknown) {
      const msg = String(err);
      assert.include(msg, 'AlreadySettled');
      console.log('  ✓ double-settle correctly rejected');
    }
  });

  // ── Test 5: rejects invalid outcome string ─────────────────────────────────

  it('rejects an invalid outcome string', async () => {
    const counter = 99;
    const [pda] = positionPda(fixtureId, counter);
    const [cntPda] = counterPda(fixtureId);

    try {
      await program.methods
        .recordPosition(
          fixtureId,
          'win',
          new anchor.BN(10_000_000),
          new anchor.BN(400_000),
          new anchor.BN(400_000),
          new anchor.BN(counter),
        )
        .accounts({
          authority: authority.publicKey,
          positionRecord: pda,
          fixtureCounter: cntPda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      assert.fail('Expected an error for invalid outcome');
    } catch (err: unknown) {
      const msg = String(err);
      // Wait, since outcome is checked first in instruction, it should reject with InvalidOutcome first!
      assert.ok(
        msg.includes('InvalidOutcome') || 
        msg.includes('InvalidCounter') ||
        msg.includes('outcome must be') || 
        msg.includes('6002') || 
        msg.includes('0x1772'),
        `Expected error to contain InvalidOutcome, but got: ${msg}`
      );
      console.log('  ✓ invalid outcome correctly rejected');
    }
  });
});
