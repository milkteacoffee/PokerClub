#!/usr/bin/env bash
# 赌途 · 联机后端一键部署（在阿里云服务器上执行）
#
# 前置：已安装 docker 与 docker compose plugin
# 用法：bash deploy.sh
set -euo pipefail

cd "$(dirname "$0")"

echo "==> 1/4 检查 Docker"
if ! command -v docker >/dev/null 2>&1; then
  echo "!! 未检测到 docker，请先安装：https://docs.docker.com/engine/install/"
  exit 1
fi
docker --version
docker compose version || { echo "!! 缺少 docker compose 插件"; exit 1; }

echo "==> 2/4 准备数据目录"
mkdir -p data
chmod 750 data

echo "==> 3/4 构建镜像"
docker compose build

echo "==> 4/4 启动服务"
docker compose up -d

echo ""
echo "==> 等待健康检查..."
for i in $(seq 1 20); do
  sleep 1
  if curl -fsS http://127.0.0.1:8123/health >/dev/null 2>&1; then
    echo "服务已就绪："
    curl -s http://127.0.0.1:8123/health
    echo ""
    echo ""
    echo "完成。常用命令："
    echo "  查看日志： docker compose logs -f"
    echo "  重启服务： docker compose restart"
    echo "  停止服务： docker compose down"
    echo "  备份数据： cp data/pokerclub.db data/backup-\$(date +%F).db"
    exit 0
  fi
done

echo "!! 健康检查超时，请查看日志： docker compose logs --tail=100"
exit 1
