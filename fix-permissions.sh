#!/bin/bash
# 修复项目文件权限的脚本
# 将项目所有权改为 raywork:raywork

echo "正在修复项目文件权限..."
sudo chown -R raywork:raywork /home/raywork/orderly/solana-learning/solana-amm

if [ $? -eq 0 ]; then
    echo "✓ 权限修复成功！"
    echo "现在可以正常编辑和保存文件了。"
    ls -la /home/raywork/orderly/solana-learning/solana-amm/programs/solana-amm/src/math.rs
else
    echo "✗ 权限修复失败，请检查 sudo 权限"
fi
