'use strict';
/**
 * 牌友小馆后端主入口：
 *   HTTP  : 排行榜 / 好友 / 健康检查（JSON API，供纯单机模式拉榜单）
 *   WebSocket: 好友开房联机（/ws）
 *
 * 认证模型（按需求选择「昵称 + 设备ID」）：
 *   客户端首次生成 UUID 存 localStorage，后续所有请求带 X-Device-Id。
 *   服务端首次见到该设备即建档，昵称可随时改。
 */
const http = require('http');
const { WebSocketServer } = require('ws');
const config = require('./config');
const { Store, GAMES } = require('./store');
const { RoomManager, ADAPTERS } = require('./rooms');

const store = new Store(config.dataDir);
const rooms = new RoomManager(store);

/* claim 接口限流：ip -> [最近60秒内的请求时间戳] */
const claimHits = new Map();

const GAME_NAMES = {
  holdem: '德州扑克', blackjack: '21点', gold: '炸金花',
  dice: '猜骰子', diceduel: '骰子比大小', guandan: '掼蛋',
};

/* ---------------- 工具 ---------------- */
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': config.allowOrigin,
    'Access-Control-Allow-Headers': 'Content-Type, X-Device-Id',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let buf = '';
    req.on('data', c => { buf += c; if (buf.length > 1e6) req.destroy(); });
    req.on('end', () => {
      try { resolve(buf ? JSON.parse(buf) : {}); } catch { resolve({}); }
    });
  });
}

function validDeviceId(id) {
  return typeof id === 'string' && id.length >= 8 && id.length <= config.auth.deviceIdMaxLen && /^[A-Za-z0-9_-]+$/.test(id);
}

function cleanNick(n) {
  const s = String(n || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, config.auth.nicknameMaxLen);
  return s || '牌友';
}

