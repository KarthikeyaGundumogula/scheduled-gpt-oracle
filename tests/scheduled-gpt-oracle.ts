import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import { ScheduledGptOracle } from "../target/types/scheduled_gpt_oracle";
import { init as initTuktuk, taskQueueAuthorityKey } from "@helium/tuktuk-sdk";


describe("scheduled-gpt-oracle", () => {
  // Configure the client to use the local cluster
  anchor.setProvider(anchor.AnchorProvider.env());

  const provider = anchor.AnchorProvider.env();
  const wallet = provider.wallet as anchor.Wallet;
  const program = anchor.workspace
    .ScheduledGptOracle as Program<ScheduledGptOracle>;
  
  // Task queue Info:
//   {
//   "pubkey": "6oTiPde9QSzPkSE8V9pd9z3Vkw9wA6fxF6dZWKE2NYGn",
//   "id": 210,
//   "capacity": 5,
//   "update_authority": "HGbe7AjNtNNuU3QmninLVZhcY1bJGEyuXVLrbw1EPyCW",
//   "name": "gpt-scheduler",
//   "min_crank_reward": 1000000,
//   "balance": 1100000000,
//   "stale_task_age": 0
// }

  // Oracle and TukTuk program IDs
  const ORACLE_PROGRAM_ID = new PublicKey(
    "LLMrieZMpbJFwN52WgmBNMxYojrpRVYXdC1RCweEbab",
  );

  const TUKTUK_PROGRAM_ID = new PublicKey(
    "tuktukUrfhXT6ZT77QTU8RQtvgL967uRuVagWF57zVA",
  );

  const TASK_QUEUE = new PublicKey(
    "6oTiPde9QSzPkSE8V9pd9z3Vkw9wA6fxF6dZWKE2NYGn",
  );

  // Helper functions to derive PDAs
  const getCounterPda = () =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("counter")],
      ORACLE_PROGRAM_ID,
    );

  const getAgentPda = () =>
    PublicKey.findProgramAddressSync([Buffer.from("agent")], program.programId);

  const getLlmContextPda = (count: number) =>
    PublicKey.findProgramAddressSync(
      [
        Buffer.from("test-context"),
        new Uint8Array(new Uint32Array([count]).buffer),
      ],
      ORACLE_PROGRAM_ID,
    );

  const getInteractionPda = (context: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [
        Buffer.from("interaction"),
        wallet.publicKey.toBuffer(),
        context.toBuffer(),
      ],
      ORACLE_PROGRAM_ID,
    );

  const getQueueAuthorityPda = () =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("queue_authority")],
      program.programId,
    );

  it("Initializes the agent", async () => {
    const [counterPda] = getCounterPda();
    const [agentPda] = getAgentPda();

    // Check if agent is already initialized
    const agentInfo = await provider.connection.getAccountInfo(agentPda);
    if (agentInfo) {
      console.log("Agent already initialized, skipping...");
      return;
    }

    // Get current counter to derive context PDA
    const counterInfo = await provider.connection.getAccountInfo(counterPda);
    if (!counterInfo) {
      throw new Error(
        "Counter account not found. Make sure oracle is deployed.",
      );
    }
    const count = counterInfo.data.readUInt32LE(8);
    const [llmContextPda] = getLlmContextPda(count);

    const tx = await program.methods
      .initialize()
      .accountsStrict({
        payer: wallet.publicKey,
        agent: agentPda,
        llmContext: llmContextPda,
        counter: counterPda,
        systemProgram: anchor.web3.SystemProgram.programId,
        oracleProgram: ORACLE_PROGRAM_ID,
      })
      .rpc();

    console.log("✅ Initialize transaction signature:", tx);

    // Verify agent was created
    const agent = await program.account.agent.fetch(agentPda);
    console.log("✅ Agent context:", agent.context.toBase58());
  });

  it("Interacts with the agent", async () => {
    const [agentPda] = getAgentPda();

    // Fetch agent to get context
    const agentAccount = await program.account.agent.fetch(agentPda);
    const llmContextPda = agentAccount.context;
    const [interactionPda] = getInteractionPda(llmContextPda);

    const message =
      "Hello AI agent, can you help me understand Solana programs?";

    const tx = await program.methods
      .interactAgent(message)
      .accountsStrict({
        payer: wallet.publicKey,
        interaction: interactionPda,
        agent: agentPda,
        contextAccount: llmContextPda,
        oracleProgram: ORACLE_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    console.log("✅ Interact transaction signature:", tx);
    console.log("✅ Message sent:", message);
  });

  it("Schedules an agent interaction via TukTuk", async () => {
    const tuktukProgram = await initTuktuk(provider);
    const [agentPda] = getAgentPda();
    const [queueAuthority] = getQueueAuthorityPda();

    // Fetch agent to get context
    const agentAccount = await program.account.agent.fetch(agentPda);
    const llmContextPda = agentAccount.context;
    const [interactionPda] = getInteractionPda(llmContextPda);

    // Register queue authority if not already registered
    const tqAuthPda = taskQueueAuthorityKey(TASK_QUEUE, queueAuthority)[0];
    const tqAuthInfo = await provider.connection.getAccountInfo(tqAuthPda);

    if (!tqAuthInfo) {
      console.log("Registering queue authority...");
      const regTx = await tuktukProgram.methods
        .addQueueAuthorityV0()
        .accounts({
          payer: wallet.publicKey,
          queueAuthority,
          taskQueue: TASK_QUEUE,
        })
        .rpc({ skipPreflight: true, commitment: "confirmed" });
      console.log("✅ Queue authority registered:", regTx);
    } else {
      console.log("✅ Queue authority already registered");
    }

    // Find a free task ID
    const tqRaw = (await tuktukProgram.account.taskQueueV0.fetch(
      TASK_QUEUE,
    )) as any;

    let taskId = 0;
    for (let i = 0; i < tqRaw.taskBitmap.length; i++) {
      if (tqRaw.taskBitmap[i] !== 0xff) {
        for (let bit = 0; bit < 8; bit++) {
          if ((tqRaw.taskBitmap[i] & (1 << bit)) === 0) {
            taskId = i * 8 + bit;
            break;
          }
        }
        break;
      }
    }

    // Derive task account PDA
    const taskIdBuf = Buffer.alloc(2);
    taskIdBuf.writeUInt16LE(taskId);
    const [taskAccount] = PublicKey.findProgramAddressSync(
      [Buffer.from("task"), TASK_QUEUE.toBuffer(), taskIdBuf],
      TUKTUK_PROGRAM_ID,
    );

    // Derive task queue authority PDA
    const [tqAuthorityPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("task_queue_authority"),
        TASK_QUEUE.toBuffer(),
        queueAuthority.toBuffer(),
      ],
      TUKTUK_PROGRAM_ID,
    );

    console.log("Task ID:", taskId);
    console.log("Task Account:", taskAccount.toBase58());

    const scheduledMessage = "This is a scheduled message to the AI agent.";

    const tx = await program.methods
      .schedule(taskId, scheduledMessage)
      .accountsStrict({
        payer: wallet.publicKey,
        interaction: interactionPda,
        agent: agentPda,
        contextAccount: llmContextPda,
        taskQueue: TASK_QUEUE,
        taskQueueAuthority: tqAuthorityPda,
        task: taskAccount,
        queueAuthority,
        tuktukProgram: TUKTUK_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc({ skipPreflight: true, commitment: "confirmed" });

    console.log("✅ Schedule transaction signature:", tx);
    console.log("✅ Scheduled message:", scheduledMessage);
    console.log(
      `\n🔗 View program on explorer:\nhttps://explorer.solana.com/address/${program.programId.toBase58()}?cluster=devnet`,
    );

    
  });

  it.only("Monitors the scheduled task until completion", async () => {
    await monitorTask(
      provider.connection,
      new PublicKey("ERwxDq5m1utfhtVVv2zmmNsEQsYozqRdEkhsrRXdGB3y"),
    );
  });


  async function monitorTask(connection: Connection, task: PublicKey) {
    let taskAccount;
    do {
      try {
        taskAccount = await connection.getAccountInfo(task);
        if (!taskAccount) {
          const signature = await connection.getSignaturesForAddress(task, {
            limit: 1,
          });
          console.log(
            `Task completed! Transaction signature: ${signature[0].signature}`,
          );
          break;
        }
        console.log("Task is still pending...");
        await new Promise((resolve) => setTimeout(resolve, 2000));
      } catch (e) {
        console.log("Task completed!");
        break;
      }
    } while (true);
  }

});
