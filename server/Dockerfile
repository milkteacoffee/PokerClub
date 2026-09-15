# 赌途 · 联机 + 排行后端
# 基于 Node 22（内置 node:sqlite，无需额外依赖编译环境）
FROM node:22-alpine

# 时区（排行榜按日期结算需要）
RUN apk add --no-cache tzdata \
 && cp /usr/share/zoneinfo/Asia/Shanghai /etc/localtime \
 && echo "Asia/Shanghai" > /etc/timezone

WORKDIR /app

# 先装依赖，利用 Docker 层缓存
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

# 再拷业务代码
COPY src ./src
COPY engine ./engine

# 数据目录（SQLite 落盘），通过 volume 挂载持久化
RUN mkdir -p /app/data
VOLUME ["/app/data"]

ENV NODE_ENV=production \
    PORT=8123 \
    DATA_DIR=/app/data

EXPOSE 8123

# 健康检查：/health 返回 200 即视为存活
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8123)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]