/* ---------------- HTTP 路由 ---------------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const path = url.pathname;
  const deviceId = req.headers['x-device-id'];
  const method = req.method;

  if (method === 'OPTIONS') return json(res, 204, {});

  try {
    /* 健康检查 */
    if (path === '/health' || path === '/api/health') {
      return json(res, 200, { ok: true, uptime: Math.floor(process.uptime()), ...rooms.stats(), memoryMB: Math.round(process.memoryUsage().rss / 1048576) });
    }

    /* 服务信息 */
    if (path === '/api/info') {
      return json(res, 200, {
        ok: true, name: '牌友小馆联机服务', version: '1.0.0',
        games: Object.keys(ADAPTERS).map(id => ({ id, name: GAME_NAMES[id] || id, min: ADAPTERS[id].minPlayers, max: ADAPTERS[id].maxPlayers })),
        leaderboardGames: GAMES,
      });
    }

    /* 设备建档 / 改名 / 设头像 */
    if (path === '/api/player' && method === 'POST') {
      if (!validDeviceId(deviceId)) return json(res, 400, { ok: false, msg: '缺少或非法设备ID' });
      const body = await readBody(req);
      const p = store.ensurePlayer(deviceId, cleanNick(body.nickname));
      /* 头像：预设 id（如 a01），宽松校验为短 token，防止超长串入库 */
      if (body && body.avatar) {
        const av = String(body.avatar);
        if (/^[A-Za-z0-9_-]{1,16}$/.test(av)) store.setAvatar(deviceId, av);
      }
      /* 个性签名：去控制字符与尖括号，最长 60 字 */
      if (body && body.bio !== undefined) {
        const bio = String(body.bio).replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 60);
        store.setBio(deviceId, bio);
      }
      /* 佩戴中的称号：只接受称号 id 形式的短 token（如 tt_top_holdem） */
      if (body && body.title !== undefined) {
        const tid = String(body.title || '').trim();
        if (!tid || /^[A-Za-z0-9_]{1,32}$/.test(tid)) store.setTitle(deviceId, tid);
      }
      const fresh = store.getPlayer(deviceId);
      return json(res, 200, { ok: true, deviceId, nickname: fresh.nickname, avatar: fresh.avatar || 'a01', bio: fresh.bio || '', title: fresh.title || '', userCode: fresh.user_code, recoveryCode: fresh.recovery_code, rank: store.getRank(deviceId), items: store.getItems(deviceId) });
    }

    /* 云存档：全量状态 blob 的读取 / 上推（最后写入胜出，客户端凭 updatedAt 比对） */
    if (path === '/api/state' && method === 'GET') {
      if (!validDeviceId(deviceId)) return json(res, 400, { ok: false, msg: '缺少或非法设备ID' });
      store.ensurePlayer(deviceId, '牌友');
      const s = store.getState(deviceId);
      return json(res, 200, { ok: true, state: s.state, updatedAt: s.updatedAt });
    }
    if (path === '/api/state' && method === 'PUT') {
      if (!validDeviceId(deviceId)) return json(res, 400, { ok: false, msg: '缺少或非法设备ID' });
      const body = await readBody(req);
      if (!body || typeof body.state !== 'object' || body.state === null) {
        return json(res, 400, { ok: false, msg: '缺少存档数据' });
      }
      let raw;
      try { raw = JSON.stringify(body.state); } catch (e) { return json(res, 400, { ok: false, msg: '存档不可序列化' }); }
      if (raw.length > 512e3) return json(res, 413, { ok: false, msg: '存档过大' });
      store.ensurePlayer(deviceId, '牌友');
      const updatedAt = store.setState(deviceId, body.state);
      return json(res, 200, { ok: true, updatedAt });
    }

    /* 跨设备接管：凭 玩家号+恢复码 校验身份，返回原设备ID（客户端本机换绑后拉取云存档） */
    if (path === '/api/player/claim' && method === 'POST') {
      const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
      const now = Date.now();
      claimHits.set(ip, (claimHits.get(ip) || []).filter(t => now - t < 60e3));
      const hits = claimHits.get(ip); hits.push(now); claimHits.set(ip, hits);
      if (hits.length > 10) return json(res, 429, { ok: false, msg: '尝试过于频繁，请稍后再试' });
      const body = await readBody(req);
      const code = String(body.userCode || '').trim().toUpperCase();
      const recovery = String(body.recoveryCode || '').replace(/[\s-]/g, '').toUpperCase();
      if (!code || !recovery) return json(res, 400, { ok: false, msg: '请填写玩家号与恢复码' });
      const p = store.getUserByCode(code);
      if (!p || String(p.recovery_code || '').toUpperCase() !== recovery) {
        return json(res, 401, { ok: false, msg: '玩家号或恢复码不正确' });
      }
      return json(res, 200, { ok: true, deviceId: p.device_id, nickname: p.nickname, avatar: p.avatar || 'a01' });
    }

    /* 重新生成恢复码（旧码立即作废） */
    if (path === '/api/player/recovery/rotate' && method === 'POST') {
      if (!validDeviceId(deviceId)) return json(res, 400, { ok: false, msg: '缺少或非法设备ID' });
      store.ensurePlayer(deviceId, '牌友');
      const rc = store.rotateRecovery(deviceId);
      return json(res, 200, { ok: true, recoveryCode: rc });
    }

    /* 同步本地段位到服务端（单机模式也上榜） */
    if (path === '/api/rank' && method === 'POST') {
      if (!validDeviceId(deviceId)) return json(res, 400, { ok: false, msg: '缺少或非法设备ID' });
      const body = await readBody(req);
      const rank = (body && body.rank) || {};
      const clean = {};
      GAMES.forEach(g => {
        const v = rank[g] || {};
        clean[g] = {
          points: Math.max(0, Math.min(1e9, Number(v.points) || 0)),
          tier: Math.max(0, Math.min(99, Number(v.tier) || 0)),
          peak: Math.max(0, Math.min(99, Number(v.peak) || 0)),
        };
      });
      store.setRank(deviceId, clean);
      if (body && body.stats) store.setStats(deviceId, body.stats);
      if (body && body.items) store.setItems(deviceId, body.items);
      return json(res, 200, { ok: true });
    }

    /* 排行榜：全服榜 / 好友榜
       —— 全服榜是公开数据，无需设备ID（未登录也能围观）；
          好友榜必须有身份才能算出「我的好友」集合。 */
    if (path === '/api/leaderboard') {
      const game = url.searchParams.get('game') || 'holdem';
      if (!GAMES.includes(game)) return json(res, 400, { ok: false, msg: '未知游戏' });
      const scope = url.searchParams.get('scope') || 'global';
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 50));
      const me = validDeviceId(deviceId) ? deviceId : '';

      if (scope === 'friends' && !me) {
        return json(res, 400, { ok: false, msg: '好友榜需要设备ID' });
      }

      let list;
      if (scope === 'friends') {
        store.ensurePlayer(me, '牌友');
        list = store.friendBoard(me, game);
      } else {
        if (me) store.ensurePlayer(me, '牌友');
        list = store.globalBoard(game, limit);
      }
      const withRank = list.map((x, i) => ({ ...x, rank: i + 1, isMe: !!me && x.deviceId === me }));
      return json(res, 200, { ok: true, game, gameName: GAME_NAMES[game], scope, list: withRank });
    }

    /* 好友：列表 / 请求 / 接受 / 删除 */
    if (path === '/api/friends') {
      if (!validDeviceId(deviceId)) return json(res, 400, { ok: false, msg: '缺少或非法设备ID' });
      if (method === 'GET') {
        const ids = store.friendsOf(deviceId);
        const list = ids.map(id => {
          const p = store.getPlayer(id);
          return p ? { deviceId: id, nickname: p.nickname, avatar: p.avatar || 'a01', rank: store.getRank(id), lastSeen: p.last_seen } : null;
        }).filter(Boolean);
        return json(res, 200, {
          ok: true, friends: list,
          requests: store.pendingRequests(deviceId).map(r => {
            const p = store.getPlayer(r.from_id);
            return { deviceId: r.from_id, nickname: r.nickname || '牌友', avatar: (p && p.avatar) || 'a01' };
          }),
        });
      }
      if (method === 'POST') {
        const body = await readBody(req);
        /* 兼容两种字段名：deviceId / friendId / targetId */
        const raw = String(body.deviceId || body.friendId || body.targetId || '').trim();
        if (!raw) return json(res, 400, { ok: false, msg: '请填写对方玩家号或设备ID' });
        /* 解析目标：优先当设备ID；否则当短玩家号（大小写不敏感） */
        let target = raw;
        let targetPlayer = validDeviceId(raw) ? store.getPlayer(raw) : null;
        if (!targetPlayer) {
          const byCode = store.getUserByCode(raw);
          if (byCode) { targetPlayer = byCode; target = byCode.device_id; }
        }
        if (!targetPlayer) return json(res, 404, { ok: false, msg: '对方不存在（请确认玩家号或设备ID）' });
        if (target === deviceId) return json(res, 400, { ok: false, msg: '不能加自己为好友' });
        store.ensurePlayer(deviceId, '牌友');
        const r = store.requestFriend(deviceId, target);
        return json(res, 200, r);
      }
    }
    if (path === '/api/friends/accept' && method === 'POST') {
      if (!validDeviceId(deviceId)) return json(res, 400, { ok: false, msg: '缺少或非法设备ID' });
      const body = await readBody(req);
      const from = String(body.deviceId || body.friendId || body.fromId || '');
      if (!validDeviceId(from)) return json(res, 400, { ok: false, msg: '非法来源设备ID' });
      /* 必须确实存在待处理请求，否则是假成功 */
      const pending = store.pendingRequests(deviceId).some(r => r.from_id === from);
      if (!pending) return json(res, 404, { ok: false, msg: '没有来自该玩家的好友请求' });
      store.addFriend(deviceId, from);
      return json(res, 200, { ok: true });
    }
    if (path === '/api/friends' && method === 'DELETE') {
      if (!validDeviceId(deviceId)) return json(res, 400, { ok: false, msg: '缺少或非法设备ID' });
      const target = String(url.searchParams.get('deviceId') || url.searchParams.get('friendId') || '');
      if (!validDeviceId(target)) return json(res, 400, { ok: false, msg: '非法目标设备ID' });
      store.removeFriend(deviceId, target);
      return json(res, 200, { ok: true });
    }

    /* 好友搜索：按昵称模糊匹配玩家（需身份，排除自己）
       —— 返回候选列表，供前端"昵称互加"。标记 isFriend / requested / pending 让 UI 直接显示状态。 */
    if (path === '/api/friends/search' && method === 'GET') {
      if (!validDeviceId(deviceId)) return json(res, 400, { ok: false, msg: '缺少或非法设备ID' });
      const q = (url.searchParams.get('q') || '').trim();
      if (!q) return json(res, 400, { ok: false, msg: '搜索词不能为空' });
      if (q.length > config.auth.nicknameMaxLen) return json(res, 400, { ok: false, msg: '搜索词过长' });
      const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit')) || 20));
      const rows = store.searchPlayersByNick(q, deviceId, limit);
      const friends = new Set(store.friendsOf(deviceId));
      const requested = new Set(store.outgoingRequests(deviceId));
      const pending = new Set(store.pendingRequests(deviceId).map(r => r.from_id));
      const list = rows.map(r => ({
        deviceId: r.deviceId,
        nickname: r.nickname,
        avatar: r.avatar || 'a01',
        isFriend: friends.has(r.deviceId),
        requested: requested.has(r.deviceId),
        pending: pending.has(r.deviceId),
      }));
      return json(res, 200, { ok: true, q, list });
    }

    /* ---- 拉黑名单（UGC 处置）：GET 列表 / POST 拉黑 / DELETE 解除 ---- */
    if (path === '/api/blocks') {
      if (!validDeviceId(deviceId)) return json(res, 400, { ok: false, msg: '缺少或非法设备ID' });
      if (method === 'GET') return json(res, 200, { ok: true, list: store.listBlocks(deviceId) });
      let body = {};
      try { body = await readBody(req); } catch (e) { return json(res, 400, { ok: false, msg: '请求体不合法' }); }
      const targetId = String((body && (body.targetId || body.deviceId)) || '').slice(0, 64);
      if (!validDeviceId(targetId)) return json(res, 400, { ok: false, msg: '目标玩家不合法' });
      if (targetId === deviceId) return json(res, 400, { ok: false, msg: '不能对自己操作' });
      if (method === 'POST') { store.addBlock(deviceId, targetId); return json(res, 200, { ok: true, blocked: true, list: store.listBlocks(deviceId) }); }
      if (method === 'DELETE') { store.removeBlock(deviceId, targetId); return json(res, 200, { ok: true, blocked: false, list: store.listBlocks(deviceId) }); }
      return json(res, 405, { ok: false, msg: '方法不支持' });
    }

    /* ---- 举报（留证用，不自动处罚）---- */
    if (path === '/api/report' && method === 'POST') {
      if (!validDeviceId(deviceId)) return json(res, 400, { ok: false, msg: '缺少或非法设备ID' });
      let body = {};
      try { body = await readBody(req); } catch (e) { return json(res, 400, { ok: false, msg: '请求体不合法' }); }
      const targetId = String((body && (body.targetId || body.deviceId)) || '').slice(0, 64);
      const reason = String((body && body.reason) || '').replace(/[\u0000-\u001f<>]/g, '').slice(0, 40);
      if (!validDeviceId(targetId)) return json(res, 400, { ok: false, msg: '目标玩家不合法' });
      if (targetId === deviceId) return json(res, 400, { ok: false, msg: '不能举报自己' });
      store.addReport(deviceId, targetId, reason);
      return json(res, 200, { ok: true, count: store.reportCount(targetId) });
    }

    /* 房间号搜索成员：通过房号查房内现时成员（无需身份也能围观成员，用于"房间号互加"）
       —— 返回成员 deviceId/nickname/seat/online/ready，并相对查询者标记 isMe / isFriend。 */
    if (path === '/api/room/members' && method === 'GET') {
      const code = (url.searchParams.get('code') || '').trim();
      if (!/^\d+$/.test(code) || code.length !== config.room.codeLength) {
        return json(res, 400, { ok: false, msg: '房间号格式不正确（' + config.room.codeLength + ' 位数字）' });
      }
      const room = rooms.get(code);
      if (!room) return json(res, 404, { ok: false, msg: '房间不存在或已解散' });
      const friends = new Set(validDeviceId(deviceId) ? store.friendsOf(deviceId) : []);
      const pending = new Set(validDeviceId(deviceId) ? store.pendingRequests(deviceId).map(r => r.from_id) : []);
      const members = room.seats.map(s => {
        const sp = store.getPlayer(s.deviceId);
        return {
          deviceId: s.deviceId,
          nickname: s.name || '牌友',
          avatar: (sp && sp.avatar) || 'a01',
          seat: s.seat,
          online: !!s.online,
          ready: !!s.ready,
          isMe: validDeviceId(deviceId) && s.deviceId === deviceId,
          isFriend: friends.has(s.deviceId),
          pending: pending.has(s.deviceId),
        };
      });
      return json(res, 200, { ok: true, code, game: room.game, members });
    }

    return json(res, 404, { ok: false, msg: 'not found' });
  } catch (e) {
    console.error('[http] 处理失败', path, e);
    return json(res, 500, { ok: false, msg: '服务内部错误' });
  }
});

