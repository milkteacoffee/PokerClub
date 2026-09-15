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
        stats_json    TEXT NOT NULL DEFAULT '{}'
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
    `);
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
      touch: d.prepare('UPDATE players SET last_seen = ? WHERE device_id = ?'),

      listAllRatings: d.prepare('SELECT device_id,nickname,rank_json,stats_json FROM players WHERE last_seen >= ?'),
      topByGame: d.prepare('SELECT device_id,nickname,rank_json,stats_json FROM players'),

      listFriends: d.prepare('SELECT friend_id FROM friends WHERE device_id = ?'),
      addFriend: d.prepare('INSERT OR IGNORE INTO friends (device_id,friend_id,created_at) VALUES (?,?,?)'),
      delFriend: d.prepare('DELETE FROM friends WHERE device_id = ? AND friend_id = ?'),
      isFriend: d.prepare('SELECT 1 FROM friends WHERE device_id = ? AND friend_id = ?'),
      getMany: d.prepare(`SELECT device_id,nickname,rank_json,stats_json FROM players WHERE device_id IN (SELECT friend_id FROM friends WHERE device_id = ?)`),

      addReq: d.prepare('INSERT OR IGNORE INTO friend_requests (from_id,to_id,created_at) VALUES (?,?,?)'),
      delReq: d.prepare('DELETE FROM friend_requests WHERE from_id = ? AND to_id = ?'),
      listReqTo: d.prepare(`SELECT r.from_id, r.created_at, p.nickname FROM friend_requests r
                            LEFT JOIN players p ON p.device_id = r.from_id WHERE r.to_id = ?`),
      listReqFrom: d.prepare('SELECT to_id, created_at FROM friend_requests WHERE from_id = ?'),
      searchByNick: d.prepare(`SELECT device_id, nickname FROM players
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
    this.q.touch.run(now, deviceId);
    return p;
  }

  getPlayer(deviceId) { return this.q.getPlayer.get(deviceId); }

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
      points: (JSON.parse(r.rank_json || '{}')[game] || {}).points || 0,
      tier: (JSON.parse(r.rank_json || '{}')[game] || {}).tier || 0,
    }));
    if (me) {
      list.push({
        deviceId,
        nickname: me.nickname,
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
    return rows.map(r => ({ deviceId: r.device_id, nickname: r.nickname }));
  }

  /* ---------- 对局 ---------- */
  recordMatch(m) {
    this.q.addMatch.run(m.game, m.roomCode || null, m.mode, Date.now(), JSON.stringify(m.result || {}));
  }

  matchCount(game) { return this.q.countMatches.get(game).n; }

  close() { try { this.db.close(); } catch {} }
}

module.exports = { Store, GAMES };
