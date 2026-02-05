use anchor_lang::prelude::*;

declare_id!("BBHVgLFdpYmd6SsCXDXqC4FT6NB1f1KXg9C7XmXFTVYS");

#[program]
pub mod solana_amm {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        msg!("Greetings from: {:?}", ctx.program_id);
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize {}
