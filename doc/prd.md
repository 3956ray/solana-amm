# 产品需求文档 (PRD): Solana Constant Product AMM

## 1. 项目概览

**项目名称：** Sol-AMM
**目标：** 在 Solana 上实现一个基于 $x \cdot y = k$ 算法的去中心化交易对协议。

**核心挑战：** 从 EVM 的"合约存储"模式切换到 SVM 的"账户隔离"模式，并确保资金安全。

## 2. 系统架构 (Technical Architecture)

### 2.1 账户模型设计 (The "Account Map")

这是 Solana 开发的核心。我们将采用 **数据与权限解耦** 的高级架构。

| 账户名称 | 类型 | 种子 (Seeds) | 职责 |
| --------- | ------ | ------------ | ------ |
| Pool State | Data Account | `["pool", mint_a, mint_b]` | 存储池子状态（地址、费率、Bump）。 |
| Pool Authority | PDA (Signer) | `["authority", pool_state]` | 充当金库所有者和 LP 铸造者，不存数据。 |
| Vault A/B | ATAN/A (Associated Token) | - | 实际存储代币 A 和 B 的地方，Owner 为 Pool Authority。 |
| LP Mint | Mint Account | `["lp_mint", pool_state]` | 发行流动性凭证，Mint Authority 为 Pool Authority。 |

### 2.2 核心业务流程

#### Initialize (初始化)

- 输入：Token A Mint, Token B Mint, 初始费率。
- 逻辑：排序 Mint 地址，生成 PDA，创建 State 账户，创建 Vaults 和 LP Mint。

#### Add Liquidity (提供流动性)

- 逻辑：用户存入 A 和 B，程序根据当前比例计算应增发的 LP 代币。

#### Swap (交换)

- 逻辑：基于 $x \cdot y = k$ 公式，扣除 $\Delta x$（入金），计算并转出 $\Delta y$（出金）。

#### Remove Liquidity (撤出流动性)

- 逻辑：用户销毁 LP，程序按比例从 Vaults 返还 A 和 B。

## 3. 功能需求 (Functional Requirements)

### 3.1 核心指令 (Instructions)

**initialize_pool**: 设置池子元数据，初始化 PDA 账户。

**add_liquidity**:

- 输入：amount_a, max_amount_b (或按比例)。
- 产出：Mint LP Token 给用户。

**swap**:

- 输入：amount_in, min_amount_out (滑点保护)。
- 公式：$\Delta y = \frac{y \cdot \Delta x \cdot (1 - fee)}{x + \Delta x \cdot (1 - fee)}$。

**remove_liquidity**:

- 输入：lp_amount。
- 产出：返还对应的代币 A 和 B。

## 4. 非功能需求 & 安全设计 (Non-functional & Security)

### 4.1 安全约束 (Crucial for Junior-to-Senior Transition)

- **排序 Mint 验证**：强制 mint_a < mint_b，防止同一个代币对出现两个池子。
- **账户关联检查**：使用 Anchor 约束（constraint）确保传入的 vault_a 确实属于该 pool_state。
- **权限校验**：所有涉及资金划转的 CPI 必须通过 pool_authority 的 PDA 签名。
- **精度处理**：使用 u128 进行中间运算，遵循"先乘后除"原则，防止精度损失被黑客套利。

### 4.2 数学模型

- 使用 **恒定乘积公式**：$(x + \Delta x) \cdot (y - \Delta y) = k$。
- **手续费**：默认 0.3%（通过 fee_numerator 和 fee_denominator 实现）。

## 5. 开发进度表 (14-Day Sprint)

| 周期 | 任务 | 模块 | 产出物 |
| ------ | ------ | ------ | -------- |
| Q1 | 地基搭建 | - | lib.rs 结构定义、Initialize 指令、单元测试。 |
| Q2 | Swap 核心 | - | swap 指令实现、数学算法工具类、滑点保护检查。 |
| Q3 | 流动性模块 | - | add_liquidity / remove_liquidity 指令。 |
| Q4 | 集成与交付 | - | TS 冒烟测试、AI 辅助 React 前端、转正技术文档。 |

## 6. 成功标准 (Definition of Done)

- **代码层面**：anchor test 覆盖率达到 80% 以上，无账户验证漏洞。
- **交互层面**：前端可连接 Phantom 钱包，完成一笔完整的 Swap。
- **文档层面**：能够解释 PDA 种子设计的原因和安全数学的实现细节。
