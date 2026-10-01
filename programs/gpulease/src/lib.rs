use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Mint, MintTo, Token, TokenAccount, Transfer};

declare_id!("FR5U3cAx8jhCn2vH9WHcYfqgx11qEzaDdZ5afMooLkJY");

// ============================================================================
// GPULEASE â€” market for idle GPUs
//
// Adapted from 0xnurda/vault-dev (simple_vault) for Solana Create.
// Original 3 functions: initialize_vault â†’ deposit â†’ withdraw
// Ours, same mechanics, our semantics:
//   initialize_market â†’ place_order â†’ settle_order
//
// The original vault was a pooled share-token vault. We kept that exact
// mechanism because it *is* an escrow, which is what our product needs:
// buyer locks payment, provider redeems it after work is done.
// ============================================================================

#[program]
pub mod gpulease {
    use super::*;

    /// Step 1. Register a compute provider (a person renting out idle GPUs).
    ///
    /// Creates three PDAs:
    ///   market_state   â€” our business logic + counters
    ///   market_vault   â€” token account holding escrowed payments
    ///   receipt_mint   â€” mint for "receipt" tokens = proof of deposit
    pub fn initialize_market(
        ctx: Context<InitializeMarket>,
        provider_name: String,
        gpu_count: u32,
    ) -> Result<()> {
        let market = &mut ctx.accounts.market_state;

        market.provider = ctx.accounts.provider.key();
        market.payment_mint = ctx.accounts.payment_mint.key();
        market.market_vault = ctx.accounts.market_vault.key();
        market.receipt_mint = ctx.accounts.receipt_mint.key();
        market.provider_name = provider_name;
        market.gpu_count = gpu_count;
        market.total_paid = 0;
        market.total_receipts = 0;
        market.orders_completed = 0;
        market.orders_cancelled = 0;
        market.bump = ctx.bumps.market_state;

        msg!(
            "Market registered: provider={} gpus={} name={}",
            market.provider,
            market.gpu_count,
            market.provider_name
        );
        Ok(())
    }

    /// Step 2. A customer places an order and locks payment in the vault.
    ///
    /// On-chain escrow: tokens move customer â†’ market_vault. Customer gets
    /// receipt tokens back. Nobody can take the money until settle_order is
    /// called, so the provider cannot run away and the customer cannot chargeback.
    ///
    /// Receipt math (unchanged from the original vault):
    ///   first order:  receipts = amount                       (1:1)
    ///   later orders: receipts = amount * total_r / total_paid
    pub fn place_order(ctx: Context<PlaceOrder>, amount: u64) -> Result<()> {
        require!(amount > 0, MarketError::ZeroAmount);

        let market = &ctx.accounts.market_state;

        let receipts = if market.total_receipts == 0 || market.total_paid == 0 {
            amount
        } else {
            (amount as u128)
                .checked_mul(market.total_receipts as u128)
                .and_then(|v| v.checked_div(market.total_paid as u128))
                .and_then(|v| u64::try_from(v).ok())
                .ok_or(MarketError::MathOverflow)?
        };

        require!(receipts > 0, MarketError::ReceiptTooSmall);

        // 1. Lock payment: customer â†’ market_vault
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.customer_payment_account.to_account_info(),
                    to: ctx.accounts.market_vault.to_account_info(),
                    authority: ctx.accounts.customer.to_account_info(),
                },
            ),
            amount,
        )?;

        // 2. Mint receipt as proof of deposit
        let mint_key = ctx.accounts.market_state.payment_mint;
        let seeds: &[&[u8]] = &[
            b"market",
            mint_key.as_ref(),
            &[ctx.accounts.market_state.bump],
        ];

        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.receipt_mint.to_account_info(),
                    to: ctx.accounts.customer_receipt_account.to_account_info(),
                    authority: ctx.accounts.market_state.to_account_info(),
                },
                &[seeds],
            ),
            receipts,
        )?;

        // 3. Update counters
        let market = &mut ctx.accounts.market_state;
        market.total_paid = market
            .total_paid
            .checked_add(amount)
            .ok_or(MarketError::MathOverflow)?;
        market.total_receipts = market
            .total_receipts
            .checked_add(receipts)
            .ok_or(MarketError::MathOverflow)?;

        msg!(
            "Order placed: {} paid -> {} receipts escrowed (total_paid={}, total_receipts={})",
            amount, receipts, market.total_paid, market.total_receipts
        );
        Ok(())
    }

    /// Step 3. Provider settles: burns receipts, releases payment.
    ///
    /// Only the provider who registered the market can call this.
    /// Receipts are burned, so the customer's proof disappears â€” that is
    /// the "work delivered" signal recorded on-chain.
    pub fn settle_order(ctx: Context<SettleOrder>, receipts_burned: u64) -> Result<()> {
        require!(receipts_burned > 0, MarketError::ZeroAmount);

        let market = &ctx.accounts.market_state;
        require!(market.total_receipts > 0, MarketError::MarketEmpty);

        let payout = (receipts_burned as u128)
            .checked_mul(market.total_paid as u128)
            .and_then(|v| v.checked_div(market.total_receipts as u128))
            .and_then(|v| u64::try_from(v).ok())
            .ok_or(MarketError::MathOverflow)?;

        require!(payout > 0, MarketError::PayoutTooSmall);

        let mint_key = ctx.accounts.market_state.payment_mint;
        let seeds: &[&[u8]] = &[
            b"market",
            mint_key.as_ref(),
            &[ctx.accounts.market_state.bump],
        ];

        // 1. Burn the customer's receipts
        token::burn(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Burn {
                    mint: ctx.accounts.receipt_mint.to_account_info(),
                    from: ctx.accounts.customer_receipt_account.to_account_info(),
                    authority: ctx.accounts.customer.to_account_info(),
                },
            ),
            receipts_burned,
        )?;

        // 2. Release escrow: market_vault â†’ provider
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.market_vault.to_account_info(),
                    to: ctx.accounts.provider_payment_account.to_account_info(),
                    authority: ctx.accounts.market_state.to_account_info(),
                },
                &[seeds],
            ),
            payout,
        )?;

        // 3. Update counters
        let market = &mut ctx.accounts.market_state;
        market.total_paid = market
            .total_paid
            .checked_sub(payout)
            .ok_or(MarketError::MathOverflow)?;
        market.total_receipts = market
            .total_receipts
            .checked_sub(receipts_burned)
            .ok_or(MarketError::MathOverflow)?;
        market.orders_completed = market
            .orders_completed
            .checked_add(1)
            .ok_or(MarketError::MathOverflow)?;

        msg!(
            "Order settled: {} receipts -> {} paid to provider (completed={})",
            receipts_burned, payout, market.orders_completed
        );
        Ok(())
    }
}

