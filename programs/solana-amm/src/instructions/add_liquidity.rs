use anchor_lang::prelude::*;
use anchor_spl::token::{self, MintTo, Transfer};

use crate::contexts::AddLiquidity;
use crate::errors::AmmError;
use crate::math::sqrt_product_u64;

/// 添加流动性到池子
/// 
/// # Arguments
/// * `ctx` - 添加流动性上下文
/// * `amount_a` - 用户存入的tokenA的数量
/// * `amount_b` - 用户存入的tokenB的数量
pub fn add_liquidity(
    ctx: Context<AddLiquidity>,
    amount_a: u64,
    amount_b: u64,
) -> Result<()> {
    // 先检查现在的lp_mint的总量是不是为零，如果为零就表示是此账户是第一个提供流动性的账户
    // 因此要计算初始的lp_mint的总量，然后计算出用户需要提供多少lp_mint的token
    // 也就是根号的delta_a * delta_b
    let lp_mint_supply = ctx.accounts.lp_mint.supply;
    let liquidity: u64;

    // 构建 seeds 用于 PDA 签名
    let auth_bump = ctx.accounts.pool_state.auth_bump;
    let seeds: &[&[u8]] = &[
        b"authority",
        &[auth_bump],   
    ];
    let signer_seeds = &[seeds];
    // CPI 程序复用：后续需要多次构造 CpiContext，这里统一拿到 token_program
    let token_program = ctx.accounts.token_program.to_account_info();

    if ctx.accounts.lp_mint.supply == 0 {
        // 注释掉 PreciseNumber 的原因：CU 溢出
        // PreciseNumber 的计算开销过大，会导致程序消耗超过 200000 CU 的限制
        // 改用自定义的轻量级 sqrt_product_u64 函数来计算 sqrt(amount_a * amount_b)
        // 
        // 原代码（已注释）：
        // let p_a = PreciseNumber::new(amount_a as u128).ok_or(AmmError::MathOverflow)?;
        // let p_b = PreciseNumber::new(amount_b as u128).ok_or(AmmError::MathOverflow)?;
        // let product = p_a.checked_mul(&p_b).ok_or(AmmError::MathOverflow)?;
        // let sqrt_product = product.sqrt().ok_or(AmmError::MathOverflow)?;
        // let initial_liquidity = sqrt_product.to_imprecise().ok_or(AmmError::MathOverflow)?;
        
        // 使用自定义的 sqrt 函数计算初始流动性：sqrt(amount_a * amount_b)
        let initial_liquidity = sqrt_product_u64(amount_a, amount_b)
            .ok_or(AmmError::MathOverflow)? as u128;

        // 这里增加最小流动性
        // 防止流动性归零攻击，这里学习uniswap会转一小部分到0地址Pubkey::default()
        const MINIMUM_LIQUIDITY: u64 = 1000;
        if initial_liquidity <= MINIMUM_LIQUIDITY as u128 {
            return Err(AmmError::InitialLiquidityTooLow.into());
        }
        liquidity = (initial_liquidity - MINIMUM_LIQUIDITY as u128) as u64; 
        msg!("Initial liquidity: {}", liquidity);

        // 将铸造出来的MINIMUM_LIQUIDITY转到黑洞地址
        let cpi_accounts_mint_to_black_hole = MintTo {
            mint: ctx.accounts.lp_mint.to_account_info(),
            to: ctx.accounts.black_hole_lp_ATA.to_account_info(),
            authority: ctx.accounts.pool_authority.to_account_info(),
        };
        let cpi_ctx_mint_to_black_hole = CpiContext::new_with_signer(
            token_program.clone(),
            cpi_accounts_mint_to_black_hole,
            signer_seeds,
        );
        token::mint_to(cpi_ctx_mint_to_black_hole, MINIMUM_LIQUIDITY)?;
    } else {
        // 这里是不为0的情况，也就是说已经存在了流动性
        // 计算在现有的流动性池中，应该怎么计算用户应该提供多少lp_mint的token
        // 根据两个资产的存入比例，分别计算出"如果按 A 算该给多少 LP"和"如果按 B 算该给多少 LP"，然后取其中的最小值
        let liquidity_a = (amount_a as u128).checked_mul(lp_mint_supply as u128).ok_or(AmmError::MathOverflow)?.checked_div(ctx.accounts.token_a_vault.amount as u128).ok_or(AmmError::MathOverflow)? as u64;
        let liquidity_b = (amount_b as u128).checked_mul(lp_mint_supply as u128).ok_or(AmmError::MathOverflow)?.checked_div(ctx.accounts.token_b_vault.amount as u128).ok_or(AmmError::MathOverflow)? as u64;
        liquidity = liquidity_a.min(liquidity_b);
        msg!("Liquidity: {}", liquidity);
    }

    // 现在就是用户将钱转进池子里面，所以目的地是池子的vault
    let cpi_accounts_user_to_pool = Transfer {
        from: ctx.accounts.user_token_a.to_account_info(),
        to: ctx.accounts.token_a_vault.to_account_info(),
        authority: ctx.accounts.user.to_account_info(),
    };
    let cpi_ctx_user_to_pool_a = CpiContext::new(token_program.clone(), cpi_accounts_user_to_pool);
    token::transfer(cpi_ctx_user_to_pool_a, amount_a)?;
    // b转到池子里
    let cpi_accounts_user_to_pool_b = Transfer {
        from: ctx.accounts.user_token_b.to_account_info(),
        to: ctx.accounts.token_b_vault.to_account_info(),
        authority: ctx.accounts.user.to_account_info(),
    };
    let cpi_ctx_user_to_pool_b = CpiContext::new(token_program.clone(), cpi_accounts_user_to_pool_b);
    token::transfer(cpi_ctx_user_to_pool_b, amount_b)?;
    

    // 这里将用户获得的lp_mint到用户的账户
    let cpi_accounts_mint_to_user = MintTo {
        mint:ctx.accounts.lp_mint.to_account_info(),
        to: ctx.accounts.user_lp_token_ATA.to_account_info(),
        authority: ctx.accounts.pool_authority.to_account_info(),
    };
    let cpi_ctx_mint_to_user = CpiContext::new_with_signer(
        token_program.clone(),
        cpi_accounts_mint_to_user,
        signer_seeds,
    );
    token::mint_to(cpi_ctx_mint_to_user, liquidity)?;

    msg!("Add liquidity completed: {} -> {}", amount_a, amount_b);
    Ok(())
}
