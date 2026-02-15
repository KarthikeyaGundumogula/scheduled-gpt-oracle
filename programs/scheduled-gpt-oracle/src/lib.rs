#![allow(deprecated)]
#![allow(unexpected_cfgs)]
use anchor_lang::prelude::*;
use anchor_lang::Discriminator;
use anchor_lang::InstructionData;
use anchor_lang::solana_program::instruction::Instruction;
use solana_gpt_oracle::{ContextAccount, Counter, Identity};
use tuktuk_program::{
    compile_transaction,
    tuktuk::{
        cpi::{accounts::QueueTaskV0, queue_task_v0},
        program::Tuktuk,
        types::TriggerV0,
    },
    types::QueueTaskArgsV0,
    TransactionSourceV0,
};


declare_id!("FAD61S3A6qnAigJVV7Rz2BxE9Leh4nbzJRuWsymGTmjW");



#[program]
pub mod scheduled_gpt_oracle {
    use super::*;

    const AGENT_DESC: &str = "You are a helpful assistant.";

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        ctx.accounts.agent.context = ctx.accounts.llm_context.key();

        // Create the context for the AI agent
        let cpi_program = ctx.accounts.oracle_program.to_account_info();
        let cpi_accounts = solana_gpt_oracle::cpi::accounts::CreateLlmContext {
            payer: ctx.accounts.payer.to_account_info(),
            context_account: ctx.accounts.llm_context.to_account_info(),
            counter: ctx.accounts.counter.to_account_info(),
            system_program: ctx.accounts.system_program.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);
        solana_gpt_oracle::cpi::create_llm_context(cpi_ctx, AGENT_DESC.to_string())?;

        Ok(())
    }

    pub fn interact_agent(ctx: Context<InteractAgent>, text: String) -> Result<()> {
        let cpi_program = ctx.accounts.oracle_program.to_account_info();
        let cpi_accounts = solana_gpt_oracle::cpi::accounts::InteractWithLlm {
            payer: ctx.accounts.payer.to_account_info(),
            interaction: ctx.accounts.interaction.to_account_info(),
            context_account: ctx.accounts.context_account.to_account_info(),
            system_program: ctx.accounts.system_program.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);
        let disc: [u8; 8] = instruction::CallbackFromAgent::DISCRIMINATOR
            .try_into()
            .expect("Discriminator must be 8 bytes");
        solana_gpt_oracle::cpi::interact_with_llm(cpi_ctx, text, ID, disc, None)?;

        Ok(())
    }

    pub fn callback_from_agent(ctx: Context<CallbackFromAgent>, response: String) -> Result<()> {
        // Check if the callback is from the LLM program
        if !ctx.accounts.identity.to_account_info().is_signer {
            return Err(ProgramError::InvalidAccountData.into());
        }
        // Do something with the response
        msg!("Agent Response: {:?}", response);
        Ok(())
    }

     pub fn schedule(ctx: Context<Schedule>, task_id: u16, text: String) -> Result<()> {
        let interact_ix = Instruction {
            program_id: crate::ID,
            accounts: vec![
                AccountMeta::new(ctx.accounts.payer.key(), false),
                AccountMeta::new(ctx.accounts.interaction.key(), false),
                AccountMeta::new_readonly(ctx.accounts.agent.key(), false),
                AccountMeta::new_readonly(ctx.accounts.context_account.key(), false),
                AccountMeta::new_readonly(solana_gpt_oracle::ID, false),
                AccountMeta::new_readonly(System::id(), false),
            ],
            data: instruction::InteractAgent { text }.data(),
        };

        let (compiled_tx, _) = compile_transaction(vec![interact_ix], vec![]).unwrap();

        queue_task_v0(
            CpiContext::new_with_signer(
                ctx.accounts.tuktuk_program.to_account_info(),
                tuktuk_program::tuktuk::cpi::accounts::QueueTaskV0 {
                    payer: ctx.accounts.payer.to_account_info(),
                    queue_authority: ctx.accounts.queue_authority.to_account_info(),
                    task_queue: ctx.accounts.task_queue.to_account_info(),
                    task_queue_authority: ctx.accounts.task_queue_authority.to_account_info(),
                    task: ctx.accounts.task.to_account_info(),
                    system_program: ctx.accounts.system_program.to_account_info(),
                },
                &[&[b"queue_authority", &[ctx.bumps.queue_authority]]],
            ),
            tuktuk_program::types::QueueTaskArgsV0 {
                id: task_id,
                trigger: TriggerV0::Now,
                transaction: TransactionSourceV0::CompiledV0(compiled_tx),
                crank_reward: Some(5_000_000),
                free_tasks: 0,
                description: "interact_with_llm".to_string(),
            },
        )?;

        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init,
        payer = payer,
        space = 8 + 32,
        seeds = [b"agent"],
        bump
    )]
    pub agent: Account<'info, Agent>,
    /// CHECK: Checked in oracle program
    #[account(mut)]
    pub llm_context: AccountInfo<'info>,
    #[account(mut)]
    pub counter: Account<'info, Counter>,
    pub system_program: Program<'info, System>,
    /// CHECK: Checked oracle id
    #[account(address = solana_gpt_oracle::ID)]
    pub oracle_program: AccountInfo<'info>,
}

#[derive(Accounts)]
#[instruction(text: String)]
pub struct InteractAgent<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: Checked in oracle program
    #[account(mut)]
    pub interaction: AccountInfo<'info>,
    #[account(seeds = [b"agent"], bump)]
    pub agent: Account<'info, Agent>,
    #[account(address = agent.context)]
    pub context_account: Account<'info, ContextAccount>,
    /// CHECK: Checked oracle id
    #[account(address = solana_gpt_oracle::ID)]
    pub oracle_program: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CallbackFromAgent<'info> {
    /// CHECK: Checked in oracle program
    pub identity: Account<'info, Identity>,
}

#[account]
pub struct Agent {
    pub context: Pubkey,
}

#[derive(Accounts)]
#[instruction(task_id: u16, text: String)]
pub struct Schedule<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: Checked oracle id
    #[account(mut)]
    pub interaction: AccountInfo<'info>,

    #[account(seeds = [b"agent"], bump)]
    pub agent: Account<'info, Agent>,   

    #[account(address= agent.context)]
    pub context_account: Account<'info, ContextAccount>,

    /// CHECK: Passed through to TukTuk CPI
    #[account(mut)]
    pub task_queue: UncheckedAccount<'info>,

    /// CHECK: Derived and verified by TukTuk program
    #[account(mut)]
    pub task_queue_authority: UncheckedAccount<'info>,

    /// CHECK: Initialized in CPI - address = PDA(["task", task_queue, task_id], tuktuk)
    #[account(mut)]
    pub task: UncheckedAccount<'info>,

    /// CHECK: PDA signer - no data stored here
    #[account(
        mut,
        seeds = [b"queue_authority"],
        bump,
    )]
    pub queue_authority: AccountInfo<'info>,

    pub tuktuk_program: Program<'info, Tuktuk>,

    pub system_program: Program<'info, System>,
}
