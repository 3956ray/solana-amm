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
  getMint,
} from "@solana/spl-token";
import { assert } from "chai";

describe("remove-liquidity", () => {
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
  let blackHoleLpAta: anchor.web3.PublicKey;
  let userLpAta: anchor.web3.PublicKey;

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
    await mintTo(provider.connection, user, mintA, userTokenA, user.publicKey, 100_000_000); // 100 A
    await mintTo(provider.connection, user, mintB, userTokenB, user.publicKey, 100_000_000); // 100 B
  });

  it("初始化池子状态", async () => {
    // 调用 initialize 指令
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
    assert.ok(state.tokenAVault.equals(vaultA));
    
    // 为金库 Mint 初始代币 (模拟流动性)
    await mintTo(provider.connection, user, mintA, vaultA, user.publicKey, 1_000_000_000);   // 1000 A (金库)
    await mintTo(provider.connection, user, mintB, vaultB, user.publicKey, 1_000_000_000);   // 1000 B (金库)
  });

  it("首次 add_liquidity：为用户创建 LP Token", async () => {
    // black hole owner: Pubkey::default() in rust -> all zeros -> base58 is all '1'
    const BLACK_HOLE_OWNER = new anchor.web3.PublicKey("11111111111111111111111111111111");

    userLpAta = getAssociatedTokenAddressSync(lpMint, user.publicKey);
    blackHoleLpAta = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        user,
        lpMint,
        BLACK_HOLE_OWNER,
        true
      )
    ).address;

    const depositA = 10_000_000; // 10 A (mintA decimals=6)
    const depositB = 10_000_000; // 10 B (mintB decimals=6)

    await program.methods
      .addLiquidity(new anchor.BN(depositA), new anchor.BN(depositB))
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
        blackHoleLpAta: blackHoleLpAta,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    const postUserLp = await getAccount(provider.connection, userLpAta);
    assert.isTrue(postUserLp.amount > 0n, "用户应该有 LP Token");
  });

  it("remove_liquidity：销毁 50% 的 LP Token 并验证余额变化", async () => {
    // 1. 查询调用前的余额
    const preUserLp = await getAccount(provider.connection, userLpAta);
    const preUserTokenA = await getAccount(provider.connection, userTokenA);
    const preUserTokenB = await getAccount(provider.connection, userTokenB);
    const preVaultA = await getAccount(provider.connection, vaultA);
    const preVaultB = await getAccount(provider.connection, vaultB);
    const preLpMint = await getMint(provider.connection, lpMint);

    // 确保用户有 LP Token
    assert.isTrue(preUserLp.amount > 0n, "用户应该有 LP Token");

    // 计算要销毁的 LP 数量（50%）
    const amountLpToRemove = preUserLp.amount / 2n;
    const amountLpToRemoveU64 = Number(amountLpToRemove);

    // 计算期望获得的 Token A 和 B（按比例）
    const expectedAmountA = (amountLpToRemove * preVaultA.amount) / preLpMint.supply;
    const expectedAmountB = (amountLpToRemove * preVaultB.amount) / preLpMint.supply;

    // 设置滑点保护（允许 1% 的误差）
    const minAmountA = expectedAmountA * 99n / 100n;
    const minAmountB = expectedAmountB * 99n / 100n;

    // 2. 执行撤资
    await program.methods
      .removeLiquidity(
        new anchor.BN(amountLpToRemoveU64),
        new anchor.BN(Number(minAmountA)),
        new anchor.BN(Number(minAmountB))
      )
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
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    // 3. 查询调用后的余额
    const postUserLp = await getAccount(provider.connection, userLpAta);
    const postUserTokenA = await getAccount(provider.connection, userTokenA);
    const postUserTokenB = await getAccount(provider.connection, userTokenB);
    const postVaultA = await getAccount(provider.connection, vaultA);
    const postVaultB = await getAccount(provider.connection, vaultB);
    const postLpMint = await getMint(provider.connection, lpMint);

    // 4. 结果断言

    // 断言：用户的 LP 余额是否减少了？
    assert.equal(
      postUserLp.amount,
      preUserLp.amount - amountLpToRemove,
      "用户的 LP 余额应减少 amountLpToRemove"
    );

    // 断言：用户的 Token A/B 余额是否增加了？
    const actualAmountAReceived = postUserTokenA.amount - preUserTokenA.amount;
    const actualAmountBReceived = postUserTokenB.amount - preUserTokenB.amount;

    assert.isTrue(
      actualAmountAReceived > 0n,
      "用户的 Token A 余额应该增加"
    );
    assert.isTrue(
      actualAmountBReceived > 0n,
      "用户的 Token B 余额应该增加"
    );

    // 验证实际收到的数量接近期望值（允许小的舍入误差）
    const toleranceA = expectedAmountA / 1000n; // 0.1% 容差
    const toleranceB = expectedAmountB / 1000n; // 0.1% 容差
    
    assert.isTrue(
      actualAmountAReceived >= expectedAmountA - toleranceA && 
      actualAmountAReceived <= expectedAmountA + toleranceA,
      `用户收到的 Token A 应接近期望值。期望: ${expectedAmountA}, 实际: ${actualAmountAReceived}`
    );
    
    assert.isTrue(
      actualAmountBReceived >= expectedAmountB - toleranceB && 
      actualAmountBReceived <= expectedAmountB + toleranceB,
      `用户收到的 Token B 应接近期望值。期望: ${expectedAmountB}, 实际: ${actualAmountBReceived}`
    );

    // 断言：池子的金库余额是否按比例减少了？
    const vaultADecrease = preVaultA.amount - postVaultA.amount;
    const vaultBDecrease = preVaultB.amount - postVaultB.amount;

    assert.equal(
      vaultADecrease,
      actualAmountAReceived,
      "Vault A 的减少量应等于用户收到的 Token A 数量"
    );
    assert.equal(
      vaultBDecrease,
      actualAmountBReceived,
      "Vault B 的减少量应等于用户收到的 Token B 数量"
    );

    // 验证 LP Mint 的总供应量也减少了
    assert.equal(
      postLpMint.supply,
      preLpMint.supply - amountLpToRemove,
      "LP Mint 的总供应量应减少 amountLpToRemove"
    );

    // 验证比例关系：用户收到的 Token A 和 B 的比例应该与池子中的比例一致
    if (preVaultA.amount > 0n && preVaultB.amount > 0n) {
      const poolRatioA = preVaultA.amount * 1000n / preVaultB.amount;
      const receivedRatioA = actualAmountAReceived * 1000n / actualAmountBReceived;
      
      // 允许 1% 的误差
      const ratioTolerance = poolRatioA / 100n;
      assert.isTrue(
        receivedRatioA >= poolRatioA - ratioTolerance && 
        receivedRatioA <= poolRatioA + ratioTolerance,
        `用户收到的 Token A/B 比例应与池子比例一致。池子比例: ${poolRatioA}, 收到比例: ${receivedRatioA}`
      );
    }
  });
});
