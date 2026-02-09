use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};
use anchor_spl::associated_token::AssociatedToken;

declare_id!("BBHVgLFdpYmd6SsCXDXqC4FT6NB1f1KXg9C7XmXFTVYS");

#[program]
pub mod solana_amm {
    use super::*;

    pub fn initialize(
        ctx: Context<Initialize>,
        mint_a: Pubkey,
        mint_b: Pubkey,
        fee_numerator: u64, 
        fee_denominator: u64,
    ) -> Result<()> {
        // 获取账户
        // 存token的地址
        // 存vault和lp mint的地址
        // 存bump：
        require!(mint_a < mint_b, AmmError::InvalidMint);
        require!(fee_denominator > 0 && fee_numerator < fee_denominator, AmmError::InvalidFee);
        let pool_state = &mut ctx.accounts.pool_state;
        
        pool_state.token_a = ctx.accounts.token_a.key();
        pool_state.token_b = ctx.accounts.token_b.key();
        pool_state.token_a_vault = ctx.accounts.token_a_vault.key();
        pool_state.token_b_vault = ctx.accounts.token_b_vault.key();

        pool_state.lp_mint = ctx.accounts.lp_mint.key();
        pool_state.fee_numerator = fee_numerator;
        pool_state.fee_denominator = fee_denominator;
        // 3. 存储 Bumps
        // Anchor 框架在账户校验阶段生成的 Canonical Bump。这样既避免了在运行时重复调用 
        // find_program_address 带来的计算开销，也通过存储 Bump 确保了后续 invoke_signed 调用时的确定性。
        pool_state.pool_bump = ctx.bumps.pool_state;
        pool_state.auth_bump = ctx.bumps.pool_authority;

        msg!("Pool initialized successfully.");
        Ok(())
    }

    pub fn swap(
        ctx: Context<Swap>, 
        amount_in: u64, 
        is_a_to_b: bool, 
        min_amount_out: u64, // 增加滑点保护参数：用户能接受的最低到账金额 
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

        // 计算手续费和输出金额
        let fee_denominator = ctx.accounts.pool_state.fee_denominator;
        let fee_numerator = ctx.accounts.pool_state.fee_numerator;
        // 然后计算交易的手续费:这里从输入的金额扣掉，也就是从amount_in中扣掉
        // 所以这里要计算在扣掉手续费之后有效的输入是多少
        // let amount_in_effective = amount_in * (fee_denominator - fee_numerator) / fee_denominator;
        // 在solana中数学运算会溢出，所以这里使用checked_mul和checked_sub来防止溢出
        // let amount_in_effective = amount_in.checked_mul(fee_denominator.checked_sub(fee_numerator).unwrap()).unwrap() / fee_denominator;
        let amount_in_effective = amount_in
            .checked_mul(fee_denominator.checked_sub(fee_numerator).ok_or(AmmError::MathOverflow)?)
            .ok_or(AmmError::MathOverflow)?
            .checked_div(fee_denominator)
            .ok_or(AmmError::MathOverflow)?;

        msg!("amount_in_effective: {}", amount_in_effective);
        // 然后根据公式计算输出也就是amount_out
        // 不过这里有个问题是Solana在u64大数相乘得到时候会溢出，所以这里选择u128
        // let amount_out = reserve_b as u128 * amount_in_effective as u128 / (reserve_a as u128 + amount_in_effective as u128);
        // let amount_out = reserve_b.checked_mul(amount_in_effective).unwrap() / (reserve_a.checked_add(amount_in_effective).unwrap());
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

        // pool -> 用户（取款）：使用 PDA 签名（好难）
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
}

#[derive(Accounts)]
#[instruction(mint_a: Pubkey, mint_b: Pubkey, fee_numerator: u64, fee_denominator: u64)]
pub struct Initialize<'info> {
    // 这里用init标签创建账户，并使用seeds确保地址的唯一性(防止重复创建地址)
    #[account(
        init,
        payer = admin,
        space = PoolState::LEN,
        // 使用传入的参数作为种子，确保 (A,B) 池地址唯一
        seeds = [b"pool", mint_a.as_ref(), mint_b.as_ref()],
        bump
    )]
    pub pool_state: Account<'info, PoolState>,
    // 增加info的原因是生命周期与交易需要一致
    /// CHECK: 这个PDA只用作签名者，不存储数据。其地址由程序生成
    #[account(
        seeds = [b"authority"],
        bump
    )]
    pub pool_authority: UncheckedAccount<'info>,

    #[account(constraint = token_a.key() == mint_a)]
    pub token_a: Account<'info, Mint>,
    #[account(constraint = token_b.key() == mint_b)]
    pub token_b: Account<'info, Mint>,

    #[account(
        init,
        payer = admin,
        associated_token::mint = token_a,      // 修改为 associated_token
        associated_token::authority = pool_authority, // 关键：所有权只给程序
    )]
    pub token_a_vault: Account<'info, TokenAccount>,
    #[account(
        init,
        payer = admin,
        associated_token::mint = token_b,
        associated_token::authority = pool_authority,
    )]
    pub token_b_vault: Account<'info, TokenAccount>,

    #[account(
        init,
        payer = admin,
        mint::decimals = 9,
        mint::authority = pool_authority,
    )]
    pub lp_mint: Account<'info, Mint>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,

    pub rent: Sysvar<'info, Rent>,
    pub associated_token_program: Program<'info, AssociatedToken>,

    #[account(mut)] 
    pub admin: Signer<'info>
}

