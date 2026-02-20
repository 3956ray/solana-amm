use anchor_lang::prelude::*;

use crate::contexts::Initialize;
use crate::errors::AmmError;

/// 初始化 AMM 池子
/// 
/// # Arguments
/// * `ctx` - 初始化上下文
/// * `mint_a` - 代币 A 的 mint 地址
/// * `mint_b` - 代币 B 的 mint 地址
/// * `fee_numerator` - 手续费分子
/// * `fee_denominator` - 手续费分母
pub fn initialize(
    ctx: Context<Initialize>,
    mint_a: Pubkey,
    mint_b: Pubkey,
    fee_numerator: u64, 
    fee_denominator: u64,
) -> Result<()> {
    // 验证 mint 顺序：确保 mint_a < mint_b
    require!(mint_a < mint_b, AmmError::InvalidMint);
    // 验证手续费设置：分母必须大于0，分子必须小于分母
    require!(fee_denominator > 0 && fee_numerator < fee_denominator, AmmError::InvalidFee);
    
    let pool_state = &mut ctx.accounts.pool_state;
    
    // 存储代币和 vault 地址
    pool_state.token_a = ctx.accounts.token_a.key();
    pool_state.token_b = ctx.accounts.token_b.key();
    pool_state.token_a_vault = ctx.accounts.token_a_vault.key();
    pool_state.token_b_vault = ctx.accounts.token_b_vault.key();

    pool_state.lp_mint = ctx.accounts.lp_mint.key();
    pool_state.fee_numerator = fee_numerator;
    pool_state.fee_denominator = fee_denominator;
    
    // 存储 Bumps
    // Anchor 框架在账户校验阶段生成的 Canonical Bump。这样既避免了在运行时重复调用 
    // find_program_address 带来的计算开销，也通过存储 Bump 确保了后续 invoke_signed 调用时的确定性。
    pool_state.pool_bump = ctx.bumps.pool_state;
    pool_state.auth_bump = ctx.bumps.pool_authority;
    
    // 初始化 TWAP 累计价格和区块的时间戳字段
    let clock = Clock::get()?;
    pool_state.block_timestamp_last = clock.unix_timestamp as u64;
    pool_state.price_a_cumulative_last = 0;
    pool_state.price_b_cumulative_last = 0;

    // admin 作为创建者
    pool_state.admin = ctx.accounts.admin.key();
    pool_state.pending_admin = None;

    // 初始设为创建者
    pool_state.protocol_fee_recipient = ctx.accounts.admin.key();
    // 协议分成比例，默认不开启动作，0表示关闭
    pool_state.protocol_fee_share = 0;
    pool_state.k_last = 0;

    msg!("Pool initialized successfully.");
    Ok(())
}
