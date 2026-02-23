# Solana AMM

一个基于 Solana 区块链的去中心化自动做市商（AMM）协议，实现了恒定乘积公式（$x \cdot y = k$）和 TWAP 价格预言机功能。

## 📋 目录

- [项目介绍](#项目介绍)
- [环境需求](#环境需求)
- [快速开始](#快速开始)
- [功能列表](#功能列表)
- [快速测试](#快速测试)
- [许可证](#许可证)

## 🎯 项目介绍

**Solana AMM** 是一个在 Solana 区块链上实现的去中心化交易协议，采用恒定乘积算法（Constant Product Formula）来提供代币交换服务。项目使用 Anchor 框架开发，实现了完整的 AMM 核心功能，包括流动性管理、代币交换和价格预言机。

### 核心特性

- ✅ **恒定乘积算法**：基于 $x \cdot y = k$ 公式实现代币交换
- ✅ **流动性管理**：支持添加和移除流动性
- ✅ **TWAP 价格预言机**：提供时间加权平均价格（TWAP）功能
- ✅ **PDA 账户模型**：采用 Solana 的 PDA（Program Derived Address）模式
- ✅ **安全设计**：完整的账户验证和权限控制
- ✅ **protocol营收** 效仿 Uniswap V2，通过计算 $\sqrt{k}$ 的增长，在不消耗额外转账 Gas 的情况下实现协议手续费（Protocol Fee）的无感增发结算。
- ✅ **两步骤的治理方案**实现了 `Nominate` & `Claim` 两阶段管理权限转移，杜绝管理员误操作导致合约锁死的风险。

## 🔧 环境需求

### 必需工具

- **Rust**: 稳定版（推荐通过 rustup 安装）
- **Solana CLI**: v3.1.8 或更高版本
- **Anchor**: v0.32.1（通过 avm 管理）
- **Node.js**: v16+ 和 yarn

### 安装步骤

#### 1. 安装 Rust

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source $HOME/.cargo/env
```

#### 2. 安装 Solana CLI

```bash
sh -c "$(curl -sSfL https://release.solana.com/stable/install)"
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
```

#### 3. 安装 Anchor

```bash
# 安装 avm (Anchor Version Manager)
cargo install --git https://github.com/coral-xyz/anchor avm --locked --force

# 安装 Anchor 0.32.1
avm install 0.32.1
avm use 0.32.1
export PATH="$HOME/.avm/bin:$PATH"
```

#### 4. 安装 Node.js 依赖

```bash
yarn install
```

#### 5. 配置 Solana 钱包

```bash
# 生成新钱包（如果还没有）
solana-keygen new

# 配置为本地网络
solana config set --url localhost
```

### 环境变量配置

项目使用 `.envrc` 文件管理环境变量。如果使用 `direnv`，可以自动加载：

```bash
# 安装 direnv（可选）
curl -sfL https://direnv.net/install.sh | bash

# 在 shell 配置文件中添加（如 ~/.bashrc）
eval "$(direnv hook bash)"
```

或者手动设置环境变量：

```bash
export RUSTUP_TOOLCHAIN=stable
export PATH="$HOME/.avm/bin:$PATH"
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
```

## 🚀 快速开始

### 1. 克隆项目

```bash
git clone <repository-url>
cd solana-amm
```

### 2. 安装依赖

```bash
yarn install
```

### 3. 构建程序

```bash
anchor build
```

### 4. 启动本地测试验证器

```bash
# 在一个终端窗口启动本地验证器
solana-test-validator

# 在另一个终端窗口部署程序
anchor deploy
```

### 5. 运行测试

```bash
# 运行所有测试
anchor test

# 或使用 yarn
yarn test
```

## ✨ 功能列表

### 核心指令

#### 1. `initialize` - 初始化池子

创建新的代币交易对池子，设置手续费率。

```rust
pub fn initialize(
    ctx: Context<Initialize>,
    mint_a: Pubkey,
    mint_b: Pubkey,
    fee_numerator: u64,
    fee_denominator: u64,
) -> Result<()>
```

**功能：**
- 创建 Pool State PDA 账户
- 初始化代币金库（Vault A/B）
- 创建 LP Mint（流动性代币）
- 设置手续费率
- 初始化 TWAP 累计价格

#### 2. `swap` - 代币交换

执行代币交换，支持双向交换（A→B 或 B→A）。

```rust
pub fn swap(
    ctx: Context<Swap>,
    amount_in: u64,
    is_a_to_b: bool,
    min_amount_out: u64,
) -> Result<()>
```

**功能：**
- 基于恒定乘积公式计算交换数量
- 滑点保护（最小输出量检查）
- 手续费扣除
- 更新 TWAP 累计价格

#### 3. `add_liquidity` - 添加流动性

向池子添加流动性，获得 LP 代币。

```rust
pub fn add_liquidity(
    ctx: Context<AddLiquidity>,
    amount_a: u64,
    amount_b: u64,
) -> Result<()>
```

**功能：**
- 按比例添加代币 A 和 B
- 铸造 LP 代币给流动性提供者
- 首次添加时按实际比例计算

#### 4. `remove_liquidity` - 移除流动性

从池子移除流动性，销毁 LP 代币并返还代币。

```rust
pub fn remove_liquidity(
    ctx: Context<RemoveLiquidity>,
    amount_lp: u64,
    min_amount_a: u64,
    min_amount_b: u64,
) -> Result<()>
```

**功能：**
- 按比例返还代币 A 和 B
- 销毁 LP 代币
- 滑点保护（最小返还量检查）

### 高级功能

- **TWAP 价格预言机**：提供时间加权平均价格，可用于 DeFi 协议集成
- **黑洞锁定机制**：首次添加流动性时，部分 LP 代币发送到黑洞地址，永久锁定
- **PDA 账户模型**：使用程序派生地址管理池子状态和权限

## 🧪 快速测试

### 运行完整测试套件

```bash
# 使用 Anchor 测试
anchor test

# 或使用 yarn
yarn test
```

### 运行特定测试文件

```bash
# 运行演示测试
yarn run ts-mocha -p ./tsconfig.json -t 20000 "tests/demo.ts"

# 运行 TWAP 测试
yarn run ts-mocha -p ./tsconfig.json -t 20000 "tests/twap.ts"
```

### 测试覆盖的功能

- ✅ 池子初始化
- ✅ 添加流动性
- ✅ 代币交换（双向）
- ✅ 移除流动性
- ✅ TWAP 价格计算
- ✅ 滑点保护
- ✅ 账户验证

### 示例测试输出

测试脚本会展示：
- 池子流动性状态
- 当前现货价格
- TWAP 价格（不同时间窗口）
- 交换前后的价格变化

## 📁 项目结构

```
solana-amm/
├── programs/
│   └── solana-amm/
│       └── src/
│           ├── lib.rs              # 程序入口
│           ├── state.rs            # 账户状态定义
│           ├── errors.rs           # 错误类型定义
│           ├── contexts.rs         # Anchor 账户上下文
│           ├── math.rs             # 数学计算工具
│           └── instructions/       # 指令实现
│               ├── initialize.rs
│               ├── swap.rs
│               ├── add_liquidity.rs
│               └── remove_liquidity.rs
├── tests/                          # TypeScript 测试文件
│   ├── demo.ts                    # 完整功能演示
│   └── twap.ts                    # TWAP 测试
├── Anchor.toml                     # Anchor 配置文件
├── Cargo.toml                      # Rust 工作空间配置
└── package.json                    # Node.js 依赖配置
```

## 🔐 安全特性

- **Mint 排序验证**：强制 `mint_a < mint_b`，防止重复池子
- **账户关联检查**：使用 Anchor 约束确保账户关联正确
- **权限校验**：所有资金操作通过 PDA 签名
- **精度处理**：使用 u128 进行中间计算，防止溢出
- **滑点保护**：交换和移除流动性时检查最小输出量

## 📝 开发说明

### 程序 ID

- **Program ID**: `BBHVgLFdpYmd6SsCXDXqC4FT6NB1f1KXg9C7XmXFTVYS`
- **Cluster**: localnet（开发环境）

### 账户种子

- **Pool State**: `["pool", mint_a, mint_b]`
- **Pool Authority**: `["authority"]`

### 代码规范

- 使用 `cargo fmt` 格式化 Rust 代码
- 使用 `prettier` 格式化 TypeScript 代码
- 运行 `yarn lint` 检查代码格式

## 📚 相关文档

- [产品需求文档](./doc/prd.md)
- [学习笔记](./doc/learning.md)

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

## 📄 许可证

ISC License

---

**注意**：本项目仅用于学习和开发目的。在生产环境使用前，请进行充分的安全审计。