#[derive(Accounts)]
pub struct Swap<'info> {
    #[account(
        mut,
        has_one = token_a_vault @ AmmError::InvalidVault,
        has_one = token_b_vault @ AmmError::InvalidVault,
    )]
    pub pool_state: Account<'info, PoolState>,

    #[account(
        mut,
        constraint = user_token_a.mint == pool_state.token_a @ AmmError::InvalidUserToken
    )]
    pub user_token_a: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = user_token_b.mint == pool_state.token_b @ AmmError::InvalidUserToken
    )]
    pub user_token_b: Account<'info, TokenAccount>,

    #[account(mut)]
    pub token_a_vault: Account<'info, TokenAccount>,
    #[account(mut)]
    pub token_b_vault: Account<'info, TokenAccount>,

    pub user: Signer<'info>,

    /// CHECK: 这个PDA只用作签名者，不存储数据
    #[account(
        seeds = [b"authority"],
        bump = pool_state.auth_bump
    )]
    pub pool_authority: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
}

// 先创建一个pool的state
// 也要存入tokenA和tokenB的Pubkey
// 还有手续费率 
// 还有bump：用来减少消耗CU，并且减少循环遍历，在solana中会用来寻找Bump，会调用find_program_address
// 是从255开始，每次-1，直到找到一个可以用的bump，直到找到一个不在椭圆曲线上的合法 PDA 地址
// 用了bump就是每次直接调用create_program_address，然后传入bump，就可以直接找到一个合法的PDA
// 
#[account]
pub struct PoolState {
    pub token_a: Pubkey,
    pub token_b: Pubkey,

    pub token_a_vault: Pubkey,
    pub token_b_vault: Pubkey,
    pub lp_mint: Pubkey,
    pub fee_numerator: u64,
    pub fee_denominator: u64,

    pub pool_bump: u8,
    pub auth_bump: u8,
}

impl PoolState {
    pub const LEN: usize = Self::calculate_len();
    
    const fn calculate_len() -> usize {
        const DISCRIMINATOR: usize = 8;
        const PUBKEY_SIZE: usize = 32;
        const U64_SIZE: usize = 8;
        const U8_SIZE: usize = 1;
        
        DISCRIMINATOR
            .saturating_add(PUBKEY_SIZE) // token_a
            .saturating_add(PUBKEY_SIZE) // token_b
            .saturating_add(PUBKEY_SIZE) // token_a_vault
            .saturating_add(PUBKEY_SIZE) // token_b_vault
            .saturating_add(PUBKEY_SIZE) // lp_mint
            .saturating_add(U64_SIZE)    // fee_numerator
            .saturating_add(U64_SIZE)    // fee_denominator
            .saturating_add(U8_SIZE)     // pool_bump
            .saturating_add(U8_SIZE)     // auth_bump
    }
}

#[error_code]
pub enum AmmError {
    #[msg("Mint 顺序错误 (Mint A < Mint B)")]
    InvalidMint,
    #[msg("fee设置不合法：分子必须小于分母且不为零")]
    InvalidFee,
    #[msg("Vault 账户地址不匹配")]
    InvalidVault,
    #[msg("用户代币账户的 Mint 与池子不匹配")]
    InvalidUserToken,
    #[msg("数学运算溢出")]
    MathOverflow,
    #[msg("滑点过大，交易已取消")]
    SlippageExceeded,
}
