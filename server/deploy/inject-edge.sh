#!/bin/bash
# 把棋牌后端的 location 片段注入 edge-nginx 的 modelghost.cn server 块
# 幂等：已注入则跳过
set -e

CONF=/opt/modelghost-platform/nginx/edge.conf
SNIP=/opt/pokerclub/deploy/edge-poker-snippet.conf
MARK='# ===== 牌友小馆（PokerClub）棋牌后端'
# 兼容旧标记：品牌改名（赌途 → 牌友小馆）之前已在服务器注入过旧 MARK，
# 这里同时识别旧标记，避免误判为「未注入」而重复插入 location 块。
MARK_OLD='# ===== 赌途（PokerClub）棋牌后端'

echo "=== 1. 备份 ==="
if [ ! -f "${CONF}.bak-poker" ]; then
  cp "$CONF" "${CONF}.bak-poker"
  echo "已备份到 ${CONF}.bak-poker"
else
  echo "备份已存在，跳过（保留首次备份）"
fi

echo ""
echo "=== 2. 幂等检查 ==="
if grep -qF "$MARK" "$CONF" || grep -qF "$MARK_OLD" "$CONF"; then
  echo "已注入过，跳过"
  exit 0
fi

echo ""
echo "=== 3. 定位注入点 ==="
# 注入到 modelghost.cn 的 server 块内、第一个 location /api/ 的闭合大括号之后。
# 做法：找到 modelghost.cn server 块中 `proxy_read_timeout 60s;` 后面紧跟的 `}` 行，
# 在该行后插入片段。用 awk 精确处理。
awk -v snip="$SNIP" '
  BEGIN { ins=0; done=0 }
  # 进入带 modelghost.cn 的主站 server 块
  /server_name modelghost\.cn www\.modelghost\.cn;/ { inblock=1 }
  {
    print
    # 主站块内第一次出现 proxy_read_timeout 60s; 的紧随闭括号处插入
    if (inblock && !done && $0 ~ /proxy_read_timeout 60s;/) { found=1; next }
    if (found && !done) {
      if ($0 ~ /^[[:space:]]*\}[[:space:]]*$/) {
        while ((getline line < snip) > 0) print line
        close(snip)
        print ""
        done=1
        found=0
      }
    }
  }
' "$CONF" > /tmp/edge.conf.new

echo "生成新配置：$(wc -l < /tmp/edge.conf.new) 行（原 $(wc -l < "$CONF") 行）"

echo ""
echo "=== 4. 校验注入结果 ==="
if grep -qF "$MARK" /tmp/edge.conf.new; then
  echo "✓ 片段已注入"
else
  echo "✗ 注入失败，放弃"
  exit 1
fi

echo ""
echo "=== 5. 替换并测试 ==="
cp /tmp/edge.conf.new "$CONF"
docker exec edge-nginx nginx -t
