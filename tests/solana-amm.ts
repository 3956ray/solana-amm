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

describe("solana-amm", () => {
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

  it("初始化池子状态!", async () => {
    // 调用你之前编写的 initialize 指令
    const feeNumerator = new anchor.BN(3);
    const feeDenominator = new anchor.BN(1000);
    
    // 生成 lpMint 的 keypair（Anchor 会自动创建）
    const lpMintKeypair = anchor.web3.Keypair.generate();
    
    await program.methods
      .initialize(mintA, mintB, feeNumerator, feeDenominator)
      .accounts({
        poolState: poolState,
        poolAuthority: poolAuthority,
        tokenA: mintA,
        tokenB: mintB,
        tokenAVault: vaultA,
        tokenBVault: vaultB,
        lpMint: lpMintKeypair.publicKey,
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

  it("执行 A -> B 交换", async () => {
    const amountIn = new anchor.BN(10_000_000); // 10 Token A
    const minAmountOut = new anchor.BN(1);      // 极低滑点要求，确保成功

    const preUserB = await getAccount(provider.connection, userTokenB);

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

    const postUserB = await getAccount(provider.connection, userTokenB);
    assert.ok(Number(postUserB.amount) > Number(preUserB.amount), "用户收到的 Token B 应该增加");
  });

  it("触发滑点保护失败", async () => {
    const amountIn = new anchor.BN(1_000_000);
    // 设置一个不可能达到的高预期，强制触发合约中的滑点校验
    const greedyMinAmountOut = new anchor.BN(5_000_000_000); 

    try {
      await program.methods
        .swap(amountIn, true, greedyMinAmountOut)
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
      assert.fail("滑点保护未生效");
    } catch (err: any) {
      // 这里的字符串校验取决于你自定义错误的消息内容
      assert.include(err.toString(), "SlippageExceeded");
    }
  });
});