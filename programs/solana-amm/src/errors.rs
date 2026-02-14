use anchor_lang::prelude::*;

/// AMM 程序错误码枚举
#[error_code]
pub enum AmmError {
    #[msg("Mint 顺序错误 (Mint A < Mint B)")]
    InvalidMint,
    #[msg("fee设置不合法：分子必须小于分母且不为零")]
    InvalidFee,
    #[msg("Vault 账户地址不匹配")]
    InvalidVault,
    #[msg("LP Mint 账户地址不匹配")]
    InvalidLpMint,
    #[msg("用户代币账户的 Mint 与池子不匹配")]
    InvalidUserToken,
    #[msg("数学运算溢出")]
    MathOverflow,
    #[msg("滑点过大，交易已取消")]
    SlippageExceeded,
    #[msg("初始流动性太低")]
    InitialLiquidityTooLow,
}
