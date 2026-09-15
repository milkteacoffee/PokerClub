# 赌途 · 后端部署手册（阿里云 8.217.167.249）

## 一、现状总览

后端与 `modelghost.cn` / `dreamgamebuild.com` 官网**共存于同一台服务器**，不新增端口，复用已有的 Nginx 与 HTTPS 证书。

```
公网 https://modelghost.cn/_poker/*   ← 前端（GitHub Pages）访问这里
        │
        ▼
   edge-nginx (容器，独占 80/443，唯一入口)
        │  modelghost-platform_mgnet 网络
        ▼
   pokerclub-server:8123  ← 赌途联机 + 排行后端（容器，仅内网暴露）
        │
        ▼
   /opt/pokerclub/data/pokerclub.db  ← SQLite 持久化（挂载卷）
```

| 项 | 值 |
|---|---|
| 服务器 | `8.217.167.249`（阿里云 Alibaba Cloud Linux 3，2 核 1.8G） |
| 部署目录 | `/opt/pokerclub` |
| 容器名 | `pokerclub-server` |
| 内网地址 | `http://pokerclub-server:8123`（同 mgnet 网络内） |
| 本机回环 | `127.0.0.1:8123`（方便调试，不对外） |
| 对外前缀 | `https://modelghost.cn/_poker` |
| 数据文件 | `/opt/pokerclub/data/pokerclub.db` |
| 凭据 | `root` + `~/.ssh/id_ed25519`（ed25519，免密） |

## 二、路由约定

前端的 `ONLINE_SERVER` 指向 `https://modelghost.cn/_poker`，后端把前缀去掉后转发：

| 前端请求 | 反代到 | 用途 |
|---|---|---|
| `GET  /_poker/health` | `/health` | 健康检查 |
| `GET  /_poker/api/info` | `/api/info` | 服务信息（游戏列表） |
| `POST /_poker/api/player` | `/api/player` | 注册/更新玩家 |
| `POST /_poker/api/rank` | `/api/rank` | 上报段位分 |
| `GET  /_poker/api/leaderboard?game=&scope=&limit=` | `/api/leaderboard` | 榜单（`scope=global\|friends`） |
| `*    /_poker/api/friends*` | `/api/friends*` | 好友增删查 + accept |
| `WS   /_poker/ws?deviceId=&nickname=` | `/ws` | 联机对局（wss） |

> REST 认证走 **HTTP 头 `x-device-id`**（不是 query 参数）；WS 走 query。

## 三、日常运维

### 3.1 连服务器

本地已配置 SSH 别名（含代理隧道），直接：

```bash
ssh -F ~/.ssh/config.d_tmp pcserver
```

该别名定义（若丢失，按此重建，`<端口>` 取 `echo $http_proxy` 的值）：

```
Host pcserver
  HostName 8.217.167.249
  User root
  IdentityFile C:/Users/27348/.ssh/id_ed25519
  ProxyCommand /c/MyFiles/Development/Git/mingw64/bin/connect.exe -H 127.0.0.1:<端口> %h %p
  StrictHostKeyChecking accept-new
  ServerAliveInterval 30
```

### 3.2 查看状态与日志

```bash
cd /opt/pokerclub
docker compose ps                      # 容器状态（含 health）
docker logs -f pokerclub-server        # 实时日志（Ctrl+C 退出）
docker logs --tail 100 pokerclub-server
curl -s http://127.0.0.1:8123/health   # 本机健康检查
```

### 3.3 重启 / 停止

```bash
cd /opt/pokerclub
docker compose restart                 # 重启（数据不丢）
docker compose down                    # 停止并删除容器（数据卷保留）
docker compose up -d                   # 启动
```

### 3.4 更新后端代码

本地改完 `server/` 后，打包上传并重建：

