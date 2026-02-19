// 自定义数学函数模块
// 不使用 PreciseNumber 的原因：PreciseNumber 的计算开销过大，会导致 CU (Compute Units) 溢出
// 使用轻量级的整数运算来替代，减少计算单元消耗
use crate::state::PoolState;

// 计算 u128 的整数平方根
// 使用牛顿法（Newton's method）进行迭代计算
// 
// # Arguments
// * `n` - 需要计算平方根的数
// 
// # Returns
// * Option<u64> - 平方根结果，如果溢出则返回 None
// 
// # Example
// ```
// assert_eq!(sqrt_u128(100), Some(10));
// assert_eq!(sqrt_u128(144), Some(12));
// ```
pub fn sqrt_u128(n: u128) -> Option<u64> {
    if n == 0 {
        return Some(0);
    }
    
    // 牛顿法：x_{n+1} = (x_n + n/x_n) / 2
    // 初始值设为 n/2
    let mut x = n;
    let mut y = x.checked_add(1)?.checked_div(2)?;
    
    // 迭代到收敛为止（最多迭代 64 次，因为 u128 最多 128 位）
    while y < x {
        x = y;
        let n_div_x = n.checked_div(x)?;
        y = x.checked_add(n_div_x)?.checked_div(2)?;
    }
    
    // 检查结果是否在 u64 范围内
    if x > u64::MAX as u128 {
        return None;
    }
    
    Some(x as u64)
}

// 计算两个 u64 的乘积的平方根
// 用于计算 sqrt(a * b)，避免中间结果溢出
// 
// # Arguments
// * `a` - 第一个数
// * `b` - 第二个数
// 
// # Returns
// * `Option<u64>` - sqrt(a * b) 的结果，如果溢出则返回 None
pub fn sqrt_product_u64(a: u64, b: u64) -> Option<u64> {
    // 将两个 u64 转换为 u128 进行乘法，避免溢出
    let product = (a as u128).checked_mul(b as u128)?;
    sqrt_u128(product)
}





// 更新 TWAP 价格累积
// 
// # Arguments
// * `reserve_a` - 池子里的Token A 的数量
// * `reserve_b` - 池子里的Token B 的数量
// * `current_timestamp` - 当前时间戳
// 
// # Returns
// * `None` - 如果时间戳小于上次更新时间戳

pub fn update_twap(
    pool_state: &mut PoolState, 
    reserve_a: u64, 
    reserve_b: u64, 
    current_timestamp: u64
) {
    // 1. 计算时间差
    let time_elapsed = current_timestamp.checked_sub(pool_state.block_timestamp_last).unwrap_or(0);

    // 2. 只有时间有变化、池子有流动性时才更新累加器
    if time_elapsed > 0 && reserve_a != 0 && reserve_b != 0 {
        // 计算当前价格：P = (ReserveB << 64) / ReserveA
        // 这里的 Q64.64 定点数能提供极高的精度
        let price_a_fixed = (reserve_b as u128)
            .checked_shl(64).unwrap()
            .checked_div(reserve_a as u128).unwrap();
        
        let price_b_fixed = (reserve_a as u128)
            .checked_shl(64).unwrap()
            .checked_div(reserve_b as u128).unwrap();

        // 核心公式：cumulative += price * delta_time
        pool_state.price_a_cumulative_last = pool_state.price_a_cumulative_last
            .checked_add(price_a_fixed.checked_mul(time_elapsed as u128).unwrap()).unwrap();
            
        pool_state.price_b_cumulative_last = pool_state.price_b_cumulative_last
            .checked_add(price_b_fixed.checked_mul(time_elapsed as u128).unwrap()).unwrap();
    }

    // 3. 无论是否更新累加器，都要更新最后的时间戳
    pool_state.block_timestamp_last = current_timestamp;
}