/* ---------------- WebSocket 联机 ---------------- */
const wss = new WebSocketServer({ server, path: '/ws' });
const conns = new Map();   // deviceId -> { ws, roomCode, lastMsgs: [] }

/* 局内快捷语白名单：与前端 SAY_TEXTS 一字不差。
   服务端只放行白名单 —— 这样局内社交不存在自由文本，天然规避内容审核风险。 */
const SAY_TEXTS = [
  '大家好，很高兴见到各位', '快点吧，等到花都谢了', '打得不错', '手气真好',
  '承让承让', '这牌有点难打', '我先看看', '稳住，我们能赢',
  '队友给力', '别急，慢慢来', '这波漂亮', '好牌，可惜了',
  '我弃牌，你们继续', '再来一局，别走', '不好意思，我赢了', '绝了',
];

/* ============ 快速匹配（陌生人匹配：凑满即建房并直接开局）============
   设计取舍：真人优先，凑不满就继续等（不做 AI 补位，避免"以为是真人"的误解）；
   匹配房无需准备，建房即开局，与好友房的准备流程互不影响。 */
const matchQueue = new Map();   // game -> [ { deviceId, nickname, ws } ]
const matchMin = (game) => { const ad = ADAPTERS[game]; return (ad && ad.minPlayers) || 2; };
function broadcastMatch(game) {
  const q = matchQueue.get(game) || [];
  for (const e of q) if (e.ws && e.ws.readyState === 1) {
    send(e.ws, 'matching', { game, name: GAME_NAMES[game] || game, waiting: q.length, need: matchMin(game), names: q.map(x => x.nickname) });
  }
}
function matchRemove(deviceId) {
  for (const [g, q] of matchQueue) {
    const i = q.findIndex(e => e.deviceId === deviceId);
    if (i >= 0) { q.splice(i, 1); broadcastMatch(g); }
  }
}
function matchPush(game, deviceId, nickname, ws) {
  if (!ADAPTERS[game]) return { ok: false, msg: '该玩法暂不支持快速匹配' };
  matchRemove(deviceId);
  rooms.leaveCurrent(deviceId);
  let q = matchQueue.get(game);
  if (!q) { q = []; matchQueue.set(game, q); }
  q.push({ deviceId, nickname, ws });
  return { ok: true };
}
function tryMatch(game) {
  const q = matchQueue.get(game) || [];
  const need = matchMin(game);
  if (q.length < need) { broadcastMatch(game); return; }
  const group = q.splice(0, need);
  broadcastMatch(game);
  const host = group[0];
  const r = rooms.create(game, host.deviceId, host.nickname, { matched: true });
  if (!r.ok) { for (const e of group) if (e.ws) send(e.ws, 'error', { msg: r.msg }); return; }
  const room = r.room, code = r.code;
  room.matched = true;
  const hs = room.seats.find(x => x.deviceId === host.deviceId); if (hs) hs.ws = host.ws;
  const hc = conns.get(host.deviceId); if (hc) hc.roomCode = code;
  for (let i = 1; i < group.length; i++) {
    const e = group[i];
    const jr = rooms.join(code, e.deviceId, e.nickname, e.ws);
    if (jr.ok) { const c = conns.get(e.deviceId); if (c) c.roomCode = code; }
    else if (e.ws) send(e.ws, 'error', { msg: '匹配失败：' + jr.msg });
  }
  const st = room.start();
  if (st.ok) startTick(room);
  for (const s of room.seats) if (s.online && s.ws) send(s.ws, 'room', { code, seat: s.seat, room: room.viewFor(s.deviceId), matched: true });
  for (const s of room.seats) if (s.online && s.ws) send(s.ws, 'state', { state: room.viewFor(s.deviceId) });
  console.log('[match] ' + game + ' 匹配成功 ' + code + '（' + group.map(x => x.nickname).join('、') + '）');
}



