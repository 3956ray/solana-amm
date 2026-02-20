use anchor_lang::prelude::*;

use crate::contexts::ClaimAdmin;
use crate::errors::AmmError;

pub fn claim_admin(ctx: Context<ClaimAdmin>) -> Result<()> {
    let pool_state = &mut ctx.accounts.pool_state;
    
    // 正式移交權限
    pool_state.admin = ctx.accounts.pending_admin.key();
    
    // 清空暫存位
    pool_state.pending_admin = None;
    
    msg!("管理權限已正式移交至: {:?}", pool_state.admin);
    Ok(())
}