```bash
# 本机（Git Bash，需先补 PATH）
cd /d/Projects/dezhou/server
tar czf /tmp/ps.tar.gz --exclude='./node_modules' --exclude='./data' \
  --exclude='./tests/tmp' --exclude='./deploy_tmp' .

ssh -F ~/.ssh/config.d_tmp pcserver "cd /opt/pokerclub && tar xzf -" < /tmp/ps.tar.gz
ssh -F ~/.ssh/config.d_tmp pcserver "cd /opt/pokerclub && docker compose up -d --build"
```

### 3.5 备份数据

```bash
ssh -F ~/.ssh/config.d_tmp pcserver \
  "cp /opt/pokerclub/data/pokerclub.db /opt/pokerclub/data/pokerclub.db.\$(date +%F)"
```

## 四、Nginx 配置变更（重要）

棋牌的路由片段挂在 **`/opt/modelghost-platform/nginx/edge.conf`** 的 `modelghost.cn` / `listen 443 ssl` 块里。

### 改配置的铁律

```bash
# 1) 改文件
vi /opt/modelghost-platform/nginx/edge.conf

# 2) 必须先在容器内验证语法
docker exec edge-nginx nginx -t

# 3) 语法通过才重载
docker exec edge-nginx nginx -s reload
```

### 自动注入（幂等）

```bash
python3 /opt/pokerclub/deploy/inject-edge.py
```

该脚本会：备份首次版本到 `edge.conf.bak-poker` → 用状态机解析所有 server 块 →
**只锁定「含 `listen 443` 且 server_name 为 modelghost.cn」的那一块** → 在块尾插入片段。
检测到已注入则跳过。

> 坑：80 端口那个「HTTP→HTTPS 跳转」的 server_name 里**也含 modelghost.cn**，
> 早期用简单文本匹配会误注入到跳转块里。必须整块判定，脚本已修正。

### 回滚

```bash
cp /opt/modelghost-platform/nginx/edge.conf.bak-poker \
   /opt/modelghost-platform/nginx/edge.conf
docker exec edge-nginx nginx -t && docker exec edge-nginx nginx -s reload
```

## 五、验证清单

```bash
# 公网健康检查（本机执行）
curl -s https://modelghost.cn/_poker/health

# 服务信息
curl -s https://modelghost.cn/_poker/api/info

# 全服榜（免身份）
curl -s 'https://modelghost.cn/_poker/api/leaderboard?game=holdem&scope=global&limit=5'

# 好友榜（需身份）
curl -s -H 'x-device-id: your_device_id_here' \
  'https://modelghost.cn/_poker/api/leaderboard?game=guandan&scope=friends'

# 公网 WebSocket 双端联机（本机执行，11 项验证）
cd /d/Projects/dezhou/server
NODE_PATH='C:/Users/27348/.workbuddy/binaries/node/workspace/node_modules' \
  'C:/Users/27348/.workbuddy/binaries/node/versions/22.22.2-3/node.exe' tests/wss-public.js
```

## 六、横向影响评估

| 项目 | 是否受影响 |
|---|---|
| `modelghost.cn` 官网首页 | 否（`location /` 未动） |
| `modelghost.cn/api/`（mg-api） | 否（前缀 `/_poker/` 不与之冲突） |
| `dreamgamebuild.com` / `.cn` | 否（不同 server 块） |
| 端口占用 | 否（棋牌容器不映射宿主机端口） |
| 内存 | 新增约 **62MB**（容器 256MB 上限），余量 1.4G |
| 磁盘 | 新增约 200MB（镜像）+ SQLite 增长 |

## 七、安全要点

- 棋牌容器**只暴露在 mgnet 内网** + `127.0.0.1:8123`，公网无法直连 8123。
- 全部流量经 edge-nginx，HTTPS 证书由 `modelghost.cn` 提供，无自签警告。
- 服务端权威：手牌/牌堆只在服务端，客户端仅收到自己底牌，对手恒为 `??`。
- 限流：单连接 120 条/10 秒；建房 10 次/分；加入 30 次/分。
- 设备 ID 校验：长度 8–64，字符集 `[A-Za-z0-9_-]`。
