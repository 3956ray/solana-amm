/**
 * Solana AMM 全功能命令行工具 (Devnet)
 * Program ID: 3urPFjzfHCS8K37dh2yqvavsQPdmEa5H6pLuv8xWpQXP
 *
 * 用法:
 *   yarn ts-node scripts/execute.ts <command> [args...]
 *
 * 命令:
 *   initialize <mintA> <mintB> <feeNum> <feeDenom>
 *   deposit    <mintA> <mintB> <amountA> <amountB>
 *   withdraw   <mintA> <mintB> <amountLp> <minA> <minB>
 *   swap       <mintA> <mintB> <amountIn> <isAtoB> [minAmountOut]
 *   update_config <mintA> <mintB> [newAdmin|-] [newRecipient|-] [newShare|-]
 *   claim_admin  <mintA> <mintB>
 *   state      <mintA> <mintB>   # 仅查询池状态
 *   examples   # 打印可运行的示例命令
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  Connection,
  clusterApiUrl,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  getAccount,
  getOrCreateAssociatedTokenAccount,
} from "@solana/spl-token";
import * as path from "path";
import * as fs from "fs";

// 从 target 加载 IDL（需先执行 anchor build 生成 target/idl/solana_amm.json）
// eslint-disable-next-line @typescript-eslint/no-var-requires
const idl = require(path.join(__dirname, "../target/idl/solana_amm.json"));

const PROGRAM_ID = new PublicKey("3urPFjzfHCS8K37dh2yqvavsQPdmEa5H6pLuv8xWpQXP");
const DEVNET_RPC = process.env.SOLANA_RPC_URL || clusterApiUrl("devnet");
const BLACK_HOLE_OWNER = new PublicKey("11111111111111111111111111111111");

function loadWalletKeypair(): Keypair {
  const keypairPath =
    process.env.ANCHOR_WALLET ||
    path.join(process.cwd(), "phantom-keypair.json");
  const keypairPathResolved = path.isAbsolute(keypairPath)
    ? keypairPath
    : path.resolve(process.cwd(), keypairPath);
  const keypairData = JSON.parse(
    fs.readFileSync(keypairPathResolved, "utf-8")
  ) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(keypairData));
}

function ensureMintOrder(mintA: PublicKey, mintB: PublicKey): [PublicKey, PublicKey] {
  if (mintA.toBuffer().compare(mintB.toBuffer()) > 0) {
    return [mintB, mintA];
  }
  return [mintA, mintB];
}

function derivePoolPdas(
  programId: PublicKey,
  mintA: PublicKey,
  mintB: PublicKey
): { poolState: PublicKey; poolAuthority: PublicKey } {
  const [ma, mb] = ensureMintOrder(mintA, mintB);
  const [poolState] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool"), ma.toBuffer(), mb.toBuffer()],
    programId
  );
  const [poolAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("authority")],
    programId
  );
  return { poolState, poolAuthority };
}

function solscanTxUrl(signature: string, cluster: string = "devnet"): string {
  return `https://solscan.io/tx/${signature}?cluster=${cluster}`;
}

/** 等待交易被网络确认，便于随后读取新创建的账户 */
async function confirmTx(connection: Connection, signature: string): Promise<void> {
  const start = Date.now();
  const timeout = 60000;
  while (Date.now() - start < timeout) {
    const status = await connection.getSignatureStatus(signature);
    if (status?.value?.confirmationStatus === "confirmed" || status?.value?.confirmationStatus === "finalized") {
      return;
    }
    if (status?.value?.err) {
      throw new Error(`Transaction failed: ${JSON.stringify(status.value.err)}`);
    }
    await new Promise((r) => setTimeout(r, 800));
  }
  throw new Error("Transaction confirmation timeout");
}

