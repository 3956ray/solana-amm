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

describe("protocol-fee", () => {
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
  let protocolFeeRecipient: anchor.web3.Keypair; // 协议费接收者
  let protocolFeeRecipientAta: anchor.web3.PublicKey; // 协议费接收者的 LP token ATA

  // 黑洞地址（Pubkey::default() = 全零地址）
  const BLACK_HOLE_OWNER = new anchor.web3.PublicKey("11111111111111111111111111111111");

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

    // 创建协议费接收者账户
    protocolFeeRecipient = anchor.web3.Keypair.generate();

    // 获取/创建用户的代币账户
    userTokenA = (await getOrCreateAssociatedTokenAccount(provider.connection, user, mintA, user.publicKey)).address;
    userTokenB = (await getOrCreateAssociatedTokenAccount(provider.connection, user, mintB, user.publicKey)).address;

    // 为用户 Mint 初始代币
    await mintTo(provider.connection, user, mintA, userTokenA, user.publicKey, 1_000_000_000); // 1000 A
    await mintTo(provider.connection, user, mintB, userTokenB, user.publicKey, 1_000_000_000); // 1000 B
  });

  it("初始化池子状态并设置协议费", async () => {
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
    
    // 设置协议费接收者
    await program.methods
      .updateConfig(
        null, // new_admin (不更新)
        protocolFeeRecipient.publicKey, // new_recipient
        null  // new_share (稍后设置)
      )
      .accounts({
        poolState: poolState,
        admin: user.publicKey,
      })
      .rpc();

    // 设置协议费比例（1/6，即 protocol_fee_share = 6）
    await program.methods
      .updateConfig(
        null, // new_admin (不更新)
        null, // new_recipient (不更新)
        new anchor.BN(6) // new_share = 6 (表示 1/6)
      )
      .accounts({
        poolState: poolState,
        admin: user.publicKey,
      })
      .rpc();

    const stateAfter = await program.account.poolState.fetch(poolState);
    assert.ok(
      stateAfter.protocolFeeRecipient.equals(protocolFeeRecipient.publicKey),
      "协议费接收者应该已设置"
    );
    assert.equal(
      stateAfter.protocolFeeShare.toNumber(),
      6,
      "协议费比例应该为 6 (1/6)"
    );

    // 创建协议费接收者的 LP token ATA
    protocolFeeRecipientAta = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        user,
        lpMint,
        protocolFeeRecipient.publicKey
      )
    ).address;

    // 创建黑洞账户
    blackHoleLpAta = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        user,
        lpMint,
        BLACK_HOLE_OWNER,
        true
      )
    ).address;

    userLpAta = getAssociatedTokenAddressSync(lpMint, user.publicKey);
  });

  it("首次添加流动性（不应产生协议费）", async () => {
    const depositA = 100_000_000; // 100 A
    const depositB = 100_000_000; // 100 B

    const preProtocolFeeAta = await getAccount(provider.connection, protocolFeeRecipientAta);
    const preLpMint = await getMint(provider.connection, lpMint);

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
        protocolFeeRecipient: protocolFeeRecipientAta,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    const postProtocolFeeAta = await getAccount(provider.connection, protocolFeeRecipientAta);
    const postLpMint = await getMint(provider.connection, lpMint);

    // 首次添加流动性时，k_last = 0，不应该产生协议费
    assert.equal(
      postProtocolFeeAta.amount,
      preProtocolFeeAta.amount,
      "首次添加流动性时，协议费接收者不应收到 LP token"
    );

    // 验证 k_last 已更新
    const state = await program.account.poolState.fetch(poolState);
    const vaultA_after = await getAccount(provider.connection, vaultA);
    const vaultB_after = await getAccount(provider.connection, vaultB);
    const expectedKLast = BigInt(vaultA_after.amount.toString()) * BigInt(vaultB_after.amount.toString());
    assert.ok(
      BigInt(state.kLast.toString()) > 0n,
      "k_last 应该大于 0"
    );
  });

  it("执行 swap 交易产生手续费（增加储备金）", async () => {
    const amountIn = new anchor.BN(10_000_000); // 10 Token A
    const minAmountOut = new anchor.BN(0);

    const preVaultA = await getAccount(provider.connection, vaultA);
    const preVaultB = await getAccount(provider.connection, vaultB);

    await program.methods
      .swap(amountIn, true, minAmountOut) // A -> B
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

    const postVaultA = await getAccount(provider.connection, vaultA);
    const postVaultB = await getAccount(provider.connection, vaultB);

    // 验证储备金增加了（因为手续费）
    assert.ok(
      postVaultA.amount > preVaultA.amount,
      "Vault A 应该增加（因为手续费）"
    );
    assert.ok(
      postVaultB.amount < preVaultB.amount,
      "Vault B 应该减少（因为 swap 输出）"
    );

    // 验证 k 增加了（因为储备金乘积增加了）
    const state = await program.account.poolState.fetch(poolState);
    const newK = BigInt(postVaultA.amount.toString()) * BigInt(postVaultB.amount.toString());
    const kLast = BigInt(state.kLast.toString());
    assert.ok(
      newK > kLast,
      "新的 k 应该大于 k_last（因为手续费导致储备金增加）"
    );
  });

  it("再次添加流动性时，协议费应该被结算", async () => {
    const depositA = 10_000_000; // 10 A
    const depositB = 10_000_000; // 10 B

    const preProtocolFeeAta = await getAccount(provider.connection, protocolFeeRecipientAta);
    const preLpMint = await getMint(provider.connection, lpMint);
    const preVaultA = await getAccount(provider.connection, vaultA);
    const preVaultB = await getAccount(provider.connection, vaultB);
    const preState = await program.account.poolState.fetch(poolState);

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
        protocolFeeRecipient: protocolFeeRecipientAta,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    const postProtocolFeeAta = await getAccount(provider.connection, protocolFeeRecipientAta);
    const postLpMint = await getMint(provider.connection, lpMint);
    const postVaultA = await getAccount(provider.connection, vaultA);
    const postVaultB = await getAccount(provider.connection, vaultB);
    const postState = await program.account.poolState.fetch(poolState);

    // 验证协议费接收者收到了 LP token
    assert.ok(
      postProtocolFeeAta.amount > preProtocolFeeAta.amount,
      "协议费接收者应该收到 LP token"
    );

    // 验证 k_last 已更新为新的储备金乘积
    const newKLast = BigInt(postVaultA.amount.toString()) * BigInt(postVaultB.amount.toString());
    assert.equal(
      postState.kLast.toString(),
      newKLast.toString(),
      "k_last 应该更新为新的储备金乘积"
    );

    console.log(`协议费接收者收到的 LP token: ${postProtocolFeeAta.amount - preProtocolFeeAta.amount}`);
    console.log(`新的 k_last: ${postState.kLast.toString()}`);
  });

  it("移除流动性时，协议费应该被结算", async () => {
    const userLpBefore = await getAccount(provider.connection, userLpAta);
    const amountLpToRemove = userLpBefore.amount / 2n; // 移除一半的 LP

    const preProtocolFeeAta = await getAccount(provider.connection, protocolFeeRecipientAta);
    const preVaultA = await getAccount(provider.connection, vaultA);
    const preVaultB = await getAccount(provider.connection, vaultB);
    const preState = await program.account.poolState.fetch(poolState);

    // 先执行一次 swap 来产生手续费
    await program.methods
      .swap(new anchor.BN(5_000_000), true, new anchor.BN(0))
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

    const vaultAAfterSwap = await getAccount(provider.connection, vaultA);
    const vaultBAfterSwap = await getAccount(provider.connection, vaultB);
    const newK = BigInt(vaultAAfterSwap.amount.toString()) * BigInt(vaultBAfterSwap.amount.toString());
    const kLast = BigInt(preState.kLast.toString());

    // 只有当新的 k > k_last 时才会产生协议费
    if (newK > kLast) {
      const minAmountA = new anchor.BN(0);
      const minAmountB = new anchor.BN(0);

      await program.methods
        .removeLiquidity(
          new anchor.BN(amountLpToRemove.toString()),
          minAmountA,
          minAmountB
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
          protocolFeeRecipient: protocolFeeRecipientAta,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();

      const postProtocolFeeAta = await getAccount(provider.connection, protocolFeeRecipientAta);
      const postState = await program.account.poolState.fetch(poolState);

      // 验证协议费接收者收到了 LP token
      assert.ok(
        postProtocolFeeAta.amount > preProtocolFeeAta.amount,
        "移除流动性时，协议费接收者应该收到 LP token"
      );

      console.log(`移除流动性时协议费接收者收到的 LP token: ${postProtocolFeeAta.amount - preProtocolFeeAta.amount}`);
    } else {
      console.log("新的 k 没有超过 k_last，不会产生协议费");
    }
  });

  it("验证新用户不会白嫖已积累的手续费", async () => {
    // 创建一个新用户
    const newUser = anchor.web3.Keypair.generate();
    
    // 给新用户空投 SOL 用于支付交易费用
    const signature = await provider.connection.requestAirdrop(
      newUser.publicKey,
      2 * anchor.web3.LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(signature);
    
    const newUserTokenA = (
      await getOrCreateAssociatedTokenAccount(provider.connection, user, mintA, newUser.publicKey)
    ).address;
    const newUserTokenB = (
      await getOrCreateAssociatedTokenAccount(provider.connection, user, mintB, newUser.publicKey)
    ).address;
    const newUserLpAta = getAssociatedTokenAddressSync(lpMint, newUser.publicKey);

    // 给新用户 mint 代币
    await mintTo(provider.connection, user, mintA, newUserTokenA, user.publicKey, 50_000_000); // 50 A
    await mintTo(provider.connection, user, mintB, newUserTokenB, user.publicKey, 50_000_000); // 50 B

    // 记录添加流动性前的状态
    const preProtocolFeeAta = await getAccount(provider.connection, protocolFeeRecipientAta);
    const preLpMint = await getMint(provider.connection, lpMint);
    const preVaultA = await getAccount(provider.connection, vaultA);
    const preVaultB = await getAccount(provider.connection, vaultB);

    // 新用户添加流动性
    const depositA = 10_000_000; // 10 A
    const depositB = 10_000_000; // 10 B

    await program.methods
      .addLiquidity(new anchor.BN(depositA), new anchor.BN(depositB))
      .accounts({
        poolState,
        poolAuthority,
        userTokenA: newUserTokenA,
        userTokenB: newUserTokenB,
        tokenAVault: vaultA,
        tokenBVault: vaultB,
        user: newUser.publicKey,
        lpMint,
        userLpTokenATA: newUserLpAta,
        blackHoleLpAta: blackHoleLpAta,
        protocolFeeRecipient: protocolFeeRecipientAta,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([newUser])
      .rpc();

    const postProtocolFeeAta = await getAccount(provider.connection, protocolFeeRecipientAta);
    const postLpMint = await getMint(provider.connection, lpMint);
    const postVaultA = await getAccount(provider.connection, vaultA);
    const postVaultB = await getAccount(provider.connection, vaultB);
    const newUserLp = await getAccount(provider.connection, newUserLpAta);

    // 验证协议费被结算（如果 k > k_last）
    const newK = BigInt(postVaultA.amount.toString()) * BigInt(postVaultB.amount.toString());
    const state = await program.account.poolState.fetch(poolState);
    const kLastBefore = BigInt(state.kLast.toString());

    if (newK > kLastBefore) {
      // 如果有协议费，验证协议费接收者收到了 LP token
      assert.ok(
        postProtocolFeeAta.amount > preProtocolFeeAta.amount,
        "新用户添加流动性时，协议费应该被结算，防止白嫖"
      );
    }

    // 验证新用户获得的 LP token 数量是合理的（基于总供应量计算）
    // 如果协议费被正确结算，新用户不会获得额外的 LP token
    const totalLpSupply = postLpMint.supply;
    const protocolFeeMinted = postProtocolFeeAta.amount - preProtocolFeeAta.amount;
    const expectedLpForNewUser = (BigInt(depositA) * totalLpSupply) / BigInt(preVaultA.amount.toString());
    
    console.log(`新用户获得的 LP token: ${newUserLp.amount}`);
    console.log(`协议费接收者收到的 LP token: ${protocolFeeMinted}`);
    console.log(`总 LP 供应量: ${totalLpSupply}`);
    
    // 验证新用户获得的 LP 不会超过预期（考虑协议费后的总供应量）
    const totalLpAfterProtocolFee = preLpMint.supply + protocolFeeMinted;
    const maxExpectedLp = (BigInt(depositA) * totalLpAfterProtocolFee) / BigInt(preVaultA.amount.toString());
    
    assert.ok(
      newUserLp.amount <= maxExpectedLp,
      "新用户获得的 LP token 不应该超过预期，证明协议费结算防止了白嫖"
    );
  });
});
