# Scripts 使用说明

本目录包含 Solana AMM 的**可直接运行**命令行工具，面向 **Devnet**。

## 前置条件

1. **依赖已安装**（项目根目录）：
   ```bash
   yarn install
   ```

2. **程序已构建**（生成 IDL）：
   ```bash
   anchor build
   ```
   会生成 `target/idl/solana_amm.json`，脚本依赖该文件。

3. **Solana 配置**（建议 devnet）：
   ```bash
   solana config set --url devnet
   ```

4. **钱包**：脚本使用以下路径之一作为钱包 keypair：
   - 环境变量 `ANCHOR_WALLET` 指向的 JSON 文件
   - 默认：项目根目录下的 `phantom-keypair.json`

5. **RPC**（可选）：
   - 默认使用 devnet 公网 RPC
   - 可设置 `SOLANA_RPC_URL` 使用自建或付费 RPC

## 运行方式

在**项目根目录**执行（不要进到 `scripts/` 再跑）：

```bash
yarn ts-node scripts/execute.ts <command> [args...]
```

或使用 npx（若已全局/局部安装 ts-node）：

```bash
npx ts-node scripts/execute.ts <command> [args...]
```

## 命令一览

| 命令 | 说明 | 参数 |
|------|------|------|
| `state` | 仅查询池状态 | `<mintA> <mintB>` |
| `initialize` | 初始化交易对池 | `<mintA> <mintB> <feeNum> <feeDenom>` |
| `deposit` | 添加流动性 | `<mintA> <mintB> <amountA> <amountB>` |
| `withdraw` | 移除流动性 | `<mintA> <mintB> <amountLp> <minA> <minB>` |
| `swap` | 交换 | `<mintA> <mintB> <amountIn> <isAtoB> [minAmountOut]` |
| `update_config` | 更新池配置 | `<mintA> <mintB> [newAdmin\|-] [newRecipient\|-] [newShare\|-]` |
| `claim_admin` | 认领 admin（需为 pending_admin） | `<mintA> <mintB>` |
| `examples` | 打印可运行示例命令 | 无 |
| `help` / `-h` / `--help` | 打印用法 | 无 |

- **mintA / mintB**：代币 Mint 地址（Base58）。
- **amount**：按代币最小单位（考虑 decimals，如 6 位小数则 1 token = 1_000_000）。
- **isAtoB**：`true` = 用 A 换 B，`false` = 用 B 换 A。
- **update_config**：不想改的项传 `-`，例如只改协议费比例：`- - 100`。

## 快速示例

```bash
# 创建token
spl-token create-token --decimals 6
spl-token create-token --decimals 6

# 为当前钱包开 ATA
spl-token create-account EBNpMkEhZn3sfX4ctTQFcCp9ahBz7nqMPVJionvZhGLZ
spl-token create-account 5gchhEF8D93wCzhgJidLRYrksjfjeTztxoNB3pwt2mAG

# 并各铸 100 个
spl-token mint EBNpMkEhZn3sfX4ctTQFcCp9ahBz7nqMPVJionvZhGLZ 100000000
spl-token mint  5gchhEF8D93wCzhgJidLRYrksjfjeTztxoNB3pwt2mAG 100000000

export MINT_A="EBNpMkEhZn3sfX4ctTQFcCp9ahBz7nqMPVJionvZhGLZ"
export MINT_B="5gchhEF8D93wCzhgJidLRYrksjfjeTztxoNB3pwt2mAG"

# 查询池状态
yarn ts-node scripts/execute.ts state $MINT_A $MINT_B

# 初始化池（手续费 3/1000）
yarn ts-node scripts/execute.ts initialize $MINT_A $MINT_B 3 1000

# 添加流动性（10 A + 10 B，6 位小数）
yarn ts-node scripts/execute.ts deposit $MINT_A $MINT_B 10000000 10000000

# 交换：1 A -> B，最少收 1 wei
yarn ts-node scripts/execute.ts swap $MINT_A $MINT_B 1000000 true 1

# 移除流动性：销毁 1000 LP，最少收回 1 A、1 B
yarn ts-node scripts/execute.ts withdraw $MINT_A $MINT_B 1000 1 1
```

更多完整示例（含创建代币、ATA、铸造等）可运行：

```bash
yarn ts-node scripts/execute.ts examples
```

## 环境变量汇总

| 变量 | 说明 | 默认 |
|------|------|------|
| `ANCHOR_WALLET` | 钱包 keypair JSON 路径 | `phantom-keypair.json`（相对项目根） |
| `SOLANA_RPC_URL` | RPC 端点 | devnet 公网 |

## 程序信息

- **Program ID（Devnet）**：`3urPFjzfHCS8K37dh2yqvavsQPdmEa5H6pLuv8xWpQXP`
- 交易成功后控制台会打印 Solscan（devnet）链接，便于查看链上交易。

## 常见问题

- **找不到 IDL**：先执行 `anchor build`。
- **Invalid keypair**：检查 `ANCHOR_WALLET` 或 `phantom-keypair.json` 路径与格式。
- **Transaction failed**：确认钱包有足够 SOL 和对应代币余额，且池已初始化（除 `initialize` / `state` / `examples` 外）。
