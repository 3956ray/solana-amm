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

describe("add-liquidity", () => {
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

  it("首次 add_liquidity：铸 MINIMUM_LIQUIDITY 到黑洞 + 给用户铸 LP", async () => {
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
    const MINIMUM_LIQUIDITY = 1000n;

    const preUserA = await getAccount(provider.connection, userTokenA);
    const preUserB = await getAccount(provider.connection, userTokenB);
    const preVaultA = await getAccount(provider.connection, vaultA);
    const preVaultB = await getAccount(provider.connection, vaultB);
    const preLpMint = await getMint(provider.connection, lpMint);
    const preBlackHole = await getAccount(provider.connection, blackHoleLpAta);

    assert.equal(preLpMint.supply, 0n, "首次加池前 lp mint supply 应为 0");

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

    const postUserA = await getAccount(provider.connection, userTokenA);
    const postUserB = await getAccount(provider.connection, userTokenB);
    const postVaultA = await getAccount(provider.connection, vaultA);
    const postVaultB = await getAccount(provider.connection, vaultB);
    const postLpMint = await getMint(provider.connection, lpMint);
    const postBlackHole = await getAccount(provider.connection, blackHoleLpAta);
    const postUserLp = await getAccount(provider.connection, userLpAta);

    // 断言：用户 tokenA/B 减少，vault 增加
    assert.equal(
      postUserA.amount,
      preUserA.amount - BigInt(depositA),
      "用户 Token A 应减少 depositA"
    );
    assert.equal(
      postUserB.amount,
      preUserB.amount - BigInt(depositB),
      "用户 Token B 应减少 depositB"
    );
    assert.equal(
      postVaultA.amount,
      preVaultA.amount + BigInt(depositA),
      "Vault A 应增加 depositA"
    );
    assert.equal(
      postVaultB.amount,
      preVaultB.amount + BigInt(depositB),
      "Vault B 应增加 depositB"
    );

    // 断言：黑洞收到 MINIMUM_LIQUIDITY
    assert.equal(
      postBlackHole.amount,
      preBlackHole.amount + MINIMUM_LIQUIDITY,
      "黑洞 LP ATA 应收到 MINIMUM_LIQUIDITY"
    );

    // 断言：给用户铸的 LP = sqrt(a*b) - MINIMUM_LIQUIDITY（按合约实现，用 raw units 计算）
    // 这里 a,b 是用户存入的 raw base units（u64）
    const expectedInitialLiquidity = BigInt(
      Math.floor(Math.sqrt(depositA * depositB))
    );
    const expectedUserLp = expectedInitialLiquidity - MINIMUM_LIQUIDITY;
    assert.isTrue(expectedUserLp > 0n, "首次流动性应大于 0");

    assert.equal(postUserLp.amount, expectedUserLp, "用户 LP 余额应等于期望铸造量");
    assert.equal(
      postLpMint.supply,
      expectedUserLp + MINIMUM_LIQUIDITY,
      "lp mint supply 应等于 用户LP + MINIMUM_LIQUIDITY"
    );
  });

  it("非首次 add_liquidity：按储备比例铸 LP（取 min(liquidity_a, liquidity_b)）", async () => {
    const preVaultA = await getAccount(provider.connection, vaultA);
    const preVaultB = await getAccount(provider.connection, vaultB);
    const preLpMint = await getMint(provider.connection, lpMint);
    const preUserLp = await getAccount(provider.connection, userLpAta);
    const preBlackHole = await getAccount(provider.connection, blackHoleLpAta);

    // 选择一个 A 的存入量，然后按当前池子比例计算 B，尽量减少 min 分支的影响
    const depositA = 5_000_000n; // 5 A
    const depositB = (preVaultB.amount * depositA) / preVaultA.amount; // 保持比例（向下取整）

    const expectedLiquidityA = (depositA * preLpMint.supply) / preVaultA.amount;
    const expectedLiquidityB = (depositB * preLpMint.supply) / preVaultB.amount;
    const expectedMint = expectedLiquidityA < expectedLiquidityB ? expectedLiquidityA : expectedLiquidityB;

    const preUserA = await getAccount(provider.connection, userTokenA);
    const preUserB = await getAccount(provider.connection, userTokenB);

    await program.methods
      .addLiquidity(new anchor.BN(depositA.toString()), new anchor.BN(depositB.toString()))
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

    const postVaultA = await getAccount(provider.connection, vaultA);
    const postVaultB = await getAccount(provider.connection, vaultB);
    const postLpMint = await getMint(provider.connection, lpMint);
    const postUserLp = await getAccount(provider.connection, userLpAta);
    const postBlackHole = await getAccount(provider.connection, blackHoleLpAta);
    const postUserA = await getAccount(provider.connection, userTokenA);
    const postUserB = await getAccount(provider.connection, userTokenB);

    // vault 与用户余额变化
    assert.equal(postVaultA.amount, preVaultA.amount + depositA, "Vault A 应增加 depositA");
    assert.equal(postVaultB.amount, preVaultB.amount + depositB, "Vault B 应增加 depositB");
    assert.equal(postUserA.amount, preUserA.amount - depositA, "用户 A 应减少 depositA");
    assert.equal(postUserB.amount, preUserB.amount - depositB, "用户 B 应减少 depositB");

    // 黑洞不应再变化（只在首次铸）
    assert.equal(postBlackHole.amount, preBlackHole.amount, "非首次加池不应再给黑洞铸 LP");

    // LP 供给与用户 LP 增量
    assert.equal(
      postUserLp.amount,
      preUserLp.amount + expectedMint,
      "用户 LP 应增加 expectedMint"
    );
    assert.equal(
      postLpMint.supply,
      preLpMint.supply + expectedMint,
      "lp mint supply 应增加 expectedMint"
    );
  });
});
