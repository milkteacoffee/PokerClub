# 赌途 · 联机与排行后端部署手册

> 前端继续托管在 GitHub Pages；本目录只是**新增**的后端服务，部署到已有阿里云服务器上。
> 承载能力：几十到几百人同时在线（内存占用 < 150MB，带宽主要是 WebSocket 小包，几乎可忽略）。

---

## 一、部署前必须准备的三件事

| # | 项目 | 说明 |
|---|------|------|
| 1 | **服务器 SSH 可达** | 你给的是私有 IP `172.17.30.57`，从外网连不上。请在阿里云控制台**绑定弹性公网 IP（EIP）**，或告诉我公网地址 / 跳板机。 |
| 2 | **一个域名（推荐）** | 例如 `api.你的域名`。GitHub Pages 是 HTTPS，后端必须也是 HTTPS，否则浏览器会拦混合内容。 |
| 3 | **开放端口** | 阿里云**安全组**放行 `80`、`443`（不要放 8123，它只绑回环）。 |

---

## 二、五分钟部署（Docker Compose）

### 1. 把 server 目录传到服务器

在**你本地**（`D:\Projects\dezhou`）执行：

```bash
# 方式 A：用仓库（推荐，后续好更新）
#   先确保 GitHub 仓库包含 server/ 目录，然后在服务器上：
git clone git@github.com:milkteacoffee/PokerClub.git
cd PokerClub/server

# 方式 B：直接 scp 上传（替换成你的公网地址）
scp -r ./server root@<公网IP>:/opt/pokerclub-server
```

### 2. 服务器上安装 Docker（若还没装）

```bash
curl -fsSL https://get.docker.com | sh
systemctl enable --now docker
```

> 阿里云 CentOS/Alibaba Cloud Linux 也可用 `yum install -y docker` + 手动装 compose 插件。

### 3. 一键启动

```bash
cd /opt/pokerclub-server
bash deploy.sh
```

看到下面这样的输出就成功了：

```json
{"ok":true,"name":"pokerclub-server","version":"1.0.0","rooms":0,"players":0,"uptime":3}
```

### 4. 配置 Nginx 反代 + HTTPS

```bash
# 放配置（记得先改里面的 server_name 为你的域名）
sudo cp deploy/nginx-pokerclub.conf /etc/nginx/conf.d/pokerclub-server.conf
sudo sed -i 's/api.example.com/api.你的域名/g' /etc/nginx/conf.d/pokerclub-server.conf

sudo nginx -t && sudo systemctl reload nginx

# 申请证书（会自动改写上面的 ssl_certificate 两行）
sudo apt install -y certbot python3-certbot-nginx    # 或 yum
sudo certbot --nginx -d api.你的域名
```

> **关键点**：Nginx 配置里的 `proxy_set_header Upgrade` / `Connection` 与 `proxy_buffering off` 是 WebSocket 能通的必要条件，已在配置文件中写好，勿删。

### 5. 验证

```bash
curl https://api.你的域名/health
# 期望：{"ok":true,...}

curl "https://api.你的域名/api/leaderboard?game=holdem&scope=global&limit=5"
# 期望：{"ok":true,"list":[...]}
```

---

## 三、前端对接（改一行即可）

前端默认连 `http://127.0.0.1:8123`。上线前把 `index.html` 里这行改掉：

```js
// 在 index.html 搜 POKERCLUB_SERVER
window.POKERCLUB_SERVER = 'https://api.你的域名';
```

> 也可以不改代码：在 GitHub Pages 的页面里于 `<head>` 之前先注入
> `<script>window.POKERCLUB_SERVER='https://api.你的域名';</script>`。
> 但直接改 `index.html` 最省事。

**跨域**：`docker-compose.yml` 里 `ALLOW_ORIGIN: "*"` 已放开。若想收紧，改成：

```yaml
ALLOW_ORIGIN: "https://milkteacoffee.github.io"
```

改完 `docker compose up -d` 生效。

---

## 四、日常运维

| 操作 | 命令 |
|------|------|
| 查看日志 | `docker compose logs -f --tail=100` |
| 重启 | `docker compose restart` |
| 更新代码后重建 | `git pull && docker compose up -d --build` |
| 停止 | `docker compose down` |
| 备份数据库 | `cp data/pokerclub.db data/backup-$(date +%F).db` |
| 看资源占用 | `docker stats pokerclub-server` |

**数据文件**：`server/data/pokerclub.db`（SQLite，WAL 模式）。这是**唯一**需要备份的东西。

---

## 五、容量参考（按你「人不多」的定位）

| 指标 | 数十人在线 | 数百人在线 |
|------|-----------|-----------|
| 内存 | ~80 MB | ~150 MB |
| CPU | < 3% | < 15% |
| 带宽 | < 5 KB/s | ~50 KB/s |
| 磁盘 | 每万场对局约 1–2 MB | 同 |

按此规模，**阿里云最低配（1 核 2GB）完全够用**，且可与服务器上已有服务共存。

---

## 六、故障排查

| 现象 | 原因 | 处理 |
|------|------|------|
| 浏览器报 `Mixed Content` | 前端 HTTPS 连了后端 HTTP | 后端必须配 HTTPS（见第 4 步） |
| 联机一直「连接中」 | 安全组没放行 443 / Nginx 没配 Upgrade 头 | 查安全组；核对 `nginx-pokerclub.conf` 的 `/ws` 段 |
| 排行榜 404 | 请求打到了 GitHub Pages 而非后端 | 确认 `POKERCLUB_SERVER` 指向后端域名 |
| 容器起不来 | 端口被占用 | `docker compose logs` 看报错；改 `PORT` 环境变量 |
| 数据丢了 | 没用 volume | 确认 `docker-compose.yml` 的 `./data:/app/data` 还在 |

---

## 七、安全说明（当前取舍）

- 认证采用**昵称 + 设备ID**：设备ID 是客户端生成的 UUID，服务端只做格式校验。
  → 这是「好友娱乐局」的合理取舍，**不做**防作弊级别的身份绑定。
- 服务端**权威**：手牌只下发本人，动作全部服务端校验后才广播，客户端改内存无效。
- 已内置限流（单连接 10 秒 120 条消息、建房 10 次/分、加房 30 次/分）。
- 数据库不存任何敏感个人信息，只有昵称、段位、道具与对局记录。