async function fetchPoolStateSummary(
  program: Program<anchor.Idl>,
  connection: Connection,
  poolStatePda: PublicKey,
  vaultA: PublicKey,
  vaultB: PublicKey
): Promise<void> {
  try {
    const state = await (program.account as any).poolState.fetch(poolStatePda);
    const accA = await getAccount(connection, vaultA).catch(() => null);
    const accB = await getAccount(connection, vaultB).catch(() => null);
    const reserveA = accA ? accA.amount : BigInt(0);
    const reserveB = accB ? accB.amount : BigInt(0);

    console.log("--- Pool State ---");
    console.log("  admin:", (state as any).admin?.toBase58?.() ?? state.admin);
    console.log(
      "  pending_admin:",
      (state as any).pendingAdmin != null
        ? (state as any).pendingAdmin.toBase58()
        : "null"
    );
    console.log("  k_last:", (state as any).kLast?.toString?.() ?? (state as any).k_last);
    console.log("  reserve_a:", reserveA.toString());
    console.log("  reserve_b:", reserveB.toString());
    console.log("  fee:", (state as any).feeNumerator + "/" + (state as any).feeDenominator);
    console.log("  protocol_fee_share:", (state as any).protocolFeeShare?.toString?.() ?? (state as any).protocol_fee_share);
    console.log("  protocol_fee_recipient:", (state as any).protocolFeeRecipient?.toBase58?.() ?? (state as any).protocol_fee_recipient);
    console.log("---------------");
  } catch (e: any) {
    console.log("(无法读取池状态:", e.message ?? e, ")");
  }
}

function printUsage(): void {
  console.log(`
Solana AMM execute.ts 用法:

  yarn ts-node scripts/execute.ts state <mintA> <mintB>
  yarn ts-node scripts/execute.ts initialize <mintA> <mintB> <feeNum> <feeDenom>
  yarn ts-node scripts/execute.ts deposit <mintA> <mintB> <amountA> <amountB>
  yarn ts-node scripts/execute.ts withdraw <mintA> <mintB> <amountLp> <minA> <minB>
  yarn ts-node scripts/execute.ts swap <mintA> <mintB> <amountIn> <isAtoB> [minAmountOut]
  yarn ts-node scripts/execute.ts update_config <mintA> <mintB> [newAdmin|-] [newRecipient|-] [newShare|-]
  yarn ts-node scripts/execute.ts claim_admin <mintA> <mintB>
  yarn ts-node scripts/execute.ts examples
`);
}

