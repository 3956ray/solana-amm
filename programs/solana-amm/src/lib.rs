use anchor_lang::prelude::*;

// 模块声明
mod math;
mod state;
mod errors;
mod contexts;
mod instructions;

// 重新导出状态和错误，供其他模块使用
pub use state::PoolState;
pub use errors::AmmError;

// 在程序模块内使用账户结构体
use contexts::*;

declare_id!("BBHVgLFdpYmd6SsCXDXqC4FT6NB1f1KXg9C7XmXFTVYS");

#[program]
pub mod solana_amm {
    use super::*;

    /// 初始化 AMM 池子
    pub fn initialize(
        ctx: Context<Initialize>,
        mint_a: Pubkey,
        mint_b: Pubkey,
        fee_numerator: u64, 
        fee_denominator: u64,
    ) -> Result<()> {
        instructions::initialize(ctx, mint_a, mint_b, fee_numerator, fee_denominator)
    }

    /// 执行代币交换
    pub fn swap(
        ctx: Context<Swap>, 
        amount_in: u64, 
        is_a_to_b: bool, 
        min_amount_out: u64,
    ) -> Result<()> {
        instructions::swap(ctx, amount_in, is_a_to_b, min_amount_out)
    }

    /// 添加liquidity到池子
    pub fn add_liquidity(
        ctx: Context<AddLiquidity>,
        amount_a: u64,
        amount_b: u64,
    ) -> Result<()> {
        instructions::add_liquidity(ctx, amount_a, amount_b)
    }

    /// 从池子移除liquidity
    pub fn remove_liquidity(
        ctx: Context<RemoveLiquidity>,
        amount_lp: u64,
        min_amount_a: u64,
        min_amount_b: u64,
    ) -> Result<()> {
        instructions::remove_liquidity(ctx, amount_lp, min_amount_a, min_amount_b)
    }
}
