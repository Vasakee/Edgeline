use anchor_lang::prelude::*;

declare_id!("EAVB3QfGZmMhRvYmtTrsLLuaRYbe6yBRM6JMj68R4VS3");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// Maximum byte length for fixture_id string stored on-chain.
/// TxLINE fixture IDs are 8-digit integers, but we pad to 32 for safety.
const MAX_FIXTURE_ID_LEN: usize = 32;

/// Maximum byte length for outcome string: "home" | "draw" | "away"
const MAX_OUTCOME_LEN: usize = 8;

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------

#[program]
pub mod edgeline_vault {
    use super::*;

    /// record_position
    ///
    /// Creates a new PDA account logging an agent position on-chain.
    /// The PDA is seeded by ["position_v2", fixture_id, counter_bytes] so each
    /// fixture can have multiple sequential positions recorded.
    ///
    /// Arguments:
    ///   fixture_id  — TxLINE fixture ID string
    ///   outcome     — "home" | "draw" | "away"
    ///   size        — notional size in lamports (devnet SOL × 1_000_000_000)
    ///   model_prob  — fair-price model probability × 1_000_000 (e.g. 0.530 → 530_000)
    ///   market_prob — market implied probability × 1_000_000
    ///   counter     — sequential position counter for this fixture (0-indexed)
    pub fn record_position(
        ctx: Context<RecordPosition>,
        fixture_id: String,
        outcome: String,
        size: u64,
        model_prob: u64,
        market_prob: u64,
        counter: u64,
    ) -> Result<()> {
        require!(fixture_id.len() <= MAX_FIXTURE_ID_LEN, VaultError::FixtureIdTooLong);
        require!(outcome.len() <= MAX_OUTCOME_LEN, VaultError::OutcomeTooLong);
        require!(
            outcome == "home" || outcome == "draw" || outcome == "away",
            VaultError::InvalidOutcome
        );
        require!(model_prob <= 1_000_000, VaultError::InvalidProbability);
        require!(market_prob <= 1_000_000, VaultError::InvalidProbability);
        
        // Safety check: verify instruction counter matches on-chain counter
        require!(
            counter == ctx.accounts.fixture_counter.count,
            VaultError::InvalidCounter
        );

        let record = &mut ctx.accounts.position_record;
        record.authority = ctx.accounts.authority.key();
        record.fixture_id = fixture_id.clone();
        record.outcome = outcome.clone();
        record.size = size;
        record.model_prob = model_prob;
        record.market_prob = market_prob;
        record.counter = counter;
        record.status = PositionStatus::Pending;
        record.pnl = 0;
        record.recorded_at = Clock::get()?.unix_timestamp;
        record.settled_at = 0;
        record.bump = ctx.bumps.position_record;

        // Increment the counter for subsequent positions
        ctx.accounts.fixture_counter.count += 1;

        msg!(
            "edgeline: position recorded fixture={} outcome={} size={} model_prob={} market_prob={} counter={}",
            fixture_id,
            outcome,
            size,
            model_prob,
            market_prob,
            counter,
        );

        Ok(())
    }

    /// settle_position
    ///
    /// Updates an existing PositionRecord with the final settlement result.
    /// Only the original authority can settle their own position.
    ///
    /// Arguments:
    ///   outcome_correct — whether the agent's predicted outcome was correct
    ///   pnl             — realised profit/loss in lamports (signed; negative = loss)
    pub fn settle_position(
        ctx: Context<SettlePosition>,
        outcome_correct: bool,
        pnl: i64,
    ) -> Result<()> {
        let record = &mut ctx.accounts.position_record;

        require!(
            record.status == PositionStatus::Pending,
            VaultError::AlreadySettled
        );

        record.status = PositionStatus::Settled;
        record.pnl = pnl;
        record.settled_at = Clock::get()?.unix_timestamp;

        msg!(
            "edgeline: position settled fixture={} outcome={} correct={} pnl={}",
            record.fixture_id,
            record.outcome,
            outcome_correct,
            pnl,
        );

        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Account structs
// ---------------------------------------------------------------------------

#[account]
#[derive(Debug)]
pub struct PositionRecord {
    /// The wallet that recorded this position
    pub authority: Pubkey,         // 32
    /// TxLINE fixture ID string
    pub fixture_id: String,        // 4 + MAX_FIXTURE_ID_LEN
    /// "home" | "draw" | "away"
    pub outcome: String,           // 4 + MAX_OUTCOME_LEN
    /// Notional size in lamports
    pub size: u64,                 // 8
    /// Fair-price probability × 1_000_000
    pub model_prob: u64,           // 8
    /// Market implied probability × 1_000_000
    pub market_prob: u64,          // 8
    /// Sequential counter used in PDA seed
    pub counter: u64,              // 8
    /// Pending | Settled
    pub status: PositionStatus,    // 1 (enum)
    /// Realised PnL in lamports (0 until settled)
    pub pnl: i64,                  // 8
    /// Unix timestamp when recorded
    pub recorded_at: i64,          // 8
    /// Unix timestamp when settled (0 if pending)
    pub settled_at: i64,           // 8
    /// PDA bump
    pub bump: u8,                  // 1
}

impl PositionRecord {
    /// Space calculation:
    ///   8 (discriminator) + 32 + (4+32) + (4+8) + 8*6 + 1 + 8 + 1
    pub const SPACE: usize = 8 + 32 + (4 + MAX_FIXTURE_ID_LEN) + (4 + MAX_OUTCOME_LEN)
        + 8 + 8 + 8 + 8 + 1 + 8 + 8 + 8 + 1;
}

#[account]
#[derive(Debug)]
pub struct FixtureCounter {
    /// Sequential counter tracking positions created for a fixture
    pub count: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, Debug)]
pub enum PositionStatus {
    Pending,
    Settled,
}

// ---------------------------------------------------------------------------
// Contexts
// ---------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(fixture_id: String, outcome: String, size: u64, model_prob: u64, market_prob: u64, counter: u64)]
pub struct RecordPosition<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    /// The PDA is derived from ["position_v2", fixture_id, counter_bytes].
    /// This allows multiple positions per fixture while keeping them unique.
    #[account(
        init,
        payer = authority,
        space = PositionRecord::SPACE,
        seeds = [
            b"position_v2",
            fixture_id.as_bytes(),
            &counter.to_le_bytes(),
        ],
        bump,
    )]
    pub position_record: Account<'info, PositionRecord>,

    #[account(
        init_if_needed,
        payer = authority,
        space = 8 + 8, // discriminator + count
        seeds = [
            b"counter_v2",
            fixture_id.as_bytes(),
        ],
        bump,
    )]
    pub fixture_counter: Account<'info, FixtureCounter>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SettlePosition<'info> {
    /// Only the original authority can settle
    #[account(
        constraint = authority.key() == position_record.authority @ VaultError::Unauthorized
    )]
    pub authority: Signer<'info>,

    #[account(mut)]
    pub position_record: Account<'info, PositionRecord>,
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[error_code]
pub enum VaultError {
    #[msg("fixture_id exceeds maximum length")]
    FixtureIdTooLong,
    #[msg("outcome exceeds maximum length")]
    OutcomeTooLong,
    #[msg("outcome must be 'home', 'draw', or 'away'")]
    InvalidOutcome,
    #[msg("probability must be <= 1_000_000")]
    InvalidProbability,
    #[msg("position is already settled")]
    AlreadySettled,
    #[msg("only the original authority may settle this position")]
    Unauthorized,
    #[msg("passed counter does not match expected on-chain counter")]
    InvalidCounter,
}
