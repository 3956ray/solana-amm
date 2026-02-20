use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};
use anchor_spl::associated_token::AssociatedToken;

use crate::state::PoolState;
use crate::errors::AmmError;

/// 初始化池子的账户结构体
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

    // 注意：虽然 linter 建议使用 Rent::get()?，但在 Anchor 中，使用 Sysvar 是标准做法
    // 因为它提供了更好的账户验证和安全性
    pub rent: Sysvar<'info, Rent>,
    pub associated_token_program: Program<'info, AssociatedToken>,

    #[account(mut)] 
    pub admin: Signer<'info>
}

/// 交换代币的账户结构体
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

/// 添加流动性的账户结构体
#[derive(Accounts)]
pub struct AddLiquidity<'info> {
    // 老样子pool_state跟authority都得在
    #[account(
        mut,
        has_one = token_a_vault @ AmmError::InvalidVault,
        has_one = token_b_vault @ AmmError::InvalidVault,
        has_one = lp_mint @ AmmError::InvalidLpMint,
    )]
    // pub pool_state: Account<'info, PoolState>,
    // 使用Box来优化内存使用
    pub pool_state: Box<Account<'info, PoolState>>,
    #[account(
        seeds = [b"authority"],
        bump = pool_state.auth_bump
    )]
    /// CHECK: 这个PDA只用作签名者，不存储数据。其地址由程序生成
    /// 不需要 mut，因为 PDA 只用作签名者，不存储数据
    pub pool_authority: UncheckedAccount<'info>,
    
    #[account(
        mut,
        constraint = user_token_a.mint == pool_state.token_a @ AmmError::InvalidUserToken
    )]
    // pub user_token_a: Account<'info, TokenAccount>,
    pub user_token_a: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        constraint = user_token_b.mint == pool_state.token_b @ AmmError::InvalidUserToken
    )]
    pub user_token_b: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub token_a_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub token_b_vault: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub user: Signer<'info>,
    #[account(
        mut,
        constraint = lp_mint.key() == pool_state.lp_mint @ AmmError::InvalidLpMint
    )]
    pub lp_mint: Box<Account<'info, Mint>>,

    #[account(
        init_if_needed, // 如果账户不存在，则创建账户，并且如果只用init的话再次增加交易则会revert
        payer = user,
        associated_token::mint = lp_mint,
        associated_token::authority = user,
    )]
    pub user_lp_token_ATA: Box<Account<'info, TokenAccount>>,

    // 黑洞账户，用于接收用户存入的lp_mint的token
    // 必须标记为 mut，因为在 CPI mint_to 时需要写入
    // 验证黑洞账户的 mint 与 lp_mint 匹配
    #[account(
        mut,
        constraint = black_hole_lp_ATA.mint == lp_mint.key() @ AmmError::InvalidLpMint
    )]
    pub black_hole_lp_ATA: Box<Account<'info, TokenAccount>>,


    #[account(
        mut,
        constraint = protocol_fee_recipient.owner == pool_state.protocol_fee_recipient @ AmmError::InvalidUserToken,
        constraint = protocol_fee_recipient.mint == lp_mint.key() @ AmmError::InvalidLpMint
    )]
    pub protocol_fee_recipient: Account<'info, TokenAccount>,

    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
}

/// 移除流动性的账户结构体
#[derive(Accounts)]
pub struct RemoveLiquidity<'info> {

    // pool_state跟authority都得在
    // 会变的东西，
    // lp token会从USER_ATA burn掉
    // 然后USER会获得tokenA和tokenB
    // 也就是说token a和b会从pool里面转到user的账户,也就是vault转到user ata
    #[account(
        mut,
        has_one = token_a_vault @ AmmError::InvalidVault,
        has_one = token_b_vault @ AmmError::InvalidVault,
        has_one = lp_mint @ AmmError::InvalidLpMint,
    )]
    pub pool_state: Box<Account<'info, PoolState>>,

    #[account(
        seeds = [b"authority"],
        bump = pool_state.auth_bump
    )]
    /// CHECK: 这个PDA只用作签名者，不存储数据。其地址由程序生成
    pub pool_authority: UncheckedAccount<'info>,
    
    
    #[account(
        mut,
        constraint = user_token_a.mint == pool_state.token_a @ AmmError::InvalidUserToken
    )]
    pub user_token_a: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        constraint = user_token_b.mint == pool_state.token_b @ AmmError::InvalidUserToken
    )]
    pub user_token_b: Box<Account<'info, TokenAccount>>,
    
    #[account(mut)]
    pub token_a_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub token_b_vault: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub user: Signer<'info>,
    #[account(
        mut,
        constraint = lp_mint.key() == pool_state.lp_mint @ AmmError::InvalidLpMint
    )]
    pub lp_mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        associated_token::mint = lp_mint,
        associated_token::authority = user,
    )]
    pub user_lp_token_ATA: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = protocol_fee_recipient.owner == pool_state.protocol_fee_recipient @ AmmError::InvalidUserToken,
        constraint = protocol_fee_recipient.mint == lp_mint.key() @ AmmError::InvalidLpMint
    )]
    pub protocol_fee_recipient: Account<'info, TokenAccount>,

    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    #[account(
        mut,
        // 确保只有当前的 admin 能签收这笔交易
        has_one = admin @ AmmError::Unauthorized 
    )]
    pub pool_state: Account<'info, PoolState>,
    
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct ClaimAdmin<'info> {
    #[account(
        mut,
        // 簽名的必須是 pool_state 中記錄的 pending_admin
        constraint = pool_state.pending_admin == Some(pending_admin.key()) @ AmmError::Unauthorized
    )]
    pub pool_state: Account<'info, PoolState>,
    
    // 必須是新管理員簽名
    pub pending_admin: Signer<'info>, 
}
