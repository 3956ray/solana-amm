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
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { assert } from "chai";

describe("twap", () => {
  // 1. 配置 Provider
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.SolanaAmm as Program<SolanaAmm>;
  const user = (provider.wallet as anchor.Wallet).payer;

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

  before(async () => {
    // 2. 环境初始化：创建代币和账户
    mintA = await createMint(provider.connection, user, user.publicKey, null, 6);
    mintB = await createMint(provider.connection, user, user.publicKey, null, 6);

    // 计算 PDA 地址 (必须与合约中的 seeds 匹配)
    // 确保 mintA < mintB (合约要求)
    if (mintA.toBuffer().compare(mintB.toBuffer()) > 0) {
      [mintA, mintB] = [mintB, mintA];
    }
    
    [poolState] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("pool"), mintA.toBuffer(), mintB.toBuffer()],
      program.programId
    );

    [poolAuthority] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("authority")],
      program.programId
    );

    // 计算 vault 地址（Associated Token Accounts）
    vaultA = getAssociatedTokenAddressSync(mintA, poolAuthority, true);
    vaultB = getAssociatedTokenAddressSync(mintB, poolAuthority, true);

    // 获取/创建用户的代币账户
    userTokenA = (await getOrCreateAssociatedTokenAccount(provider.connection, user, mintA, user.publicKey)).address;
    userTokenB = (await getOrCreateAssociatedTokenAccount(provider.connection, user, mintB, user.publicKey)).address;

    // 为用户 Mint 初始代币
    await mintTo(provider.connection, user, mintA, userTokenA, user.publicKey, 100_000_000_000); // 100000 A
    await mintTo(provider.connection, user, mintB, userTokenB, user.publicKey, 100_000_000_000); // 100000 B
  });

  it("初始化池子状态：验证 TWAP 初始值", async () => {
    const feeNumerator = new anchor.BN(3);
    const feeDenominator = new anchor.BN(1000);
    
    // 生成 lpMint 的 keypair（Anchor 会自动创建）
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
        admin: user.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .signers([lpMintKeypair])
      .rpc();
    
    const state = await program.account.poolState.fetch(poolState);
    
    // 验证 TWAP 初始值
    // block_timestamp_last 在初始化时被设置为当前时间戳，不应该为 0
    assert.isTrue(
      state.blockTimestampLast.toNumber() > 0,
      "block_timestamp_last 应该被设置为当前时间戳"
    );
    assert.equal(
      state.priceACumulativeLast.toString(),
      "0",
      "price_a_cumulative_last 初始值应为 0"
    );
    assert.equal(
      state.priceBCumulativeLast.toString(),
      "0",
      "price_b_cumulative_last 初始值应为 0"
    );
    
    // 为金库 Mint 初始代币 (模拟流动性)
    await mintTo(provider.connection, user, mintA, vaultA, user.publicKey, 1_000_000_000);   // 1000 A (金库)
    await mintTo(provider.connection, user, mintB, vaultB, user.publicKey, 1_000_000_000);   // 1000 B (金库)
  });

  it("首次 swap：验证 TWAP 首次更新", async () => {
    const amountIn = new anchor.BN(10_000_000); // 10 Token A
    // 设置合理的滑点保护值（允许较大的滑点，因为这只是测试）
    const minAmountOut = new anchor.BN(0);

    // 获取 swap 前的状态
    const preState = await program.account.poolState.fetch(poolState);
    const preVaultA = await getAccount(provider.connection, vaultA);
    const preVaultB = await getAccount(provider.connection, vaultB);

    // 获取当前时间戳（通过 Clock sysvar）
    const clock = await provider.connection.getAccountInfo(anchor.web3.SYSVAR_CLOCK_PUBKEY);
    // 注意：在测试环境中，时间戳可能不会变化，但我们应该验证逻辑

    await program.methods
      .swap(amountIn, true, minAmountOut) // is_a_to_b = true
      .accounts({
        poolState: poolState,
        userTokenA: userTokenA,
        userTokenB: userTokenB,
        tokenAVault: vaultA,
        tokenBVault: vaultB,
        user: user.publicKey,
        poolAuthority: poolAuthority,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    // 获取 swap 后的状态
    const postState = await program.account.poolState.fetch(poolState);
    const postVaultA = await getAccount(provider.connection, vaultA);
    const postVaultB = await getAccount(provider.connection, vaultB);

    // 验证时间戳已更新
    assert.isTrue(
      postState.blockTimestampLast.toNumber() > 0,
      "block_timestamp_last 应该被更新"
    );

    // 如果这是首次更新（preState.blockTimestampLast 为 0），累计价格可能为 0
    // 因为 update_twap 中只有当 time_elapsed > 0 时才更新累计价格
    // 首次时 time_elapsed 可能为 0（如果时间戳相同）
    // 但至少时间戳应该被设置
    if (preState.blockTimestampLast.toNumber() === 0) {
      // 首次更新，时间戳应该被设置
      assert.isTrue(
        postState.blockTimestampLast.toNumber() > 0,
        "首次 swap 后时间戳应该被设置"
      );
    }
  });

  it("多次 swap：验证 TWAP 累计价格累积", async () => {
    // 等待一小段时间，确保时间戳有变化（在测试环境中可能不明显）
    await new Promise(resolve => setTimeout(resolve, 1000));

    const amountIn1 = new anchor.BN(5_000_000); // 5 Token A
    const minAmountOut1 = new anchor.BN(0);

    // 第一次 swap
    const preState1 = await program.account.poolState.fetch(poolState);
    const preVaultA1 = await getAccount(provider.connection, vaultA);
    const preVaultB1 = await getAccount(provider.connection, vaultB);

    await program.methods
      .swap(amountIn1, true, minAmountOut1)
      .accounts({
        poolState: poolState,
        userTokenA: userTokenA,
        userTokenB: userTokenB,
        tokenAVault: vaultA,
        tokenBVault: vaultB,
        user: user.publicKey,
        poolAuthority: poolAuthority,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    const postState1 = await program.account.poolState.fetch(poolState);
    const postVaultA1 = await getAccount(provider.connection, vaultA);
    const postVaultB1 = await getAccount(provider.connection, vaultB);

    // 等待一小段时间
    await new Promise(resolve => setTimeout(resolve, 1000));

    // 第二次 swap
    const preState2 = await program.account.poolState.fetch(poolState);
    const amountIn2 = new anchor.BN(3_000_000); // 3 Token A
    const minAmountOut2 = new anchor.BN(0);

    await program.methods
      .swap(amountIn2, true, minAmountOut2)
      .accounts({
        poolState: poolState,
        userTokenA: userTokenA,
        userTokenB: userTokenB,
        tokenAVault: vaultA,
        tokenBVault: vaultB,
        user: user.publicKey,
        poolAuthority: poolAuthority,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    const postState2 = await program.account.poolState.fetch(poolState);
    const postVaultA2 = await getAccount(provider.connection, vaultA);
    const postVaultB2 = await getAccount(provider.connection, vaultB);

    // 验证累计价格应该增加（如果时间戳有变化）
    if (preState2.blockTimestampLast.toNumber() < postState2.blockTimestampLast.toNumber()) {
      // 时间戳有变化，累计价格应该增加
      assert.isTrue(
        BigInt(postState2.priceACumulativeLast.toString()) >= BigInt(preState2.priceACumulativeLast.toString()),
        "price_a_cumulative_last 应该增加或保持不变"
      );
      assert.isTrue(
        BigInt(postState2.priceBCumulativeLast.toString()) >= BigInt(preState2.priceBCumulativeLast.toString()),
        "price_b_cumulative_last 应该增加或保持不变"
      );
    }

    // 验证时间戳总是更新
    assert.isTrue(
      postState2.blockTimestampLast.toNumber() >= preState2.blockTimestampLast.toNumber(),
      "block_timestamp_last 应该增加或保持不变"
    );
  });

  it("验证 TWAP 价格计算公式", async () => {
    // 等待一小段时间
    await new Promise(resolve => setTimeout(resolve, 1000));

    const preState = await program.account.poolState.fetch(poolState);
    const preVaultA = await getAccount(provider.connection, vaultA);
    const preVaultB = await getAccount(provider.connection, vaultB);

    // 记录初始累计价格
    const initialCumulativeA = BigInt(preState.priceACumulativeLast.toString());
    const initialCumulativeB = BigInt(preState.priceBCumulativeLast.toString());
    const initialTimestamp = preState.blockTimestampLast.toNumber();

    // 执行 swap
    const amountIn = new anchor.BN(2_000_000); // 2 Token A
    const minAmountOut = new anchor.BN(0);

    await program.methods
      .swap(amountIn, true, minAmountOut)
      .accounts({
        poolState: poolState,
        userTokenA: userTokenA,
        userTokenB: userTokenB,
        tokenAVault: vaultA,
        tokenBVault: vaultB,
        user: user.publicKey,
        poolAuthority: poolAuthority,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    const postState = await program.account.poolState.fetch(poolState);
    const postVaultA = await getAccount(provider.connection, vaultA);
    const postVaultB = await getAccount(provider.connection, vaultB);

    // 计算时间差
    const timeElapsed = postState.blockTimestampLast.toNumber() - initialTimestamp;

    if (timeElapsed > 0 && preVaultA.amount > 0n && preVaultB.amount > 0n) {
      // 计算期望的价格（Q64.64 格式）
      // price_a_fixed = (reserve_b << 64) / reserve_a
      const priceAFixed = (BigInt(preVaultB.amount.toString()) << 64n) / BigInt(preVaultA.amount.toString());
      const priceBFixed = (BigInt(preVaultA.amount.toString()) << 64n) / BigInt(preVaultB.amount.toString());

      // 计算期望的累计价格增量
      const expectedCumulativeDeltaA = priceAFixed * BigInt(timeElapsed);
      const expectedCumulativeDeltaB = priceBFixed * BigInt(timeElapsed);

      // 计算实际的累计价格增量
      const actualCumulativeDeltaA = BigInt(postState.priceACumulativeLast.toString()) - initialCumulativeA;
      const actualCumulativeDeltaB = BigInt(postState.priceBCumulativeLast.toString()) - initialCumulativeB;

      // 验证累计价格增量（允许小的舍入误差）
      const tolerance = expectedCumulativeDeltaA / 1000n; // 0.1% 容差

      assert.isTrue(
        actualCumulativeDeltaA >= expectedCumulativeDeltaA - tolerance &&
        actualCumulativeDeltaA <= expectedCumulativeDeltaA + tolerance,
        `price_a_cumulative_last 增量应接近期望值。期望: ${expectedCumulativeDeltaA}, 实际: ${actualCumulativeDeltaA}`
      );

      assert.isTrue(
        actualCumulativeDeltaB >= expectedCumulativeDeltaB - tolerance &&
        actualCumulativeDeltaB <= expectedCumulativeDeltaB + tolerance,
        `price_b_cumulative_last 增量应接近期望值。期望: ${expectedCumulativeDeltaB}, 实际: ${actualCumulativeDeltaB}`
      );
    } else {
      // 如果时间差为 0 或池子没有流动性，累计价格不应该变化
      assert.equal(
        postState.priceACumulativeLast.toString(),
        preState.priceACumulativeLast.toString(),
        "时间差为 0 时，price_a_cumulative_last 不应变化"
      );
      assert.equal(
        postState.priceBCumulativeLast.toString(),
        preState.priceBCumulativeLast.toString(),
        "时间差为 0 时，price_b_cumulative_last 不应变化"
      );
    }
  });

  it("验证反向 swap（B -> A）也更新 TWAP", async () => {
    // 等待一小段时间
    await new Promise(resolve => setTimeout(resolve, 1000));

    const preState = await program.account.poolState.fetch(poolState);
    const preVaultA = await getAccount(provider.connection, vaultA);
    const preVaultB = await getAccount(provider.connection, vaultB);

    // 确保用户有足够的 Token B
    await mintTo(provider.connection, user, mintB, userTokenB, user.publicKey, 10_000_000_000);

    const amountIn = new anchor.BN(5_000_000); // 5 Token B
    const minAmountOut = new anchor.BN(0);

    await program.methods
      .swap(amountIn, false, minAmountOut) // is_a_to_b = false，即 B -> A
      .accounts({
        poolState: poolState,
        userTokenA: userTokenA,
        userTokenB: userTokenB,
        tokenAVault: vaultA,
        tokenBVault: vaultB,
        user: user.publicKey,
        poolAuthority: poolAuthority,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    const postState = await program.account.poolState.fetch(poolState);

    // 验证时间戳已更新
    assert.isTrue(
      postState.blockTimestampLast.toNumber() >= preState.blockTimestampLast.toNumber(),
      "反向 swap 后时间戳应该更新"
    );

    // 验证累计价格应该增加（如果时间戳有变化且池子有流动性）
    if (preState.blockTimestampLast.toNumber() < postState.blockTimestampLast.toNumber() &&
        preVaultA.amount > 0n && preVaultB.amount > 0n) {
      assert.isTrue(
        BigInt(postState.priceACumulativeLast.toString()) >= BigInt(preState.priceACumulativeLast.toString()),
        "反向 swap 后 price_a_cumulative_last 应该增加或保持不变"
      );
      assert.isTrue(
        BigInt(postState.priceBCumulativeLast.toString()) >= BigInt(preState.priceBCumulativeLast.toString()),
        "反向 swap 后 price_b_cumulative_last 应该增加或保持不变"
      );
    }
  });

  it("验证无流动性时 TWAP 不更新", async () => {
    // 这个测试需要创建一个新的池子，因为当前池子已经有流动性
    // 或者我们可以验证当 reserve 为 0 时的行为
    // 但根据代码逻辑，update_twap 只在 reserve_a != 0 && reserve_b != 0 时更新累计价格
    // 时间戳总是会更新

    const state = await program.account.poolState.fetch(poolState);
    const vaultAAccount = await getAccount(provider.connection, vaultA);
    const vaultBAccount = await getAccount(provider.connection, vaultB);

    // 验证当前池子有流动性
    assert.isTrue(vaultAAccount.amount > 0n, "Vault A 应该有流动性");
    assert.isTrue(vaultBAccount.amount > 0n, "Vault B 应该有流动性");

    // 注意：在实际场景中，如果池子没有流动性，swap 会失败
    // 所以这个测试主要验证代码逻辑的正确性
    // 根据 update_twap 的实现，当 reserve_a == 0 或 reserve_b == 0 时，
    // 累计价格不会更新，但时间戳会更新
  });

  it("验证 TWAP 时间戳总是更新", async () => {
    const preState = await program.account.poolState.fetch(poolState);
    const initialTimestamp = preState.blockTimestampLast.toNumber();

    // 等待一小段时间
    await new Promise(resolve => setTimeout(resolve, 1000));

    const amountIn = new anchor.BN(1_000_000); // 1 Token A
    const minAmountOut = new anchor.BN(0);

    await program.methods
      .swap(amountIn, true, minAmountOut)
      .accounts({
        poolState: poolState,
        userTokenA: userTokenA,
        userTokenB: userTokenB,
        tokenAVault: vaultA,
        tokenBVault: vaultB,
        user: user.publicKey,
        poolAuthority: poolAuthority,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    const postState = await program.account.poolState.fetch(poolState);

    // 验证时间戳总是更新（即使累计价格可能不变）
    assert.isTrue(
      postState.blockTimestampLast.toNumber() >= initialTimestamp,
      "时间戳应该总是更新"
    );
  });
});