function send(ws, type, data) {
  if (ws && ws.readyState === 1) {
    let payload;
    try { payload = JSON.stringify({ type, ...data }); }
    catch (e) { console.error('[ws] 序列化失败 type=' + type, e && e.message); return; }
    try { ws.send(payload); } catch (e) { console.error('[ws] 发送失败 type=' + type, e && e.message); }
  }
}

function broadcast(room, type, data, exceptDevice) {
  for (const s of room.seats) {
    if (!s.online || !s.ws) continue;
    if (exceptDevice && s.deviceId === exceptDevice) continue;
    send(s.ws, type, data);
  }
}

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const deviceId = url.searchParams.get('deviceId') || req.headers['x-device-id'];
  if (!validDeviceId(deviceId)) { send(ws, 'error', { msg: '非法设备ID' }); ws.close(); return; }
  const nickname = cleanNick(url.searchParams.get('nickname'));
  store.ensurePlayer(deviceId, nickname);

  /* 同设备旧连接踢掉 */
  const old = conns.get(deviceId);
  if (old && old.ws && old.ws !== ws) { try { old.ws.close(4001, '重复登录'); } catch {} }

  const conn = { ws, deviceId, nickname, roomCode: null, msgs: [] };
  conns.set(deviceId, conn);
  const meP = store.getPlayer(deviceId);
  send(ws, 'hello', { deviceId, nickname, userCode: meP ? meP.user_code : '', avatar: meP ? (meP.avatar || 'a01') : 'a01', games: Object.keys(ADAPTERS) });

  ws.on('message', (raw) => {
    /* 限流 */
    const now = Date.now();
    conn.msgs = conn.msgs.filter(t => now - t < 10000);
    if (conn.msgs.length >= config.rateLimit.messagesPer10s) { send(ws, 'error', { msg: '操作过于频繁' }); return; }
    conn.msgs.push(now);

    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return send(ws, 'error', { msg: '消息格式错误' }); }
    const t = msg.type;
    try {
      if (t === 'nick') {
        conn.nickname = cleanNick(msg.nickname);
        store.ensurePlayer(deviceId, conn.nickname);
        const code = conn.roomCode;
        if (code) {
          const room = rooms.get(code);
          if (room) { const s = room.seats.find(x => x.deviceId === deviceId); if (s) s.name = conn.nickname; broadcast(room, 'room', { room: room.viewFor(null) }); }
        }
        return send(ws, 'ok', { msg: '昵称已更新', nickname: conn.nickname });
      }

      if (t === 'create') {
        const r = rooms.create(msg.game, deviceId, conn.nickname, { level: 2 });
        if (!r.ok) return send(ws, 'error', { msg: r.msg });
        conn.roomCode = r.code;
        r.room.seats[0].ws = ws;
        send(ws, 'room', { code: r.code, seat: r.seat, room: r.room.viewFor(deviceId) });
        return;
      }

      if (t === 'join') {
        const code = String(msg.code || '').trim();
        const r = rooms.join(code, deviceId, conn.nickname, ws);
        if (!r.ok) return send(ws, 'error', { msg: r.msg });
        conn.roomCode = code;
        send(ws, 'room', { code, seat: r.seat, room: r.room.viewFor(deviceId) });
        broadcast(r.room, 'room', { room: r.room.viewFor(null) }, deviceId);
        /* 广播给房内其他人，让他们知道自己被 join 了 */
        for (const s of r.room.seats) {
          if (s.deviceId !== deviceId && s.online && s.ws) send(s.ws, 'room', { code, room: r.room.viewFor(s.deviceId) });
        }
        return;
      }

      if (t === 'ready') {
        const room = getRoomOf(conn);
        if (!room) return send(ws, 'error', { msg: '不在房间内' });
        const s = room.seats.find(x => x.deviceId === deviceId);
        if (!s) return send(ws, 'error', { msg: '不在房间内' });
        s.ready = msg.ready !== false;
        room.lastActivity = Date.now();
        broadcast(room, 'room', { code: room.code, room: room.viewFor(null) });
        return;
      }

      if (t === 'start') {
        const room = getRoomOf(conn);
        if (!room) return send(ws, 'error', { msg: '不在房间内' });
        if (room.hostDevice !== deviceId) return send(ws, 'error', { msg: '只有房主能开始' });
        const r = room.start();
        if (!r.ok) return send(ws, 'error', { msg: r.msg });
        startTick(room);
        for (const s of room.seats) if (s.online && s.ws) send(s.ws, 'state', { state: room.viewFor(s.deviceId) });
        return;
      }

      if (t === 'act') {
        const room = getRoomOf(conn);
        if (!room) return send(ws, 'error', { msg: '不在房间内' });
        const r = room.act(deviceId, msg.payload || msg);
        if (!r.ok) return send(ws, 'error', { msg: r.msg });
        /* 全员同步 */
        for (const s of room.seats) if (s.online && s.ws) send(s.ws, 'state', { state: room.viewFor(s.deviceId) });
        if (room.adapter.isDone(room.state)) settleRoom(room);
        return;
      }

      if (t === 'say') {
        const room = getRoomOf(conn);
        if (!room) return send(ws, 'error', { msg: '不在房间内' });
        const text = String(msg.text || '').trim();
        if (SAY_TEXTS.indexOf(text) < 0) return send(ws, 'error', { msg: '只支持预设快捷语' });
        const sd = room.seats.find(x => x.deviceId === deviceId);
        if (!sd) return;
        /* 注意：不刷新 lastActivity —— 发言不该影响「行动超时自动代打」的计时 */
        broadcast(room, 'say', { seat: sd.seat, text });
        return;
      }

      if (t === 'leave') {
        const room = getRoomOf(conn);
        if (room) {
          room.leave(deviceId);
          broadcast(room, 'room', { code: room.code, room: room.viewFor(null) });
          send(ws, 'left', {});
        }
        conn.roomCode = null;
        rooms.byDevice.delete(deviceId);
        matchRemove(deviceId);
        return;
      }

      if (t === 'match') {
        const game = String(msg.game || 'holdem');
        const r = matchPush(game, deviceId, conn.nickname, ws);
        if (!r.ok) return send(ws, 'error', { msg: r.msg });
        tryMatch(game);
        return;
      }

      if (t === 'matchCancel') {
        matchRemove(deviceId);
        return send(ws, 'left', { cancelled: true });
      }

      if (t === 'ping') return send(ws, 'pong', { t: Date.now() });
      return send(ws, 'error', { msg: '未知消息类型: ' + t });
    } catch (e) {
      console.error('[ws] 处理消息失败', t, e);
      send(ws, 'error', { msg: '服务内部错误' });
    }
  });

  ws.on('close', () => {
    const c = conns.get(deviceId);
    if (c && c.ws === ws) conns.delete(deviceId);
    matchRemove(deviceId);
    const room = conn.roomCode ? rooms.get(conn.roomCode) : null;
    if (room) {
      room.leave(deviceId);
      broadcast(room, 'room', { code: room.code, room: room.viewFor(null) });
      for (const s of room.seats) if (s.online && s.ws) send(s.ws, 'state', { state: room.viewFor(s.deviceId) });
    }
  });

  ws.on('error', () => {});
});

