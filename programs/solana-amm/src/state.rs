use anchor_lang::prelude::*;

/// 池子状态结构体
/// 存储 AMM 池的所有关键信息，包括代币地址、金库地址、手续费率等
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

    
    // --- TWAP 新增字段 ---
    pub block_timestamp_last: u64,       // 记录上次更新的时间戳
    pub price_a_cumulative_last: u128,  // Token A 的累计价格
    pub price_b_cumulative_last: u128,  // Token B 的累计价格
}

impl PoolState {
    pub const LEN: usize = Self::calculate_len();
    
    const fn calculate_len() -> usize {
        const DISCRIMINATOR: usize = 8;
        const PUBKEY_SIZE: usize = 32;
        const U64_SIZE: usize = 8;
        const U128_SIZE: usize = 16;
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
            .saturating_add(U128_SIZE)   // price_a_cumulative_last (u128)
            .saturating_add(U128_SIZE)   // price_b_cumulative_last (u128)
            .saturating_add(U64_SIZE)    // block_timestamp_last
    }
}
