use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, MintTo, Transfer};

use crate::contexts::RemoveLiquidity;
use crate::errors::AmmError;
use crate::math;

/// 从池子移除流动性
/// 
/// # Arguments
/// * `ctx` - 移除流动性上下文
/// * `amount_lp` - 要销毁的 LP token 数量
/// * `min_amount_a` - 滑点保护：用户能接受的最少 token A 数量
/// * `min_amount_b` - 滑点保护：用户能接受的最少 token B 数量
pub fn remove_liquidity(
    ctx: Context<RemoveLiquidity>,
    amount_lp: u64,
    min_amount_a: u64,
    min_amount_b: u64,
) -> Result<()> {
    // 这里检查用户给持有的lp_mint的token是否大于0
    // 如果小于0则revert
    require!(
        ctx.accounts.user_lp_token_ATA.amount >= amount_lp,
        AmmError::InvalidLpMint
    );

    // 构建 seeds 用于 PDA 签名
    let auth_bump = ctx.accounts.pool_state.auth_bump;
    let seeds: &[&[u8]] = &[
        b"authority",
        &[auth_bump],   
    ];
    let signer_seeds = &[seeds];
    // CPI 程序复用：后续需要多次构造 CpiContext，这里统一拿到 token_program
    let token_program = ctx.accounts.token_program.to_account_info();

    // TWAP 获取时间戳
    let clock = Clock::get()?;
    let current_timestamp = clock.unix_timestamp as u64;

    // 调用math里面的函数来更新TWAP
    math::update_twap(
        &mut ctx.accounts.pool_state,
        ctx.accounts.token_a_vault.amount,
        ctx.accounts.token_b_vault.amount,
        current_timestamp,
    );

    // 跟add_liquidity的思路一样，计算协议方应该销毁多少LP
    let protocol_mint_amount = math::calculate_protocol_fee_mint(
        ctx.accounts.token_a_vault.amount,
        ctx.accounts.token_b_vault.amount,
        ctx.accounts.pool_state.k_last,
        ctx.accounts.lp_mint.supply,
        ctx.accounts.pool_state.protocol_fee_share,
    ).unwrap_or(0);

    if protocol_mint_amount > 0 {
        let cpi_accounts_mint_to_protocol = MintTo {
            mint: ctx.accounts.lp_mint.to_account_info(),
            to: ctx.accounts.protocol_fee_recipient.to_account_info(),
            authority: ctx.accounts.pool_authority.to_account_info(),
        };
        let cpi_ctx_mint_to_protocol = CpiContext::new_with_signer(
            token_program.clone(),
            cpi_accounts_mint_to_protocol,
            signer_seeds,
        );
        token::mint_to(cpi_ctx_mint_to_protocol, protocol_mint_amount)?;
        msg!("Protocol mint amount: {}", protocol_mint_amount);
    }

    let total_lp_supply = ctx.accounts.lp_mint.supply.checked_add(protocol_mint_amount).ok_or(AmmError::MathOverflow)?;
    msg!("Total LP supply: {}", total_lp_supply);
    
    // 计算用户分别获得多少token a和b
    // 根据用户输入的 amount_lp 计算比例
    // 计算公式以a为例子，就是 user_get_amount_a = amount_lp * (token_a_vault.amount / lp_mint.supply)
    // 使用 u128 进行中间计算以避免溢出
    let user_get_amount_a = (amount_lp as u128)
        .checked_mul(ctx.accounts.token_a_vault.amount as u128)
        .ok_or(AmmError::MathOverflow)?
        .checked_div(total_lp_supply as u128)
        .ok_or(AmmError::MathOverflow)? as u64;
    
    let user_get_amount_b = (amount_lp as u128)
        .checked_mul(ctx.accounts.token_b_vault.amount as u128)
        .ok_or(AmmError::MathOverflow)?
        .checked_div(total_lp_supply as u128)
        .ok_or(AmmError::MathOverflow)? as u64;
    
    // 检查用户获得的token a和b是否大于最小值（滑点保护）
    require!(
        user_get_amount_a >= min_amount_a,
        AmmError::SlippageExceeded
    );
    require!(
        user_get_amount_b >= min_amount_b,
        AmmError::SlippageExceeded
    );

    // 计算k_last
    // 扣除掉发给用户的钱后的新储备金计算 K
    // transfer 发生之前，token_a_vault.amount 拿到的还是旧余额
    // 这里手动计算"预期的未来余额"来更新 k_last，保证了状态更新的原子性
    let new_reserve_a = ctx.accounts.token_a_vault.amount
        .checked_sub(user_get_amount_a)
        .ok_or(AmmError::MathOverflow)?;
    let new_reserve_b = ctx.accounts.token_b_vault.amount
        .checked_sub(user_get_amount_b)
        .ok_or(AmmError::MathOverflow)?;
    ctx.accounts.pool_state.k_last = (new_reserve_a as u128)
        .checked_mul(new_reserve_b as u128)
        .ok_or(AmmError::MathOverflow)?;
    msg!("New k_last: {}", ctx.accounts.pool_state.k_last);


    // 先将lp_mint的token从用户账户burn掉
    // Burn 指令只需要 mint、from 和 authority，不需要 to 账户
    let cpi_accounts_burn_lp_mint = Burn {
        mint: ctx.accounts.lp_mint.to_account_info(),
        from: ctx.accounts.user_lp_token_ATA.to_account_info(),
        authority: ctx.accounts.user.to_account_info(),
    };
    let cpi_ctx_burn_lp_mint = CpiContext::new(
        token_program.clone(), 
        cpi_accounts_burn_lp_mint
    );
    token::burn(cpi_ctx_burn_lp_mint, amount_lp)?;

    // 然后执行交易，也就是划转金额CPI 从vault转到user的账户
    let cpi_accounts_vault_to_user_a = Transfer {
        from: ctx.accounts.token_a_vault.to_account_info(),
        to: ctx.accounts.user_token_a.to_account_info(),
        authority: ctx.accounts.pool_authority.to_account_info(),
    };
    let cpi_ctx_vault_to_user_a = CpiContext::new_with_signer(
        token_program.clone(), 
        cpi_accounts_vault_to_user_a,
        signer_seeds,
    );
    token::transfer(cpi_ctx_vault_to_user_a, user_get_amount_a)?;
    
    let cpi_accounts_vault_to_user_b = Transfer {
        from: ctx.accounts.token_b_vault.to_account_info(),
        to: ctx.accounts.user_token_b.to_account_info(),
        authority: ctx.accounts.pool_authority.to_account_info(),
    };
    let cpi_ctx_vault_to_user_b = CpiContext::new_with_signer(
        token_program.clone(), 
        cpi_accounts_vault_to_user_b,
        signer_seeds,
    );
    token::transfer(cpi_ctx_vault_to_user_b, user_get_amount_b)?;

    msg!("Remove liquidity completed: {} LP -> {} A, {} B", amount_lp, user_get_amount_a, user_get_amount_b);
    
    
    Ok(())
}
