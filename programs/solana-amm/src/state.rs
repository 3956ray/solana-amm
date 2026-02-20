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

    // --- 协议治理 ---
    pub admin: Pubkey,                      // 管理员地址
    pub pending_admin: Option<Pubkey>,      // 待定管理員
    pub protocol_fee_recipient: Pubkey,     // 协议收入接收地址
    pub protocol_fee_share: u64,    // 协议分成比例 (比如 1/6，建议设为分母，0表示关闭)
    
    // --- 营收结算核心 ---
    pub k_last: u128,               // 上次结算时的储备金乘积 (reserve_a * reserve_b)
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
            .saturating_add(PUBKEY_SIZE) // admin
            .saturating_add(1 + PUBKEY_SIZE) // pending_admin (Option<Pubkey>: 1 byte discriminator + 32 bytes)
            .saturating_add(PUBKEY_SIZE) // protocol_fee_recipient
            .saturating_add(U64_SIZE)    // protocol_fee_share
            .saturating_add(U128_SIZE)   // k_last
    }
}
