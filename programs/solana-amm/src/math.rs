// 自定义数学函数模块
// 不使用 PreciseNumber 的原因：PreciseNumber 的计算开销过大，会导致 CU (Compute Units) 溢出
// 使用轻量级的整数运算来替代，减少计算单元消耗

/// 计算 u128 的整数平方根
/// 使用牛顿法（Newton's method）进行迭代计算
/// 
/// # Arguments
/// * `n` - 需要计算平方根的数
/// 
/// # Returns
/// * `Option<u64>` - 平方根结果，如果溢出则返回 None
/// 
/// # Example
/// ```
/// assert_eq!(sqrt_u128(100), Some(10));
/// assert_eq!(sqrt_u128(144), Some(12));
/// ```
pub fn sqrt_u128(n: u128) -> Option<u64> {
    if n == 0 {
        return Some(0);
    }
    
    // 使用牛顿法：x_{n+1} = (x_n + n/x_n) / 2
    // 初始值设为 n/2，但为了避免溢出，使用更安全的初始值
    let mut x = n;
    let mut y = (x + 1) / 2;
    
    // 迭代直到收敛（最多迭代 64 次，因为 u128 最多 128 位）
    while y < x {
        x = y;
        y = (x + n / x) / 2;
    }
    
    // 检查结果是否在 u64 范围内
    if x > u64::MAX as u128 {
        return None;
    }
    
    Some(x as u64)
}

/// 计算两个 u64 的乘积的平方根
/// 用于计算 sqrt(a * b)，避免中间结果溢出
/// 
/// # Arguments
/// * `a` - 第一个数
/// * `b` - 第二个数
/// 
/// # Returns
/// * `Option<u64>` - sqrt(a * b) 的结果，如果溢出则返回 None
pub fn sqrt_product_u64(a: u64, b: u64) -> Option<u64> {
    // 将两个 u64 转换为 u128 进行乘法，避免溢出
    let product = (a as u128).checked_mul(b as u128)?;
    sqrt_u128(product)
}

