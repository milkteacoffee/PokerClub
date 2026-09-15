'use strict';
/**
 * 服务端配置：全部可用环境变量覆盖，便于 Docker 部署。
 */
const path = require('path');

module.exports = {
  /* 监听 */
  port: Number(process.env.PORT || 8123),
  host: process.env.HOST || '0.0.0.0',

  /* 数据存放（SQLite 文件目录） */
  dataDir: process.env.DATA_DIR || path.join(__dirname, '..', 'data'),

  /* 房间 */
  room: {
    codeLength: 6,              // 房号位数
    maxPlayers: 6,              // 单房最大人数（掼蛋 4 人 / 德州 6 人）
    idleTimeoutMs: 30 * 60e3,   // 空房回收：房间无人在线 30 分钟
    reconnectGraceMs: 60e3,     // 断线重连宽限期，超时视为离桌
    actionTimeoutMs: 30e3,      // 单步操作超时（超时自动过牌/托管）
  },

  /* 认证 */
  auth: {
    /* 设备ID 由客户端生成（UUID），服务端只做长度/字符校验，防伪造超长串 */
    deviceIdMaxLen: 64,
    nicknameMaxLen: 16,
  },

  /* 限流 */
  rateLimit: {
    messagesPer10s: 120,        // 单连接 10 秒内最多消息数
    roomCreatePerMin: 10,       // 单设备每分钟创建房间上限
    roomJoinPerMin: 30,         // 单设备每分钟加入房间上限
  },

  /* 静态资源：前端为 GitHub Pages，此处仅在本地开发时提供同源代理页 */
  allowOrigin: process.env.ALLOW_ORIGIN || '*',
};