function getRoomOf(conn) {
  if (!conn.roomCode) return null;
  return rooms.get(conn.roomCode);
}

/* 每秒驱动一次房间，负责：断线托管、断线宽限、行动超时 */
function startTick(room) {
  if (room.tickTimer) return;
  room.tickTimer = setInterval(() => {
    if (!rooms.rooms.has(room.code)) { clearInterval(room.tickTimer); return; }
    const now = Date.now();
    /* 断线宽限超时：移出座位 */
    let removed = false;
    for (const s of room.seats) {
      if (!s.online && s.leftAt && now - s.leftAt > config.room.reconnectGraceMs) {
        room.seats.splice(room.seats.indexOf(s), 1);
        rooms.byDevice.delete(s.deviceId);
        removed = true;
      }
    }
    if (removed) {
      broadcast(room, 'room', { code: room.code, room: room.viewFor(null) });
      /* 人数不足则中止牌局 */
      const ad = room.adapter;
      if (room.started && room.seats.filter(s => s.online).length < ad.minPlayers) {
        room.started = false; room.state = null;
        broadcast(room, 'aborted', { msg: '人数不足，牌局已中止' });
        if (room.tickTimer) { clearInterval(room.tickTimer); room.tickTimer = null; }
        return;
      }
    }
    /* 行动超时：自动代为操作 */
    if (room.started && room.state && !room.adapter.isDone(room.state)) {
      const turnSeat = room.game === 'guandan' ? room.state.g.turn : room.state.turn;
      const s = room.seats.find(x => x.seat === turnSeat);
      const idle = now - room.lastActivity;
      if (s && s.online && idle > config.room.actionTimeoutMs) {
        const payload = room.adapter.autoAct(room.state, turnSeat);
        if (payload && payload.ids) room.act(s.deviceId, { ids: payload.ids });
        else if (payload && payload.pass) room.act(s.deviceId, { pass: true });
        else if (payload && payload.action) room.act(s.deviceId, payload);
        room.lastActivity = now;
        for (const x of room.seats) if (x.online && x.ws) send(x.ws, 'state', { state: room.viewFor(x.deviceId) });
      } else if (!s || !s.online) {
        room.stepAuto();
        room._checkSettle();
        for (const x of room.seats) if (x.online && x.ws) send(x.ws, 'state', { state: room.viewFor(x.deviceId) });
      }
    }
    if (room.state && room.adapter.isDone(room.state)) settleRoom(room);
  }, 1000);
  if (room.tickTimer.unref) room.tickTimer.unref();
}

