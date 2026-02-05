#!/usr/bin/env bash
set -e

# Solana + Anchor 一键安装脚本
# 严格按照终端历史中的有效命令顺序执行

echo "[install] 更新 apt 包列表..."
sudo apt-get update

echo "[install] 安装系统依赖..."
sudo apt-get install -y \
    build-essential \
    pkg-config \
    libudev-dev \
    llvm \
    libclang-dev \
    protobuf-compiler \
    libssl-dev

echo "[install] 安装 Rust..."
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y

echo "[install] 加载 Rust 环境..."
. "$HOME/.cargo/env"

echo "[install] 安装 Solana CLI..."
sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"

echo "[install] 配置 Solana PATH..."
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
echo 'export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"' >> ~/.bashrc

echo "[install] 重新加载 bashrc..."
source ~/.bashrc

echo "[install] 验证 Solana 安装..."
solana --version

echo "[install] 安装 Node.js v20..."
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

echo "[install] 安装 Yarn..."
sudo npm install -g yarn

echo "[install] 安装 Anchor Version Manager (avm)..."
cargo install --git https://github.com/coral-xyz/anchor avm --locked --force

echo "[install] 通过 avm 安装 Anchor (latest)..."
avm install latest
avm use latest

echo "[install] 验证安装..."
echo "Rust: $(rustc --version)"
echo "Solana: $(solana --version)"
echo "Node: $(node --version)"
echo "Yarn: $(yarn --version)"
echo "Anchor: $(anchor --version)"

echo "[install] 下载 Surfpool..."
sudo wget http://txtx-public.s3.amazonaws.com/releases/surfpool-linux-x64.tar.gz

echo "[install] 解压 Surfpool..."
sudo tar -xzf surfpool-linux-x64.tar.gz

echo "[install] 安装 Surfpool..."
sudo chmod +x surfpool
sudo mv surfpool /usr/local/bin/

echo "[install] 清理下载文件..."
sudo rm -rf surfpool-linux-x64.tar.gz

echo "[install] 全部完成！"