// ============================================================================
// Accounts
// ============================================================================

#[derive(Accounts)]
pub struct InitializeMarket<'info> {
    /// Our business logic. seeds: ["market", payment_mint]
    #[account(
        init,
        payer = provider,
        space = MarketState::LEN,
        seeds = [b"market", payment_mint.key().as_ref()],
        bump,
    )]
    pub market_state: Account<'info, MarketState>,

    /// Escrow account. Holds customer money until the job is done.
    #[account(
        init,
        payer = provider,
        token::mint = payment_mint,
        token::authority = market_state,
        seeds = [b"market_vault", payment_mint.key().as_ref()],
        bump,
    )]
    pub market_vault: Account<'info, TokenAccount>,

    /// Receipt mint â€” controlled by market_state PDA
    #[account(
        init,
        payer = provider,
        mint::decimals = 6,
        mint::authority = market_state,
        seeds = [b"receipt_mint", payment_mint.key().as_ref()],
        bump,
    )]
    pub receipt_mint: Account<'info, Mint>,

    /// Token customers pay in (devnet USDC or any test token)
    pub payment_mint: Account<'info, Mint>,

    #[account(mut)]
    pub provider: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct PlaceOrder<'info> {
    #[account(
        mut,
        seeds = [b"market", market_state.payment_mint.as_ref()],
        bump = market_state.bump,
    )]
    pub market_state: Account<'info, MarketState>,

    #[account(
        mut,
        seeds = [b"market_vault", market_state.payment_mint.as_ref()],
        bump,
        token::mint = market_state.payment_mint,
        token::authority = market_state,
    )]
    pub market_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [b"receipt_mint", market_state.payment_mint.as_ref()],
        bump,
        mint::authority = market_state,
    )]
    pub receipt_mint: Account<'info, Mint>,

    /// Customer's payment account
    #[account(
        mut,
        token::mint = market_state.payment_mint,
        token::authority = customer,
    )]
    pub customer_payment_account: Account<'info, TokenAccount>,

    /// Customer's receipt account â€” gets filled
    #[account(
        mut,
        token::mint = receipt_mint,
        token::authority = customer,
    )]
    pub customer_receipt_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub customer: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct SettleOrder<'info> {
    #[account(
        mut,
        seeds = [b"market", market_state.payment_mint.as_ref()],
        bump = market_state.bump,
        constraint = market_state.provider == provider.key() @ MarketError::Unauthorized,
    )]
    pub market_state: Account<'info, MarketState>,

    #[account(
        mut,
        seeds = [b"market_vault", market_state.payment_mint.as_ref()],
        bump,
        token::mint = market_state.payment_mint,
        token::authority = market_state,
    )]
    pub market_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [b"receipt_mint", market_state.payment_mint.as_ref()],
        bump,
        mint::authority = market_state,
    )]
    pub receipt_mint: Account<'info, Mint>,

    /// Provider's account â€” receives the payout
    #[account(
        mut,
        token::mint = market_state.payment_mint,
        token::authority = provider,
    )]
    pub provider_payment_account: Account<'info, TokenAccount>,

    /// Customer's receipts get burned from here
    #[account(
        mut,
        token::mint = receipt_mint,
        token::authority = customer,
    )]
    pub customer_receipt_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub provider: Signer<'info>,

    /// Customer only signs to authorise burning their own receipts
    pub customer: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

// ============================================================================
// State
// ============================================================================

#[account]
#[derive(Default)]
pub struct MarketState {
    pub provider: Pubkey,        // 32
    pub payment_mint: Pubkey,    // 32
    pub market_vault: Pubkey,    // 32
    pub receipt_mint: Pubkey,    // 32
    pub provider_name: String,   // 4 + n â€” max 64
    pub gpu_count: u32,          // 4
    pub total_paid: u64,         // 8  â€” escrow balance
    pub total_receipts: u64,     // 8  â€” outstanding receipts
    pub orders_completed: u32,   // 4
    pub orders_cancelled: u32,   // 4
    pub bump: u8,                // 1
}

impl MarketState {
    pub const NAME_MAX: usize = 64;
    pub const LEN: usize = 8 + 32 + 32 + 32 + 32 + 4 + 64 + 4 + 8 + 8 + 4 + 4 + 1;
}

#[error_code]
pub enum MarketError {
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Receipts would be zero â€” order too small")]
    ReceiptTooSmall,
    #[msg("Payout too small")]
    PayoutTooSmall,
    #[msg("Market has no active orders")]
    MarketEmpty,
    #[msg("Math overflow")]
    MathOverflow,
    #[msg("Unauthorized: only the provider can settle")]
    Unauthorized,
}