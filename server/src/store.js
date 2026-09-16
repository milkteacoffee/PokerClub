'use strict';
/**
 * 持久化层：Node 内置 node:sqlite（零外部依赖，免编译）
 * 存三张表：
 *   players   设备ID → 昵称、六游戏段位分、可兑换积分、道具库存、时间戳
 *   friends   好友关系（双向存两条）
 *   matches   对局记录（用于战绩与反作弊审计）
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const GAMES = ['holdem', 'blackjack', 'gold', 'dice', 'diceduel', 'guandan'];

class Store {
  constructor(dataDir) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.file = path.join(dataDir, 'pokerclub.db');
    this.db = new DatabaseSync(this.file);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this._migrate();
    this._prepare();
  }

  _migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS players (
        device_id     TEXT PRIMARY KEY,
        nickname      TEXT NOT NULL,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL,
        last_seen     INTEGER NOT NULL DEFAULT 0,
        rank_json     TEXT NOT NULL DEFAULT '{}',
        item_json     TEXT NOT NULL DEFAULT '{}',
        stats_json    TEXT NOT NULL DEFAULT '{}',
        title         TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS friends (
        device_id     TEXT NOT NULL,
        friend_id     TEXT NOT NULL,
        created_at    INTEGER NOT NULL,
        PRIMARY KEY (device_id, friend_id)
      );
      CREATE INDEX IF NOT EXISTS idx_friends_dev ON friends(device_id);
      CREATE TABLE IF NOT EXISTS matches (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        game          TEXT NOT NULL,
        room_code     TEXT,
        mode          TEXT NOT NULL,
        ended_at      INTEGER NOT NULL,
        result_json   TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS idx_matches_game ON matches(game, ended_at DESC);
      CREATE TABLE IF NOT EXISTS friend_requests (
        from_id       TEXT NOT NULL,
        to_id         TEXT NOT NULL,
        created_at    INTEGER NOT NULL,
        PRIMARY KEY (from_id, to_id)
      );
      CREATE INDEX IF NOT EXISTS idx_freq_to ON friend_requests(to_id);
      /* 拉黑（UGC 处置）：玩家级黑名单，主键天然去重 */
      CREATE TABLE IF NOT EXISTS blocks (
        device_id   TEXT NOT NULL,
        target_id   TEXT NOT NULL,
        created_at  INTEGER NOT NULL,
        PRIMARY KEY (device_id, target_id)
      );
      CREATE INDEX IF NOT EXISTS idx_blocks_dev ON blocks(device_id);
      /* 举报记录：仅留证与统计用，不做自动处罚 */
      CREATE TABLE IF NOT EXISTS reports (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        device_id   TEXT NOT NULL,
        target_id   TEXT NOT NULL,
        reason      TEXT NOT NULL DEFAULT '',
        created_at  INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_reports_target ON reports(target_id, created_at DESC);
      /* 账号体系：用户名 + 密码（scrypt 加盐哈希），一个账号绑定一个存档身份(device_id)。
         不引入手机号/短信（需付费与备案），保持零成本、无门槛。 */
      CREATE TABLE IF NOT EXISTS redeem_codes (
        code        TEXT PRIMARY KEY,
        coins       INTEGER NOT NULL,
        max_uses    INTEGER NOT NULL DEFAULT 1,
        used_count  INTEGER NOT NULL DEFAULT 0,
        created_at  INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS code_redemptions (
        code        TEXT NOT NULL,
        device_id   TEXT NOT NULL,
        redeemed_at INTEGER NOT NULL,
        PRIMARY KEY (code, device_id)
      );
      /* 邀请：好友首次进入即记录，双方各得奖励 */
      CREATE TABLE IF NOT EXISTS invites (
        referrer    TEXT NOT NULL,
        invitee     TEXT NOT NULL,
        created_at  INTEGER NOT NULL,
        PRIMARY KEY (referrer, invitee)
      );
      CREATE TABLE IF NOT EXISTS accounts (
        username    TEXT PRIMARY KEY,
        device_id   TEXT NOT NULL UNIQUE,
        pass_salt   TEXT NOT NULL,
        pass_hash   TEXT NOT NULL,
        created_at  INTEGER NOT NULL,
        last_login  INTEGER NOT NULL DEFAULT 0
      );
    `);
    /* 短玩家号：每位玩家一个唯一、易分享的 8 位码（好友互加用，区别于内部设备ID） */
    try { this.db.exec('ALTER TABLE players ADD COLUMN user_code TEXT'); } catch (e) { /* 列已存在则忽略 */ }
    /* 用户资料：预设头像 ID（av01~av12）+ 个性签名 */
    try { this.db.exec("ALTER TABLE players ADD COLUMN avatar TEXT NOT NULL DEFAULT ''"); } catch (e) { /* 列已存在则忽略 */ }
    try { this.db.exec("ALTER TABLE players ADD COLUMN bio TEXT NOT NULL DEFAULT ''"); } catch (e) { /* 列已存在则忽略 */ }
    try { this.db.exec("ALTER TABLE players ADD COLUMN title TEXT NOT NULL DEFAULT ''"); } catch (e) { /* 列已存在则忽略 */ }
    try { this.db.exec('ALTER TABLE players ADD COLUMN mailbox_coins INTEGER NOT NULL DEFAULT 0'); } catch (e) { /* 列已存在则忽略 */ }
    /* 回填历史玩家（老数据 user_code 为 NULL） */
    const needCode = this.db.prepare('SELECT device_id FROM players WHERE user_code IS NULL OR user_code = ?');
    for (const r of needCode.all('')) {
      const code = this._genUserCode();
      this.db.prepare('UPDATE players SET user_code = ? WHERE device_id = ?').run(code, r.device_id);
    }
    /* 回填后再建唯一索引，避免 NULL 冲突 */
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_players_code ON players(user_code)');
    /* 资料与云存档：recovery_code=跨设备接管凭据（明文存，低风险好友局）；
       state_json=全量存档 blob（allSaves），state_updated_at=最后上推时间 */
    try { this.db.exec('ALTER TABLE players ADD COLUMN recovery_code TEXT'); } catch (e) {}
    try { this.db.exec("ALTER TABLE players ADD COLUMN state_json TEXT NOT NULL DEFAULT ''"); } catch (e) {}
    try { this.db.exec('ALTER TABLE players ADD COLUMN state_updated_at INTEGER NOT NULL DEFAULT 0'); } catch (e) {}
    this.db.exec("UPDATE players SET avatar = 'a01' WHERE avatar IS NULL OR avatar = ''");
    const needRecovery = this.db.prepare('SELECT device_id FROM players WHERE recovery_code IS NULL OR recovery_code = ?');
    for (const r of needRecovery.all('')) {
      this.db.prepare('UPDATE players SET recovery_code = ? WHERE device_id = ?').run(this._genRecovery(), r.device_id);
    }
  }

  /* 生成全局唯一的短玩家号：8 位，去掉易混字符 0/O/1/I/L */
  _genUserCode() {
    const ABC = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
    for (let attempt = 0; attempt < 50; attempt++) {
      let s = '';
      const buf = crypto.randomBytes(8);
      for (let i = 0; i < 8; i++) s += ABC[buf[i] % ABC.length];
      const hit = this.db.prepare('SELECT 1 FROM players WHERE user_code = ?').get(s);
      if (!hit) return s;
    }
    /* 极小概率碰撞：时间戳兜底（仍唯一性极高） */
    return 'P' + Date.now().toString(36).slice(-7).toUpperCase();
  }

  /* 生成恢复码：16 位无易混字符（跨设备接管凭据，展示时按 4 位分组） */
  _genRecovery() {
    const ABC = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
    const buf = crypto.randomBytes(16);
    let s = '';
    for (let i = 0; i < 16; i++) s += ABC[buf[i] % ABC.length];
    return s;
  }

  _prepare() {
    const d = this.db;
    this.q = {
      getPlayer: d.prepare('SELECT * FROM players WHERE device_id = ?'),
      insertPlayer: d.prepare(`INSERT INTO players (device_id,nickname,created_at,updated_at,last_seen,rank_json,item_json,stats_json)
                               VALUES (?,?,?,?,?,?,?,?)`),
      updateNick: d.prepare('UPDATE players SET nickname = ?, updated_at = ? WHERE device_id = ?'),
      updateRank: d.prepare('UPDATE players SET rank_json = ?, updated_at = ? WHERE device_id = ?'),
      updateItem: d.prepare('UPDATE players SET item_json = ?, updated_at = ? WHERE device_id = ?'),
      updateStats: d.prepare('UPDATE players SET stats_json = ?, updated_at = ? WHERE device_id = ?'),
      updateProfile: d.prepare('UPDATE players SET avatar = ?, bio = ?, updated_at = ? WHERE device_id = ?'),
      updateCode: d.prepare('UPDATE players SET user_code = ? WHERE device_id = ?'),
      updateAvatar: d.prepare('UPDATE players SET avatar = ?, updated_at = ? WHERE device_id = ?'),
      updateBio: d.prepare('UPDATE players SET bio = ?, updated_at = ? WHERE device_id = ?'),
      updateTitle: d.prepare('UPDATE players SET title = ?, updated_at = ? WHERE device_id = ?'),
      updateRecovery: d.prepare('UPDATE players SET recovery_code = ?, updated_at = ? WHERE device_id = ?'),
      updateState: d.prepare('UPDATE players SET state_json = ?, state_updated_at = ?, updated_at = ? WHERE device_id = ?'),
      getByCode: d.prepare('SELECT * FROM players WHERE user_code = ?'),
      touch: d.prepare('UPDATE players SET last_seen = ? WHERE device_id = ?'),

      listAllRatings: d.prepare('SELECT device_id,nickname,rank_json,stats_json FROM players WHERE last_seen >= ?'),
      topByGame: d.prepare('SELECT device_id,nickname,avatar,bio,title,rank_json,stats_json FROM players'),

      listFriends: d.prepare('SELECT friend_id FROM friends WHERE device_id = ?'),
      addFriend: d.prepare('INSERT OR IGNORE INTO friends (device_id,friend_id,created_at) VALUES (?,?,?)'),
      delFriend: d.prepare('DELETE FROM friends WHERE device_id = ? AND friend_id = ?'),
      isFriend: d.prepare('SELECT 1 FROM friends WHERE device_id = ? AND friend_id = ?'),
      getMany: d.prepare(`SELECT device_id,nickname,avatar,bio,title,rank_json,stats_json FROM players WHERE device_id IN (SELECT friend_id FROM friends WHERE device_id = ?)`),

      addReq: d.prepare('INSERT OR IGNORE INTO friend_requests (from_id,to_id,created_at) VALUES (?,?,?)'),
      delReq: d.prepare('DELETE FROM friend_requests WHERE from_id = ? AND to_id = ?'),
      listReqTo: d.prepare(`SELECT r.from_id, r.created_at, p.nickname, p.avatar FROM friend_requests r
                            LEFT JOIN players p ON p.device_id = r.from_id WHERE r.to_id = ?`),
      listReqFrom: d.prepare('SELECT to_id, created_at FROM friend_requests WHERE from_id = ?'),
      searchByNick: d.prepare(`SELECT device_id, nickname, avatar FROM players
                               WHERE nickname LIKE ? ESCAPE '\\' AND device_id <> ?
                               ORDER BY last_seen DESC LIMIT ?`),

      addMatch: d.prepare('INSERT INTO matches (game,room_code,mode,ended_at,result_json) VALUES (?,?,?,?,?)'),
      countMatches: d.prepare('SELECT COUNT(*) AS n FROM matches WHERE game = ?'),
    };
  }

  /* ---------- 玩家 ---------- */
  /* 确保玩家存在。
     - 新玩家：用 nickname，缺省 '牌友'
     - 老玩家：仅当 nickname 传入 且 不等于 '牌友' 时才改名
       （'牌友' 是"未知昵称"的占位，不能把已取名的玩家改回占位名） */
  ensurePlayer(deviceId, nickname) {
    const now = Date.now();
    const nick = (nickname && nickname !== '牌友') ? nickname : '';
    let p = this.q.getPlayer.get(deviceId);
    if (!p) {
      this.q.insertPlayer.run(deviceId, nick || '牌友', now, now, now, '{}', '{}', '{}');
      p = this.q.getPlayer.get(deviceId);
    } else if (nick && nick !== p.nickname) {
      this.q.updateNick.run(nick, now, deviceId);
      p.nickname = nick;
    }
    /* 确保每位玩家都有短玩家号 */
    if (!p.user_code) {
      const code = this._genUserCode();
      this.q.updateCode.run(code, deviceId);
      p.user_code = code;
    }
    /* 确保头像与恢复码 */
    if (!p.avatar) { this.q.updateAvatar.run('a01', now, deviceId); p.avatar = 'a01'; }
    if (!p.recovery_code) {
      const rc = this._genRecovery();
      this.q.updateRecovery.run(rc, now, deviceId);
      p.recovery_code = rc;
    }
    this.q.touch.run(now, deviceId);
    return p;
  }

  getPlayer(deviceId) { return this.q.getPlayer.get(deviceId); }

  /* 按短玩家号解析玩家（好友互加时，target 可能是设备ID或短码） */
  getUserByCode(code) {
    if (!code) return null;
    return this.q.getByCode.get(String(code).toUpperCase()) || null;
  }

  /* ---------- 资料 / 云存档 ---------- */
  /* ---------- 玩家 ---------- */
  /* 头像：预设 id（a01…）或自定义 dataURL。dataURL 可能很长，统一截断防止撑爆字段与榜单响应 */
  setAvatar(deviceId, avatarId) {
    this.q.updateAvatar.run(String(avatarId || '').slice(0, 20000), Date.now(), deviceId);
  }

  /* 个性签名（路由层已清洗控制字符并截断） */
  setBio(deviceId, bio) {
    this.q.updateBio.run(String(bio || ''), Date.now(), deviceId);
  }

  /* 佩戴中的称号（存称号 id，如 tt_top_holdem；空串表示未佩戴） */
  setTitle(deviceId, titleId) {
    this.q.updateTitle.run(String(titleId || '').slice(0, 32), Date.now(), deviceId);
  }
  titleOf(deviceId) {
    try { const p = this.getPlayer(deviceId); return (p && p.title) || ''; } catch (e) { return ''; }
  }

  /* ---------- 金币邮箱（兑换码/邀请/管理员补发的统一发放通道） ---------- */
  addMailbox(deviceId, coins) {
    var n = Math.max(0, Math.min(1000000, Math.floor(Number(coins) || 0)));
    if (!n) return 0;
    this.ensurePlayer(String(deviceId), '牌友');   /* 首次出现的设备先建档，否则 UPDATE 落空 */
    this.db.prepare('UPDATE players SET mailbox_coins = mailbox_coins + ? WHERE device_id = ?').run(n, String(deviceId));
    return n;
  }
  takeMailbox(deviceId) {
    var p = this.getPlayer(deviceId);
    if (!p) return 0;
    var n = Math.max(0, Math.floor(Number(p.mailbox_coins) || 0));
    this.db.prepare('UPDATE players SET mailbox_coins = 0 WHERE device_id = ?').run(String(deviceId));
    return n;
  }
  listPlayersBrief(limit) {
    return this.db.prepare('SELECT device_id, nickname, mailbox_coins, last_seen FROM players ORDER BY last_seen DESC LIMIT ?')
      .all(Math.min(200, limit || 100));
  }
  mailboxOf(deviceId) {
    var p = this.getPlayer(deviceId);
    return p ? Math.max(0, Math.floor(Number(p.mailbox_coins) || 0)) : 0;
  }
  /* ---------- 兑换码 ---------- */
  createCode(code, coins, maxUses) {
    try {
      this.db.prepare('INSERT INTO redeem_codes (code, coins, max_uses, used_count, created_at) VALUES (?, ?, ?, 0, ?)')
        .run(String(code), Math.max(1, Math.floor(coins)), Math.max(1, Math.floor(maxUses)), Date.now());
      return true;
    } catch (e) { return false; }
  }
  codeInfo(code) {
    return this.db.prepare('SELECT * FROM redeem_codes WHERE code = ?').get(String(code)) || null;
  }
  listCodes(limit) {
    return this.db.prepare('SELECT * FROM redeem_codes ORDER BY created_at DESC LIMIT ?').all(Math.min(100, limit || 20));
  }
  /* 兑换：每设备每码一次；成功返回 coins，失败返回 0 */
  redeemCode(code, deviceId) {
    var c = this.codeInfo(code);
    if (!c) return 0;
    if (c.used_count >= c.max_uses) return 0;
    var dup = this.db.prepare('SELECT 1 FROM code_redemptions WHERE code = ? AND device_id = ?').get(String(code), String(deviceId));
    if (dup) return 0;
    this.db.prepare('INSERT INTO code_redemptions (code, device_id, redeemed_at) VALUES (?, ?, ?)').run(String(code), String(deviceId), Date.now());
    this.db.prepare('UPDATE redeem_codes SET used_count = used_count + 1 WHERE code = ?').run(String(code));
    return this.addMailbox(deviceId, c.coins);
  }
  /* ---------- 邀请 ---------- */
  recordInvite(referrer, invitee) {
    try {
      this.db.prepare('INSERT OR IGNORE INTO invites (referrer, invitee, created_at) VALUES (?, ?, ?)')
        .run(String(referrer), String(invitee), Date.now());
      return true;
    } catch (e) { return false; }
  }
  inviteExists(invitee) {
    return !!this.db.prepare('SELECT 1 FROM invites WHERE invitee = ?').get(String(invitee));
  }

  /* ---------- 账号（用户名 + 密码） ---------- */
  createAccount(username, deviceId, salt, hash) {
    try {
      this.db.prepare('INSERT INTO accounts (username, device_id, pass_salt, pass_hash, created_at, last_login) VALUES (?, ?, ?, ?, ?, 0)')
        .run(String(username), String(deviceId), String(salt), String(hash), Date.now());
      return true;
    } catch (e) { return false; }        /* 用户名或设备已被占用 */
  }
  getAccountByName(username) {
    try { return this.db.prepare('SELECT * FROM accounts WHERE username = ?').get(String(username)) || null; }
    catch (e) { return null; }
  }
  getAccountByDevice(deviceId) {
    try { return this.db.prepare('SELECT * FROM accounts WHERE device_id = ?').get(String(deviceId)) || null; }
    catch (e) { return null; }
  }
  touchLogin(username) {
    try { this.db.prepare('UPDATE accounts SET last_login = ? WHERE username = ?').run(Date.now(), String(username)); } catch (e) {}
  }

  /* ---------- 拉黑 / 举报 ---------- */
  addBlock(deviceId, targetId) {
    if (!deviceId || !targetId || deviceId === targetId) return false;
    this.db.prepare('INSERT OR IGNORE INTO blocks (device_id, target_id, created_at) VALUES (?, ?, ?)')
      .run(String(deviceId), String(targetId), Date.now());
    return true;
  }
  removeBlock(deviceId, targetId) {
    this.db.prepare('DELETE FROM blocks WHERE device_id = ? AND target_id = ?')
      .run(String(deviceId), String(targetId));
    return true;
  }
  listBlocks(deviceId) {
    try {
      return this.db.prepare('SELECT target_id FROM blocks WHERE device_id = ? ORDER BY created_at DESC')
        .all(String(deviceId)).map(r => r.target_id);
    } catch (e) { return []; }
  }
  addReport(deviceId, targetId, reason) {
    if (!deviceId || !targetId || deviceId === targetId) return false;
    this.db.prepare('INSERT INTO reports (device_id, target_id, reason, created_at) VALUES (?, ?, ?, ?)')
      .run(String(deviceId), String(targetId), String(reason || '').slice(0, 40), Date.now());
    return true;
  }
  reportCount(targetId) {
    try {
      const r = this.db.prepare('SELECT COUNT(*) AS n FROM reports WHERE target_id = ?').get(String(targetId));
      return (r && r.n) || 0;
    } catch (e) { return 0; }
  }

  getState(deviceId) {
    const p = this.getPlayer(deviceId);
    if (!p || !p.state_json) return { state: null, updatedAt: 0 };
    try { return { state: JSON.parse(p.state_json), updatedAt: p.state_updated_at || 0 }; }
    catch { return { state: null, updatedAt: 0 }; }
  }

  /* 全量存档上云：返回落库时间戳（客户端记为 cloudSyncedAt，做最后写入胜出） */
  setState(deviceId, stateObj) {
    const now = Date.now();
    this.q.updateState.run(JSON.stringify(stateObj), now, now, deviceId);
    return now;
  }

  rotateRecovery(deviceId) {
    const rc = this._genRecovery();
    this.q.updateRecovery.run(rc, Date.now(), deviceId);
    return rc;
  }

  getRank(deviceId) {
    const p = this.getPlayer(deviceId);
    if (!p) return {};
    try { return JSON.parse(p.rank_json || '{}'); } catch { return {}; }
  }

  getItems(deviceId) {
    const p = this.getPlayer(deviceId);
    if (!p) return {};
    try { return JSON.parse(p.item_json || '{}'); } catch { return {}; }
  }

  setRank(deviceId, rankObj) {
    this.q.updateRank.run(JSON.stringify(rankObj || {}), Date.now(), deviceId);
  }

  setItems(deviceId, itemObj) {
    this.q.updateItem.run(JSON.stringify(itemObj || {}), Date.now(), deviceId);
  }

  setStats(deviceId, statsObj) {
    this.q.updateStats.run(JSON.stringify(statsObj || {}), Date.now(), deviceId);
  }

  /* 用户资料（头像 / 个性签名）：由路由层校验后写入 */
  setProfile(deviceId, profile) {
    const p = profile || {};
    this.q.updateProfile.run(String(p.avatar || '').slice(0, 20000), String(p.bio || ''), Date.now(), deviceId);
  }

  getProfile(deviceId) {
    const p = this.getPlayer(deviceId);
    if (!p) return { avatar: '', bio: '' };
    return { avatar: p.avatar || '', bio: p.bio || '' };
  }

  getStats(deviceId) {
    const p = this.getPlayer(deviceId);
    if (!p) return {};
    try { return JSON.parse(p.stats_json || '{}'); } catch { return {}; }
  }

  /* ---------- 排行榜 ---------- */
  /* 全服榜：按指定游戏的段位分降序 */
  globalBoard(game, limit) {
    const rows = this.q.topByGame.all();
    const list = rows.map(r => ({
      deviceId: r.device_id,
      nickname: r.nickname,
      avatar: r.avatar || 'a01',
      bio: r.bio || '',
      title: r.title || '',
      points: (JSON.parse(r.rank_json || '{}')[game] || {}).points || 0,
      tier: (JSON.parse(r.rank_json || '{}')[game] || {}).tier || 0,
    })).sort((a, b) => b.points - a.points);
    return limit ? list.slice(0, limit) : list;
  }

  /* 好友榜：只含好友 + 自己 */
  friendBoard(deviceId, game) {
    const rows = this.q.getMany.all(deviceId);
    const me = this.getPlayer(deviceId);
    const list = rows.map(r => ({
      deviceId: r.device_id,
      nickname: r.nickname,
      avatar: r.avatar || 'a01',
      bio: r.bio || '',
      points: (JSON.parse(r.rank_json || '{}')[game] || {}).points || 0,
      tier: (JSON.parse(r.rank_json || '{}')[game] || {}).tier || 0,
    }));
    if (me) {
      list.push({
        deviceId,
        nickname: me.nickname,
        avatar: me.avatar || 'a01',
        bio: me.bio || '',
        title: me.title || '',
        points: (JSON.parse(me.rank_json || '{}')[game] || {}).points || 0,
        tier: (JSON.parse(me.rank_json || '{}')[game] || {}).tier || 0,
      });
    }
    return list.sort((a, b) => b.points - a.points);
  }

  /* ---------- 好友 ---------- */
  areFriends(a, b) { return !!this.q.isFriend.get(a, b); }

  addFriend(a, b) {
    const now = Date.now();
    this.q.addFriend.run(a, b, now);
    this.q.addFriend.run(b, a, now);
    this.q.delReq.run(a, b);
    this.q.delReq.run(b, a);
  }

  removeFriend(a, b) {
    this.q.delFriend.run(a, b);
    this.q.delFriend.run(b, a);
  }

  friendsOf(deviceId) { return this.q.listFriends.all(deviceId).map(r => r.friend_id); }

  requestFriend(fromId, toId) {
    if (fromId === toId) return { ok: false, msg: '不能添加自己' };
    if (this.areFriends(fromId, toId)) return { ok: false, msg: '已经是好友' };
    this.q.addReq.run(fromId, toId, Date.now());
    return { ok: true };
  }

  pendingRequests(deviceId) { return this.q.listReqTo.all(deviceId); }

  /* 我发出的、尚未被处理的好友请求（to_id 列表），用于搜索结果标记"已发送" */
  outgoingRequests(deviceId) {
    return this.q.listReqFrom.all(deviceId).map(r => r.to_id);
  }

  /* 按昵称模糊搜索玩家（排除自己）。
     - 参数化查询防注入；
     - 转义用户输入中的 LIKE 通配符 % 与 _，避免被当作模糊匹配；
     - 用 ESCAPE '\\' 让转义符生效。 */
  searchPlayersByNick(nick, excludeId, limit) {
    const esc = String(nick || '').replace(/[\\%_]/g, m => '\\' + m);
    const like = '%' + esc + '%';
    const rows = this.q.searchByNick.all(like, excludeId || '', Math.max(1, Math.min(100, limit || 20)));
    return rows.map(r => ({ deviceId: r.device_id, nickname: r.nickname, avatar: r.avatar || 'a01' }));
  }

  /* ---------- 对局 ---------- */
  recordMatch(m) {
    this.q.addMatch.run(m.game, m.roomCode || null, m.mode, Date.now(), JSON.stringify(m.result || {}));
  }

  matchCount(game) { return this.q.countMatches.get(game).n; }

  close() { try { this.db.close(); } catch {} }
}

module.exports = { Store, GAMES };
