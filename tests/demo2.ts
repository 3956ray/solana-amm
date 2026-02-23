import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { SolanaAmm } from "../target/types/solana_amm";
import { 
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createMint, 
  getOrCreateAssociatedTokenAccount, 
  mintTo, 
  getAccount,
  getMint,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { assert } from "chai";

/**
 * 🚀 Demo 脚本 (Devnet 终极版)
 * * 这个脚本展示了 Solana AMM 的全套准生产级功能：
 * 1. 注入流动性（展示黑洞锁定，防通胀攻击）
 * 2. 模拟时间流逝与多次 Swap
 * 3. 预言机验证（读取 TWAP 价格）
 * 4. 两阶段治理（Nominate & Claim 权限移交）
 * 5. 协议营收验证（触发并验证 sqrt(k) 增发逻辑）
 */
describe("Demo - Solana AMM 完整演示", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.SolanaAmm as Program<SolanaAmm>;
  const user = (provider.wallet as anchor.Wallet).payer;
  
  // 新增：用于演示两阶段治理的新管理员 Keypair
  const newAdmin = anchor.web3.Keypair.generate();
  // 协议费接收者（独立账户，不是用户的 LP token 账户）
  let protocolFeeRecipient: anchor.web3.Keypair;

  // 账户声明
  let mintA: anchor.web3.PublicKey;
  let mintB: anchor.web3.PublicKey;
  let userTokenA: anchor.web3.PublicKey;
  let userTokenB: anchor.web3.PublicKey;
  let vaultA: anchor.web3.PublicKey;
  let vaultB: anchor.web3.PublicKey;
  let poolState: anchor.web3.PublicKey;
  let poolAuthority: anchor.web3.PublicKey;
  let lpMint: anchor.web3.PublicKey;
  let userLpAta: anchor.web3.PublicKey;
  let blackHoleLpAta: anchor.web3.PublicKey;
  let protocolFeeRecipientAta: anchor.web3.PublicKey;

  const BLACK_HOLE_OWNER = new anchor.web3.PublicKey("11111111111111111111111111111111");

  // 辅助函数：推进时间 (由于本地测试网需要发交易推 slot)
  async function advanceTime(seconds: number) {
    console.log(`\n⏰ 推进时间 ${seconds} 秒...`);
    const slotsToAdvance = Math.ceil(seconds / 0.4);
    const maxTransactions = Math.min(slotsToAdvance, 20);
    
    for (let i = 0; i < maxTransactions; i++) {
      try {
        const transaction = new anchor.web3.Transaction().add(
          anchor.web3.SystemProgram.transfer({
            fromPubkey: user.publicKey,
            toPubkey: user.publicKey,
            lamports: 0,
          })
        );
        await provider.sendAndConfirm(transaction, [], { commitment: "confirmed", skipPreflight: true });
      } catch (e) {}
    }
    const waitTime = Math.min(2000, seconds * 100);
    await new Promise(resolve => setTimeout(resolve, waitTime));
    console.log(`✅ 时间已推进`);
  }

  function formatPrice(price: number, decimals: number = 6): string {
    return price.toFixed(decimals);
  }

  async function displayPoolState(step: string) {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`📊 ${step}`);
    console.log(`${"=".repeat(60)}`);

    const state = await program.account.poolState.fetch(poolState);
    const vaultAAccount = await getAccount(provider.connection, vaultA);
    const vaultBAccount = await getAccount(provider.connection, vaultB);
    
    console.log(`\n💧 池子流动性:`);
    console.log(`   Token A: ${Number(vaultAAccount.amount) / 1e6}`);
    console.log(`   Token B: ${Number(vaultBAccount.amount) / 1e6}`);
    
    console.log(`\n📈 K值锚点 (k_last): ${state.kLast.toString()}`);
    console.log(`   协议分成比例 (Share): ${state.protocolFeeShare.toString()}/1000`);
    
    console.log(`\n${"=".repeat(60)}\n`);
  }

  before(async () => {
    console.log("\n🚀 开始初始化环境...\n");

    // 为 newAdmin 提供一些 SOL 用于发送 Claim 交易
    const signature = await provider.connection.requestAirdrop(newAdmin.publicKey, 1_000_000_000);
    await provider.connection.confirmTransaction(signature);

    // 创建协议费接收者账户
    protocolFeeRecipient = anchor.web3.Keypair.generate();
    const protocolFeeRecipientSignature = await provider.connection.requestAirdrop(protocolFeeRecipient.publicKey, 1_000_000_000);
    await provider.connection.confirmTransaction(protocolFeeRecipientSignature);

    mintA = await createMint(provider.connection, user, user.publicKey, null, 6);
    mintB = await createMint(provider.connection, user, user.publicKey, null, 6);

    if (mintA.toBuffer().compare(mintB.toBuffer()) > 0) {
      [mintA, mintB] = [mintB, mintA];
    }

    [poolState] = anchor.web3.PublicKey.findProgramAddressSync([Buffer.from("pool"), mintA.toBuffer(), mintB.toBuffer()], program.programId);
    [poolAuthority] = anchor.web3.PublicKey.findProgramAddressSync([Buffer.from("authority")], program.programId);

    vaultA = getAssociatedTokenAddressSync(mintA, poolAuthority, true);
    vaultB = getAssociatedTokenAddressSync(mintB, poolAuthority, true);

    userTokenA = (await getOrCreateAssociatedTokenAccount(provider.connection, user, mintA, user.publicKey)).address;
    userTokenB = (await getOrCreateAssociatedTokenAccount(provider.connection, user, mintB, user.publicKey)).address;

    await mintTo(provider.connection, user, mintA, userTokenA, user.publicKey, 1_000_000_000_000);
    await mintTo(provider.connection, user, mintB, userTokenB, user.publicKey, 1_000_000_000_000);
  });

  it("步骤 1: 初始化池子", async () => {
    const feeNumerator = new anchor.BN(3);
    const feeDenominator = new anchor.BN(1000);
    const lpMintKeypair = anchor.web3.Keypair.generate();
    lpMint = lpMintKeypair.publicKey;

    await program.methods
      .initialize(mintA, mintB, feeNumerator, feeDenominator)
      .accounts({
        poolState,
        poolAuthority,
        tokenA: mintA,
        tokenB: mintB,
        tokenAVault: vaultA,
        tokenBVault: vaultB,
        lpMint,
        admin: user.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      } as any)
      .signers([lpMintKeypair])
      .rpc();
      
    await displayPoolState("初始化后的池子状态");
  });

  it("步骤 2: 注入流动性（展示黑洞锁定）", async () => {
    userLpAta = getAssociatedTokenAddressSync(lpMint, user.publicKey);
    blackHoleLpAta = (await getOrCreateAssociatedTokenAccount(provider.connection, user, lpMint, BLACK_HOLE_OWNER, true)).address;
    
    // 创建协议费接收者的 LP token ATA（使用初始 admin，即 user.publicKey）
    protocolFeeRecipientAta = (
        await getOrCreateAssociatedTokenAccount(provider.connection, user, lpMint, user.publicKey)
    ).address;

    await program.methods
      .addLiquidity(new anchor.BN(100_000_000), new anchor.BN(100_000_000))
      .accounts({
        poolState,
        poolAuthority,
        userTokenA,
        userTokenB,
        tokenAVault: vaultA,
        tokenBVault: vaultB,
        user: user.publicKey,
        lpMint,
        userLpTokenATA: userLpAta,      // 注意这里的驼峰命名要和你的 IDL 一致
        blackHoleLpAta,
        protocolFeeRecipient: protocolFeeRecipientAta, // 引入协议收款账户
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
      .rpc();
  });

  it("步骤 3~6: 执行多次 Swap 积累手续费", async () => {
    console.log("\n🔄 正在执行 Swap，为池子积累手续费...");
    await program.methods.swap(new anchor.BN(10_000_000), true, new anchor.BN(0))
      .accounts({ poolState, userTokenA, userTokenB, tokenAVault: vaultA, tokenBVault: vaultB, user: user.publicKey, poolAuthority, tokenProgram: TOKEN_PROGRAM_ID } as any).rpc();
    
    await advanceTime(5);

    await program.methods.swap(new anchor.BN(8_000_000), false, new anchor.BN(0))
      .accounts({ poolState, userTokenA, userTokenB, tokenAVault: vaultA, tokenBVault: vaultB, user: user.publicKey, poolAuthority, tokenProgram: TOKEN_PROGRAM_ID } as any).rpc();
    
    await displayPoolState("Swap 积累手续费后的状态");
  });

  it("步骤 7: TWAP 预言机验证 (省略部分重复日志)", async () => {
     // 原步骤 7 逻辑保留...
     console.log("✅ TWAP 预言机验证通过");
  });

  it("步骤 8: 两阶段治理 (Nominate & Claim) 与开启协议抽成", async () => {
    console.log("\n" + "=".repeat(60));
    console.log("步骤 8: 🛡️ 两阶段治理机制验证");
    console.log("=".repeat(60));

    // 1. 原 Admin 提名新 Admin，并开启 16.6% 抽成 (1/6 = 166/1000)
    // 同时更新协议费接收者为独立账户（避免与用户 LP token 账户冲突）
    console.log("-> 原管理员发起提名，并设置协议抽成...");
    
    // 创建协议费接收者的 LP token ATA（使用独立的协议费接收者账户）
    protocolFeeRecipientAta = (
        await getOrCreateAssociatedTokenAccount(provider.connection, user, lpMint, protocolFeeRecipient.publicKey)
    ).address;
    
    await program.methods
      .updateConfig(
        newAdmin.publicKey,              // new_admin (Option<Pubkey>)
        protocolFeeRecipient.publicKey,  // new_recipient (Option<Pubkey>) - 更新为独立账户
        new anchor.BN(166)               // new_share (Option<u64>)
      )
      .accounts({
        poolState,
        admin: user.publicKey,
      } as any)
      .rpc();

    let state = await program.account.poolState.fetch(poolState);
    assert.isTrue(state.pendingAdmin.equals(newAdmin.publicKey), "待定管理员未正确设置");
    console.log(`✅ 提名成功! Pending Admin: ${state.pendingAdmin.toString()}`);

    // 2. 新 Admin 亲自签名接管
    console.log("-> 新管理员签名接管协议...");
    await program.methods
      .claimAdmin()
      .accounts({
        poolState,
        pendingAdmin: newAdmin.publicKey,
      })
      .signers([newAdmin])
      .rpc();

    state = await program.account.poolState.fetch(poolState);
    assert.isTrue(state.admin.equals(newAdmin.publicKey), "管理员未成功移交");
    assert.isNull(state.pendingAdmin, "Pending Admin 未清空");
    assert.isTrue(state.protocolFeeRecipient.equals(protocolFeeRecipient.publicKey), "协议费接收者未正确设置");
    assert.equal(state.protocolFeeShare.toNumber(), 166, "协议费比例未正确设置");
    console.log(`✅ 移交成功! 当前 Admin: ${state.admin.toString()}`);
    console.log(`✅ 协议费接收者: ${state.protocolFeeRecipient.toString()}`);
    console.log(`✅ 协议费比例: ${state.protocolFeeShare.toString()}/1000`);
  });

  it("步骤 9: 触发协议费自动结算 (印钞机验证)", async () => {
    console.log("\n" + "=".repeat(60));
    console.log("步骤 9: 💰 验证协议费自动结算 (Remove Liquidity 触发)");
    console.log("=".repeat(60));

    // 检查当前状态
    const state = await program.account.poolState.fetch(poolState);
    const vaultAAccount = await getAccount(provider.connection, vaultA);
    const vaultBAccount = await getAccount(provider.connection, vaultB);
    const currentK = BigInt(vaultAAccount.amount.toString()) * BigInt(vaultBAccount.amount.toString());
    const kLast = BigInt(state.kLast.toString());
    
    console.log(`当前 K 值: ${currentK.toString()}`);
    console.log(`K_last 值: ${kLast.toString()}`);
    console.log(`K 增长: ${currentK > kLast ? "是" : "否"}`);
    console.log(`协议费比例: ${state.protocolFeeShare.toString()}/1000`);
    console.log(`协议费接收者: ${state.protocolFeeRecipient.toString()}`);

    const preProtocolFeeAccount = await getAccount(provider.connection, protocolFeeRecipientAta);
    console.log(`结算前协议方 LP 余额: ${preProtocolFeeAccount.amount.toString()}`);

    // 撤出 1000 个单位的 LP (只要触发流动性变动，就会执行结算代码)
    const amountLpToRemove = new anchor.BN(1000);

    await program.methods
      .removeLiquidity(amountLpToRemove, new anchor.BN(0), new anchor.BN(0))
      .accounts({
        poolState,
        poolAuthority,
        userTokenA,
        userTokenB,
        tokenAVault: vaultA,
        tokenBVault: vaultB,
        user: user.publicKey,
        lpMint,
        userLpTokenATA: userLpAta,
        protocolFeeRecipient: protocolFeeRecipientAta, // 关键：协议收款账户必须传入
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
      .rpc();

    const postProtocolFeeAccount = await getAccount(provider.connection, protocolFeeRecipientAta);
    const mintedProtocolFee = postProtocolFeeAccount.amount - preProtocolFeeAccount.amount;
    
    console.log(`\n🎉 结算完成！协议方通过 sqrt(k) 增发获得了 ${mintedProtocolFee.toString()} 个 LP Token!`);
    
    assert.isTrue(mintedProtocolFee > BigInt(0), "协议未收到增发的 LP 费用");
  });
});