function printRunnableExamples(): void {
  console.log(`
======== 可运行示例 (Devnet) ========

前置：配置 devnet、钱包有 SOL，并已 anchor build

1) 创建两个代币并记下 Mint 地址:
   solana config set --url devnet
   spl-token create-token --decimals 6
   spl-token create-token --decimals 6

2) 为当前钱包创建 ATA 并铸造代币 (将 MINT_A、MINT_B 换成上面输出):
   spl-token create-account <MINT_A>
   spl-token create-account <MINT_B>
   spl-token mint <MINT_A> 100000000
   spl-token mint <MINT_B> 100000000

3) 设置变量后执行 (将下面两行替换为你的 mint 地址):
   export MINT_A="你的TokenA的Mint地址"
   export MINT_B="你的TokenB的Mint地址"

4) 初始化池子 (手续费 3/1000):
   yarn ts-node scripts/execute.ts initialize $MINT_A $MINT_B 3 1000

5) 查询池状态:
   yarn ts-node scripts/execute.ts state $MINT_A $MINT_B

6) 添加流动性 (10 A + 10 B，6 位小数即 10000000):
   yarn ts-node scripts/execute.ts deposit $MINT_A $MINT_B 10000000 10000000

7) 交换 (1 A -> B，最少收 1 wei):
   yarn ts-node scripts/execute.ts swap $MINT_A $MINT_B 1000000 true 1

8) 仅更新协议费比例为 100 (不改 admin/recipient 用 -):
   yarn ts-node scripts/execute.ts update_config $MINT_A $MINT_B - - 100

9) 移除流动性 (销毁 1000 LP，最少收回 1 A、1 B):
   yarn ts-node scripts/execute.ts withdraw $MINT_A $MINT_B 1000 1 1

10) 认领 admin (当前钱包需已是 pending_admin):
    yarn ts-node scripts/execute.ts claim_admin $MINT_A $MINT_B

====================================
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0]?.toLowerCase();

  if (!command || command === "help" || command === "-h" || command === "--help") {
    printUsage();
    process.exit(0);
  }

  if (command === "examples") {
    printRunnableExamples();
    process.exit(0);
  }

  const wallet = loadWalletKeypair();
  const connection = new Connection(DEVNET_RPC);
  const provider = new anchor.AnchorProvider(
    connection,
    new anchor.Wallet(wallet),
    { commitment: "confirmed", preflightCommitment: "confirmed" }
  );
  anchor.setProvider(provider);

  const programId = PROGRAM_ID;
  const program = new Program(
    { ...idl, address: programId.toBase58() } as anchor.Idl,
    provider
  ) as Program<anchor.Idl>;

  const parsePubkey = (s: string): PublicKey => {
    if (s.length >= 32 && s.length <= 44) return new PublicKey(s);
    throw new Error("无效的 Pubkey: " + s);
  };

  const parseNum = (s: string): anchor.BN => new anchor.BN(s, 10);

  try {
    if (command === "state") {
      const [mintA, mintB] = [parsePubkey(args[1]), parsePubkey(args[2])];
      if (!mintA || !mintB) {
        console.error("state 需要 mintA mintB");
        process.exit(1);
      }
      const [ma, mb] = ensureMintOrder(mintA, mintB);
      const { poolState, poolAuthority } = derivePoolPdas(programId, ma, mb);
      const vaultA = getAssociatedTokenAddressSync(ma, poolAuthority, true);
      const vaultB = getAssociatedTokenAddressSync(mb, poolAuthority, true);
      await fetchPoolStateSummary(program, connection, poolState, vaultA, vaultB);
      return;
    }

    if (command === "initialize") {
      const mintA = parsePubkey(args[1]);
      const mintB = parsePubkey(args[2]);
      const feeNum = parseNum(args[3]);
      const feeDenom = parseNum(args[4]);
      if (!mintA || !mintB || !args[3] || !args[4]) {
        console.error("initialize 需要 mintA mintB feeNum feeDenom");
        process.exit(1);
      }
      const [ma, mb] = ensureMintOrder(mintA, mintB);
      const { poolState, poolAuthority } = derivePoolPdas(programId, ma, mb);
      const vaultA = getAssociatedTokenAddressSync(ma, poolAuthority, true);
      const vaultB = getAssociatedTokenAddressSync(mb, poolAuthority, true);

      const lpMintKeypair = Keypair.generate();
      console.log("执行前池不存在，跳过 state 打印");
      const sig = await program.methods
        .initialize(ma, mb, feeNum, feeDenom)
        .accounts({
          poolState,
          poolAuthority,
          tokenA: ma,
          tokenB: mb,
          tokenAVault: vaultA,
          tokenBVault: vaultB,
          lpMint: lpMintKeypair.publicKey,
          admin: wallet.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        })
        .signers([lpMintKeypair])
        .rpc();

      console.log("Tx:", sig);
      console.log("Solscan (devnet):", solscanTxUrl(sig, "devnet"));
      await confirmTx(connection, sig);
      for (let i = 0; i < 3; i++) {
        const info = await connection.getAccountInfo(poolState);
        if (info) {
          await fetchPoolStateSummary(program, connection, poolState, vaultA, vaultB);
          break;
        }
        if (i < 2) {
          console.log("(RPC 尚未同步池账户，2s 后重试...)");
          await new Promise((r) => setTimeout(r, 2000));
        } else {
          await fetchPoolStateSummary(program, connection, poolState, vaultA, vaultB);
        }
      }
      return;
    }

    // 以下命令均需要已存在的池：先解析 mint 并派生 PDA
    const mintA = parsePubkey(args[1]);
    const mintB = parsePubkey(args[2]);
    const [ma, mb] = ensureMintOrder(mintA, mintB);
    const { poolState, poolAuthority } = derivePoolPdas(programId, ma, mb);
    const vaultA = getAssociatedTokenAddressSync(ma, poolAuthority, true);
    const vaultB = getAssociatedTokenAddressSync(mb, poolAuthority, true);
    const poolStateAccount = await (program.account as any).poolState.fetch(poolState);
    const lpMint = (poolStateAccount as any).lpMint ?? (poolStateAccount as any).lp_mint;

    if (command === "deposit") {
      const amountA = parseNum(args[3]);
      const amountB = parseNum(args[4]);
      if (!args[3] || !args[4]) {
        console.error("deposit 需要 mintA mintB amountA amountB");
        process.exit(1);
      }
      const userTokenA = getAssociatedTokenAddressSync(ma, wallet.publicKey);
      const userTokenB = getAssociatedTokenAddressSync(mb, wallet.publicKey);
      const userLpAta = getAssociatedTokenAddressSync(lpMint, wallet.publicKey);
      const protocolFeeRecipient = (poolStateAccount as any).protocolFeeRecipient ?? (poolStateAccount as any).protocol_fee_recipient;
      const protocolFeeRecipientAtaAccount = await getOrCreateAssociatedTokenAccount(
        connection,
        wallet,
        lpMint,
        protocolFeeRecipient,
        true
      );
      const protocolFeeRecipientAta = protocolFeeRecipientAtaAccount.address;
      const blackHoleLpAtaAccount = await getOrCreateAssociatedTokenAccount(
        connection,
        wallet,
        lpMint,
        BLACK_HOLE_OWNER,
        true
      );
      const blackHoleLpAta = blackHoleLpAtaAccount.address;

      console.log("--- 执行前 ---");
      await fetchPoolStateSummary(program, connection, poolState, vaultA, vaultB);

      const sig = await program.methods
        .addLiquidity(amountA, amountB)
        .accounts({
          poolState,
          poolAuthority,
          userTokenA,
          userTokenB,
          tokenAVault: vaultA,
          tokenBVault: vaultB,
          user: wallet.publicKey,
          lpMint,
          userLpTokenATA: userLpAta,
          blackHoleLpAta,
          protocolFeeRecipient: protocolFeeRecipientAta,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();

      console.log("Tx:", sig);
      console.log("Solscan (devnet):", solscanTxUrl(sig, "devnet"));
      console.log("--- 执行后 ---");
      await fetchPoolStateSummary(program, connection, poolState, vaultA, vaultB);
      return;
    }

    if (command === "withdraw") {
      const amountLp = parseNum(args[3]);
      const minA = parseNum(args[4]);
      const minB = parseNum(args[5]);
      if (!args[3] || !args[4] || !args[5]) {
        console.error("withdraw 需要 mintA mintB amountLp minA minB");
        process.exit(1);
      }
      const userTokenA = getAssociatedTokenAddressSync(ma, wallet.publicKey);
      const userTokenB = getAssociatedTokenAddressSync(mb, wallet.publicKey);
      const userLpAta = getAssociatedTokenAddressSync(lpMint, wallet.publicKey);
      const protocolFeeRecipient = (poolStateAccount as any).protocolFeeRecipient ?? (poolStateAccount as any).protocol_fee_recipient;
      const protocolFeeRecipientAtaAccount = await getOrCreateAssociatedTokenAccount(
        connection,
        wallet,
        lpMint,
        protocolFeeRecipient,
        true
      );
      const protocolFeeRecipientAta = protocolFeeRecipientAtaAccount.address;

      console.log("--- 执行前 ---");
      await fetchPoolStateSummary(program, connection, poolState, vaultA, vaultB);

      const sig = await program.methods
        .removeLiquidity(amountLp, minA, minB)
        .accounts({
          poolState,
          poolAuthority,
          userTokenA,
          userTokenB,
          tokenAVault: vaultA,
          tokenBVault: vaultB,
          user: wallet.publicKey,
          lpMint,
          userLpTokenATA: userLpAta,
          protocolFeeRecipient: protocolFeeRecipientAta,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();

      console.log("Tx:", sig);
      console.log("Solscan (devnet):", solscanTxUrl(sig, "devnet"));
      console.log("--- 执行后 ---");
      await fetchPoolStateSummary(program, connection, poolState, vaultA, vaultB);
      return;
    }

    if (command === "swap") {
      const amountIn = parseNum(args[3]);
      const isAtoB = args[4] === "true" || args[4] === "1";
      const minAmountOut = args[5] != null ? parseNum(args[5]) : new anchor.BN(1);
      if (!args[3] || !args[4]) {
        console.error("swap 需要 mintA mintB amountIn isAtoB [minAmountOut]");
        process.exit(1);
      }
      const userTokenA = getAssociatedTokenAddressSync(ma, wallet.publicKey);
      const userTokenB = getAssociatedTokenAddressSync(mb, wallet.publicKey);

      console.log("--- 执行前 ---");
      await fetchPoolStateSummary(program, connection, poolState, vaultA, vaultB);

      const sig = await program.methods
        .swap(amountIn, isAtoB, minAmountOut)
        .accounts({
          poolState,
          userTokenA,
          userTokenB,
          tokenAVault: vaultA,
          tokenBVault: vaultB,
          user: wallet.publicKey,
          poolAuthority,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();

      console.log("Tx:", sig);
      console.log("Solscan (devnet):", solscanTxUrl(sig, "devnet"));
      console.log("--- 执行后 ---");
      await fetchPoolStateSummary(program, connection, poolState, vaultA, vaultB);
      return;
    }

    if (command === "update_config") {
      const newAdminRaw = args[3];
      const newRecipientRaw = args[4];
      const newShareRaw = args[5];
      const newAdmin =
        newAdminRaw == null || newAdminRaw === "-"
          ? null
          : parsePubkey(newAdminRaw);
      const newRecipient =
        newRecipientRaw == null || newRecipientRaw === "-"
          ? null
          : parsePubkey(newRecipientRaw);
      const newShare =
        newShareRaw == null || newShareRaw === "-"
          ? null
          : parseNum(newShareRaw);

      console.log("--- 执行前 ---");
      await fetchPoolStateSummary(program, connection, poolState, vaultA, vaultB);

      const sig = await program.methods
        .updateConfig(newAdmin, newRecipient, newShare)
        .accounts({
          poolState,
          admin: wallet.publicKey,
        })
        .rpc();

      console.log("Tx:", sig);
      console.log("Solscan (devnet):", solscanTxUrl(sig, "devnet"));
      console.log("--- 执行后 ---");
      await fetchPoolStateSummary(program, connection, poolState, vaultA, vaultB);
      return;
    }

    if (command === "claim_admin") {
      console.log("--- 执行前 ---");
      await fetchPoolStateSummary(program, connection, poolState, vaultA, vaultB);

      const sig = await program.methods
        .claimAdmin()
        .accounts({
          poolState,
          pendingAdmin: wallet.publicKey,
        })
        .rpc();

      console.log("Tx:", sig);
      console.log("Solscan (devnet):", solscanTxUrl(sig, "devnet"));
      console.log("--- 执行后 ---");
      await fetchPoolStateSummary(program, connection, poolState, vaultA, vaultB);
      return;
    }

    console.error("未知命令:", command);
    printUsage();
    process.exit(1);
  } catch (e: any) {
    const logs = e.logs ?? (Array.isArray(e) ? e : []);
    const logStr = Array.isArray(logs) ? logs.join(" ") : String(logs);
    const msg =
      e.message ??
      e.error?.errorMessage ??
      (e.error && typeof e.error === "object" ? JSON.stringify(e.error) : null) ??
      (e.toString && e.toString() !== "[object Object]" ? e.toString() : null) ??
      String(e);

    if (command === "initialize" && (logStr.includes("already in use") || msg.includes("already in use"))) {
      console.error("错误: 该池子已存在，无需再次 initialize。");
      console.error("请使用: yarn ts-node scripts/execute.ts state $MINT_A $MINT_B");
      console.error("然后可执行: yarn ts-node scripts/execute.ts deposit $MINT_A $MINT_B <amountA> <amountB>");
      process.exit(1);
    }

    console.error("错误:", msg || "(无详细信息)");
    if (e.logs) console.error("Logs:", e.logs);
    if ((!msg || msg === "(无详细信息)") && e.stack) console.error(e.stack);
    process.exit(1);
  }
}

main();