function settleRoom(room) {
  /* 幂等：同一局只广播一次结算 */
  if (room.settleSent) return;
  const res = room.result || (room.adapter.settlement ? room.adapter.settlement(room.state) : null);
  if (!res) return;
  room.settleSent = true;
  const seatAvatar = (d) => { try { const p = store.getPlayer(d); return (p && p.avatar) || 'a01'; } catch (e) { return 'a01'; } };
  for (const s of room.seats) {
    if (s.online && s.ws) send(s.ws, 'settle', { result: res, seatInfo: room.seats.map(x => ({ seat: x.seat, name: x.name, avatar: seatAvatar(x.deviceId), online: x.online })) });
  }
}

/* 掼蛋：手动驱动 AI（人类出牌后需要连续推进直到轮到下一个人）
   —— 这里在每次 act 后触发一次 stepAuto 补位 */
setInterval(() => {
  for (const room of rooms.rooms.values()) {
    if (room.started && room.state && !room.adapter.isDone(room.state)) room.stepAuto();
  }
}, 300);

/* ---------------- 启动 ---------------- */
function start() {
  server.listen(config.port, config.host, () => {
    console.log('[牌友小馆后端] 已启动 http://' + config.host + ':' + config.port);
    console.log('  HTTP  : /health  /api/info  /api/leaderboard  /api/friends  /api/rank');
    console.log('  WS    : /ws?deviceId=xxx&nickname=xxx');
    console.log('  数据  : ' + store.file);
  });
}

if (require.main === module) start();

module.exports = { server, store, rooms, start, GAME_NAMES };
