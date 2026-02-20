// 这是个使得admin可以进行管理的instruction
// 要有以下几个功能
// 新的管理地址：用来转让权限的
// 接收地址：用来接收协议收入的
// 协议分成比例

use anchor_lang::prelude::*;

use crate::contexts::UpdateConfig;
use crate::errors::AmmError;


pub fn update_config(
    ctx: Context<UpdateConfig>,
    new_admin: Option<Pubkey>,
    new_recipient: Option<Pubkey>,
    new_share: Option<u64>,
) -> Result<()> {
    let pool_state = &mut ctx.accounts.pool_state;

    // 修改管理者权限
    if let Some(admin) = new_admin {
        // pool_state.admin = admin;
        pool_state.pending_admin = Some(admin);
    }

    // 修改协议的账户
    if let Some(recipient) = new_recipient {
        pool_state.protocol_fee_recipient = recipient;
    }
    
    // 修改分成比例
    if let Some(share) = new_share {
        // 增加个判断，防止抽成过高
        require!(share <= 500, AmmError::InvalidFeeConfig);
        pool_state.protocol_fee_share = share;
    }
   
    Ok(())
}