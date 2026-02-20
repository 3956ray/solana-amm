import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { SolanaAmm } from "../target/types/solana_amm";
import { 
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createMint, 
  getOrCreateAssociatedTokenAccount, 
  mintTo, 
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { assert } from "chai";

describe("update_config - 更新池子配置", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.SolanaAmm as Program<SolanaAmm>;
  const admin = (provider.wallet as anchor.Wallet).payer;

  // 账户声明
  let mintA: anchor.web3.PublicKey;
  let mintB: anchor.web3.PublicKey;
  let poolState: anchor.web3.PublicKey;
  let poolAuthority: anchor.web3.PublicKey;
  let lpMint: anchor.web3.PublicKey;

  // 用于测试的新账户
  let newAdmin: anchor.web3.Keypair;
  let newRecipient: anchor.web3.Keypair;

  before(async () => {
    console.log("\n🚀 初始化测试环境...\n");

    // 创建代币
    mintA = await createMint(provider.connection, admin, admin.publicKey, null, 6);
    mintB = await createMint(provider.connection, admin, admin.publicKey, null, 6);

    // 确保 mintA < mintB（合约要求）
    if (mintA.toBuffer().compare(mintB.toBuffer()) > 0) {
      [mintA, mintB] = [mintB, mintA];
    }

    // 计算 PDA 地址
    [poolState] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("pool"), mintA.toBuffer(), mintB.toBuffer()],
      program.programId
    );

    [poolAuthority] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("authority")],
      program.programId
    );

    const vaultA = getAssociatedTokenAddressSync(mintA, poolAuthority, true);
    const vaultB = getAssociatedTokenAddressSync(mintB, poolAuthority, true);

    // 初始化池子
    const feeNumerator = new anchor.BN(3);
    const feeDenominator = new anchor.BN(1000);

    const lpMintKeypair = anchor.web3.Keypair.generate();
    lpMint = lpMintKeypair.publicKey;

    await program.methods
      .initialize(mintA, mintB, feeNumerator, feeDenominator)
      .accounts({
        poolState: poolState,
        poolAuthority: poolAuthority,
        tokenA: mintA,
        tokenB: mintB,
        tokenAVault: vaultA,
        tokenBVault: vaultB,
        lpMint: lpMint,
        admin: admin.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .signers([lpMintKeypair])
      .rpc();

    console.log(`✅ 池子初始化成功`);
    console.log(`   Pool State: ${poolState.toString()}`);
    console.log(`   Admin: ${admin.publicKey.toString()}`);

    // 创建用于测试的新账户
    newAdmin = anchor.web3.Keypair.generate();
    newRecipient = anchor.web3.Keypair.generate();

    // 为新账户空投 SOL（用于支付交易费用）
    const signature1 = await provider.connection.requestAirdrop(
      newAdmin.publicKey,
      2 * anchor.web3.LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(signature1);

    const signature2 = await provider.connection.requestAirdrop(
      newRecipient.publicKey,
      2 * anchor.web3.LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(signature2);

    console.log(`✅ 测试账户创建完成`);
    console.log(`   新 Admin: ${newAdmin.publicKey.toString()}`);
    console.log(`   新 Recipient: ${newRecipient.publicKey.toString()}\n`);
  });

  it("应该能够更新 admin 地址", async () => {
    console.log("测试: 更新 admin 地址");

    // 获取更新前的状态
    const stateBefore = await program.account.poolState.fetch(poolState);
    const oldAdmin = stateBefore.admin;
    console.log(`   更新前 admin: ${oldAdmin.toString()}`);

    // 第一步：设置 pending_admin
    await program.methods
      .updateConfig(newAdmin.publicKey, null, null)
      .accounts({
        poolState: poolState,
        admin: admin.publicKey,
      })
      .rpc();

    // 验证 pending_admin 已设置
    const stateAfterPending = await program.account.poolState.fetch(poolState);
    assert.ok(
      stateAfterPending.pendingAdmin !== null,
      "pending_admin 应该已设置"
    );
    assert.ok(
      stateAfterPending.pendingAdmin?.equals(newAdmin.publicKey),
      "pending_admin 应该是 newAdmin"
    );
    assert.ok(
      stateAfterPending.admin.equals(oldAdmin),
      "admin 应该还是旧地址（等待确认）"
    );

    // 第二步：由 pending_admin 确认并正式移交权限
    await program.methods
      .claimAdmin()
      .accounts({
        poolState: poolState,
        pendingAdmin: newAdmin.publicKey,
      })
      .signers([newAdmin])
      .rpc();

    // 验证更新后的状态
    const stateAfter = await program.account.poolState.fetch(poolState);
    console.log(`   更新后 admin: ${stateAfter.admin.toString()}`);

    assert.ok(
      stateAfter.admin.equals(newAdmin.publicKey),
      "admin 应该已更新为新地址"
    );
    assert.ok(
      !stateAfter.admin.equals(oldAdmin),
      "admin 应该与旧地址不同"
    );
    assert.ok(
      stateAfter.pendingAdmin === null,
      "pending_admin 应该已被清空"
    );

    console.log("✅ admin 更新成功\n");
  });

  it("应该能够更新 protocol_fee_recipient 地址", async () => {
    console.log("测试: 更新 protocol_fee_recipient 地址");

    // 获取更新前的状态
    const stateBefore = await program.account.poolState.fetch(poolState);
    const oldRecipient = stateBefore.protocolFeeRecipient;
    const currentAdmin = stateBefore.admin; // 使用当前的 admin（应该是 newAdmin）
    console.log(`   更新前 recipient: ${oldRecipient.toString()}`);
    console.log(`   当前 admin: ${currentAdmin.toString()}`);

    // 执行更新（protocol_fee_recipient 可以直接更新，不需要两步确认）
    // 如果 currentAdmin 是 newAdmin，需要使用 newAdmin 作为签名者
    const isNewAdmin = currentAdmin.equals(newAdmin.publicKey);
    await program.methods
      .updateConfig(null, newRecipient.publicKey, null)
      .accounts({
        poolState: poolState,
        admin: currentAdmin,
      })
      .signers(isNewAdmin ? [newAdmin] : [])
      .rpc();

    // 验证更新后的状态
    const stateAfter = await program.account.poolState.fetch(poolState);
    console.log(`   更新后 recipient: ${stateAfter.protocolFeeRecipient.toString()}`);

    assert.ok(
      stateAfter.protocolFeeRecipient.equals(newRecipient.publicKey),
      "protocol_fee_recipient 应该已更新为新地址"
    );

    console.log("✅ protocol_fee_recipient 更新成功\n");
  });

  it("应该能够更新 protocol_fee_share", async () => {
    console.log("测试: 更新 protocol_fee_share");

    // 获取更新前的状态
    const stateBefore = await program.account.poolState.fetch(poolState);
    const oldShare = stateBefore.protocolFeeShare.toNumber();
    const currentAdmin = stateBefore.admin; // 使用当前的 admin（应该是 newAdmin）
    console.log(`   更新前 share: ${oldShare}`);

    // 执行更新（设置为 100，即 10%，在允许范围内）
    const newShare = new anchor.BN(100);
    const isNewAdmin = currentAdmin.equals(newAdmin.publicKey);
    await program.methods
      .updateConfig(null, null, newShare)
      .accounts({
        poolState: poolState,
        admin: currentAdmin,
      })
      .signers(isNewAdmin ? [newAdmin] : [])
      .rpc();

    // 验证更新后的状态
    const stateAfter = await program.account.poolState.fetch(poolState);
    console.log(`   更新后 share: ${stateAfter.protocolFeeShare.toString()}`);

    assert.equal(
      stateAfter.protocolFeeShare.toNumber(),
      100,
      "protocol_fee_share 应该已更新为 100"
    );

    console.log("✅ protocol_fee_share 更新成功\n");
  });

  it("应该拒绝无效的 protocol_fee_share (> 500)", async () => {
    console.log("测试: 拒绝无效的 protocol_fee_share (> 500)");

    // 获取当前 admin
    const stateBefore = await program.account.poolState.fetch(poolState);
    const currentAdmin = stateBefore.admin;
    const currentShare = stateBefore.protocolFeeShare.toNumber();

    // 尝试设置超过 500 的 share（应该失败）
    const invalidShare = new anchor.BN(501);
    const isNewAdmin = currentAdmin.equals(newAdmin.publicKey);

    try {
      await program.methods
        .updateConfig(null, null, invalidShare)
        .accounts({
          poolState: poolState,
          admin: currentAdmin,
        })
        .signers(isNewAdmin ? [newAdmin] : [])
        .rpc();

      assert.fail("应该拒绝无效的 protocol_fee_share");
    } catch (err: any) {
      console.log(`   捕获到预期错误: ${err.toString()}`);
      assert.include(
        err.toString(),
        "InvalidFeeConfig",
        "应该返回 InvalidFeeConfig 错误"
      );
    }

    // 验证状态未改变
    const stateAfter = await program.account.poolState.fetch(poolState);
    assert.equal(
      stateAfter.protocolFeeShare.toNumber(),
      currentShare,
      "protocol_fee_share 不应该被更新"
    );

    console.log("✅ 无效 share 值被正确拒绝\n");
  });

  it("应该拒绝非 admin 用户更新配置", async () => {
    console.log("测试: 拒绝非 admin 用户更新配置");

    // 获取当前 admin
    const stateBefore = await program.account.poolState.fetch(poolState);
    const currentAdmin = stateBefore.admin;

    // 创建一个非 admin 用户
    const unauthorizedUser = anchor.web3.Keypair.generate();
    const signature = await provider.connection.requestAirdrop(
      unauthorizedUser.publicKey,
      2 * anchor.web3.LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(signature);

    // 尝试用非 admin 用户更新配置（应该失败）
    try {
      await program.methods
        .updateConfig(admin.publicKey, null, null)
        .accounts({
          poolState: poolState,
          admin: unauthorizedUser.publicKey,
        })
        .signers([unauthorizedUser])
        .rpc();

      assert.fail("应该拒绝非 admin 用户的更新请求");
    } catch (err: any) {
      console.log(`   捕获到预期错误: ${err.toString()}`);
      assert.include(
        err.toString(),
        "Unauthorized",
        "应该返回 Unauthorized 错误"
      );
    }

    // 验证状态未改变
    const stateAfter = await program.account.poolState.fetch(poolState);
    assert.ok(
      stateAfter.admin.equals(currentAdmin),
      "admin 不应该被未授权用户更改"
    );

    console.log("✅ 未授权访问被正确拒绝\n");
  });

  it("应该能够同时更新多个配置项", async () => {
    console.log("测试: 同时更新多个配置项");

    // 获取当前 admin
    const stateBefore = await program.account.poolState.fetch(poolState);
    const currentAdmin = stateBefore.admin;

    // 创建新的测试账户
    const anotherAdmin = anchor.web3.Keypair.generate();
    const anotherRecipient = anchor.web3.Keypair.generate();
    
    const signature1 = await provider.connection.requestAirdrop(
      anotherAdmin.publicKey,
      2 * anchor.web3.LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(signature1);

    const signature2 = await provider.connection.requestAirdrop(
      anotherRecipient.publicKey,
      2 * anchor.web3.LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(signature2);

    // 获取更新前的状态
    console.log(`   更新前 admin: ${stateBefore.admin.toString()}`);
    console.log(`   更新前 recipient: ${stateBefore.protocolFeeRecipient.toString()}`);
    console.log(`   更新前 share: ${stateBefore.protocolFeeShare.toString()}`);

    // 同时更新 admin（设置 pending_admin）、recipient 和 share
    const newShare = new anchor.BN(200);
    const isNewAdmin = currentAdmin.equals(newAdmin.publicKey);
    await program.methods
      .updateConfig(anotherAdmin.publicKey, anotherRecipient.publicKey, newShare)
      .accounts({
        poolState: poolState,
        admin: currentAdmin,
      })
      .signers(isNewAdmin ? [newAdmin] : [])
      .rpc();

    // 验证 recipient 和 share 已直接更新
    const stateAfterUpdate = await program.account.poolState.fetch(poolState);
    assert.ok(
      stateAfterUpdate.protocolFeeRecipient.equals(anotherRecipient.publicKey),
      "protocol_fee_recipient 应该已更新"
    );
    assert.equal(
      stateAfterUpdate.protocolFeeShare.toNumber(),
      200,
      "protocol_fee_share 应该已更新"
    );
    assert.ok(
      stateAfterUpdate.pendingAdmin?.equals(anotherAdmin.publicKey),
      "pending_admin 应该已设置"
    );
    assert.ok(
      stateAfterUpdate.admin.equals(currentAdmin),
      "admin 应该还是旧地址（等待确认）"
    );

    // 由 pending_admin 确认并正式移交权限
    await program.methods
      .claimAdmin()
      .accounts({
        poolState: poolState,
        pendingAdmin: anotherAdmin.publicKey,
      })
      .signers([anotherAdmin])
      .rpc();

    // 验证所有更新
    const stateAfter = await program.account.poolState.fetch(poolState);
    console.log(`   更新后 admin: ${stateAfter.admin.toString()}`);
    console.log(`   更新后 recipient: ${stateAfter.protocolFeeRecipient.toString()}`);
    console.log(`   更新后 share: ${stateAfter.protocolFeeShare.toString()}`);

    assert.ok(
      stateAfter.admin.equals(anotherAdmin.publicKey),
      "admin 应该已更新"
    );
    assert.ok(
      stateAfter.protocolFeeRecipient.equals(anotherRecipient.publicKey),
      "protocol_fee_recipient 应该已更新"
    );
    assert.equal(
      stateAfter.protocolFeeShare.toNumber(),
      200,
      "protocol_fee_share 应该已更新"
    );
    assert.ok(
      stateAfter.pendingAdmin === null,
      "pending_admin 应该已被清空"
    );

    console.log("✅ 多个配置项同时更新成功\n");
  });
});
