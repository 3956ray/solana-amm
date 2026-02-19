use anchor_lang::prelude::*;
use anchor_spl::token::{self, Transfer};

use crate::contexts::Swap;
use crate::errors::AmmError;
use crate::math;

/// 执行代币交换
/// 
/// # Arguments
/// * `ctx` - 交换上下文
/// * `amount_in` - 输入代币数量
/// * `is_a_to_b` - 交换方向：true 表示 A->B，false 表示 B->A
/// * `min_amount_out` - 滑点保护：用户能接受的最低到账金额
pub fn swap(
    ctx: Context<Swap>, 
    amount_in: u64, 
    is_a_to_b: bool, 
    min_amount_out: u64,
) -> Result<()> {
    // 方向由调用者通过 is_a_to_b 参数传入
    // 注意：Swap 结构体中的约束确保 user_token_a 总是 Token A，user_token_b 总是 Token B
    // 但通过 is_a_to_b 参数，我们可以灵活决定哪个是输入、哪个是输出
    
    // 根据方向构建转账账户映射
    let (user_token_in, user_token_out, vault_in, vault_out, reserve_in, reserve_out) = if is_a_to_b {
        msg!("AtoB");
        // AtoB: 用户存入 A，池子支付 B
        (
            &ctx.accounts.user_token_a,
            &ctx.accounts.user_token_b,
            &ctx.accounts.token_a_vault,
            &ctx.accounts.token_b_vault,
            ctx.accounts.token_a_vault.amount,
            ctx.accounts.token_b_vault.amount,
        )
    } else {
        msg!("BtoA");
        // BtoA: 用户存入 B，池子支付 A
        (
            &ctx.accounts.user_token_b,
            &ctx.accounts.user_token_a,
            &ctx.accounts.token_b_vault,
            &ctx.accounts.token_a_vault,
            ctx.accounts.token_b_vault.amount,
            ctx.accounts.token_a_vault.amount,
        )
    };

    // TWAP 获取时间戳
    let clock = Clock::get()?;
    let current_timestamp = clock.unix_timestamp as u64;

    // 调用math里面的函数来更新TWAP
    // 重要：无论交易方向如何，都必须使用 Token A 和 Token B 的原始余额
    // 因为 update_twap 假设第一个参数是 Token A，第二个参数是 Token B
    math::update_twap(
        &mut ctx.accounts.pool_state,
        ctx.accounts.token_a_vault.amount,
        ctx.accounts.token_b_vault.amount,
        current_timestamp,
    );

    // 计算手续费和输出金额
    let fee_denominator = ctx.accounts.pool_state.fee_denominator;
    let fee_numerator = ctx.accounts.pool_state.fee_numerator;
    // 计算在扣掉手续费之后有效的输入是多少
    // 在solana中数学运算会溢出，所以这里使用checked_mul和checked_sub来防止溢出
    let amount_in_effective = amount_in
        .checked_mul(fee_denominator.checked_sub(fee_numerator).ok_or(AmmError::MathOverflow)?)
        .ok_or(AmmError::MathOverflow)?
        .checked_div(fee_denominator)
        .ok_or(AmmError::MathOverflow)?;

    msg!("amount_in_effective: {}", amount_in_effective);
    // 根据公式计算输出也就是amount_out
    // 使用u128进行中间计算以避免溢出
    let amount_out = (reserve_out as u128)
        .checked_mul(amount_in_effective as u128)
        .ok_or(AmmError::MathOverflow)?
        .checked_div((reserve_in as u128).checked_add(amount_in_effective as u128).ok_or(AmmError::MathOverflow)?)
        .ok_or(AmmError::MathOverflow)? as u64;
    msg!("amount_out: {}", amount_out);

    // 如果滑点大于设定的滑点，则交易失败
    require!(
        amount_out >= min_amount_out, 
        AmmError::SlippageExceeded 
    );

    
    // CPI 转账
    // 用户 -> pool（存款）：用户签名
    let cpi_accounts_user_to_pool = Transfer {
        from: user_token_in.to_account_info(),
        to: vault_in.to_account_info(),
        authority: ctx.accounts.user.to_account_info(),
    };
    let cpi_program_user_to_pool = ctx.accounts.token_program.to_account_info();
    // 这里在发起这笔交易的时候已经用私钥签过了，已经包含在ctx.accounts.user中，所以现在只要将签名权交给token_program即可
    let cpi_ctx_user_to_pool = CpiContext::new(cpi_program_user_to_pool, cpi_accounts_user_to_pool);
    // 完成转账
    token::transfer(cpi_ctx_user_to_pool, amount_in)?;

    // pool -> 用户（取款）：使用 PDA 签名
    // 构建 seeds 用于 PDA 签名
    let auth_bump = ctx.accounts.pool_state.auth_bump;
    let seeds: &[&[u8]] = &[
        b"authority",
        &[auth_bump],   
    ];
    let signer_seeds = &[seeds];

    // 然后执行交易，也就是划转金额CPI 
    let cpi_accounts_pool_to_user = Transfer {
        from: vault_out.to_account_info(),
        to: user_token_out.to_account_info(),
        authority: ctx.accounts.pool_authority.to_account_info(),
    };
    let cpi_program_pool_to_user = ctx.accounts.token_program.to_account_info();
    let cpi_ctx_pool_to_user = CpiContext::new_with_signer(
        cpi_program_pool_to_user,
        cpi_accounts_pool_to_user,
        signer_seeds,
    );
    token::transfer(cpi_ctx_pool_to_user, amount_out)?;

    msg!("Swap completed: {} -> {}", amount_in, amount_out);
    Ok(())
}
