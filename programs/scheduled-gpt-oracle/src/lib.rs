use anchor_lang::prelude::*;

declare_id!("HTJwnEfvjMQ2bxHa1ij5ogF6xro19UYuosEoRzWJawjC");

#[program]
pub mod scheduled_gpt_oracle {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        msg!("Greetings from: {:?}", ctx.program_id);
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize {}
