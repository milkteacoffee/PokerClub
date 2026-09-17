'use strict';
/**
 * 好友房自定义参数（对标欢乐斗地主「开设房间」）：
 *   1) 人数上限真实生效（第 N+1 人加入被拒、提示人数房）
 *   2) 局数真实生效（打满标记 → 房主再开自动进入新一轮，计数清零）
 *   3) 视图下发参数（等待页 maxPlayers/rounds，对局中 round.no/total）
 * 纯逻辑单测：直接实例化 RoomManager，不需要起服务与 WS。
 */
const assert = require('assert');
const { RoomManager } = require('../src/rooms.js');

let n = 0;
function test(name, fn) { fn(); n++; console.log('PASS ' + name); }

/* 极简 store 桩：room 只用到 recordMatch / getPlayer */
const store = {
  recordMatch() {},
  getPlayer() { return { nickname: '牌友', avatar: 'a01', rank: 0 }; },
  getRank() { return 0; },
};

function newRoom(game, opts) {
  const rm = new RoomManager(store);
  const r = rm.create(game, 'devA', '房主', opts);
  assert(r.ok, '建房应成功：' + (r.msg || ''));
  return { rm, room: r.room, code: r.code };
}

test('人数上限：3 人房第 4 人被拒，提示含人数', () => {
  const { room } = newRoom('holdem', { maxPlayers: 3 });
  assert.equal(room.maxPlayers(), 3, '人数上限应为设定值');
  assert(room.join('devB', '乙', null).ok);
  assert(room.join('devC', '丙', null).ok);
  const r4 = room.join('devD', '丁', null);
  assert.equal(r4.ok, false, '第 4 人不应能加入 3 人房');
  assert(/房间已满/.test(r4.msg) && /3 人房/.test(r4.msg), '提示应写明人数：' + r4.msg);
});

test('人数上限夹在玩法区间内：德州最多 6、掼蛋固定 4', () => {
  const { room: holdem } = newRoom('holdem', { maxPlayers: 99 });
  assert.equal(holdem.maxPlayers(), 6, '德州上限应被夹到 6');
  const { room: gd } = newRoom('guandan', { maxPlayers: 2 });
  assert.equal(gd.maxPlayers(), 4, '掼蛋应夹到 4 人');
  assert.equal(gd.join('b', 'b', null) === undefined, false, 'join 返回对象');
});

test('未设人数上限时用玩法默认上限', () => {
  const { room } = newRoom('gold', {});
  assert.equal(room.maxPlayers(), 6, '炸金花默认 6 人');
});

test('局数：打满后 roundEnded 置位，再开新一轮计数清零', () => {
  const { room } = newRoom('holdem', { rounds: 2, maxPlayers: 2 });
  assert(room.join('devB', '乙', null).ok, '第二人应能加入 2 人房');
  assert.equal(room.roundTotal(), 2);
  assert.equal(room.roundNo, 0);
  room._settle({ game: 'holdem' });
  assert.equal(room.roundNo, 1);
  assert.equal(room.roundEnded, false, '第 1 局后不应结束');
  room._settle({ game: 'holdem' });
  assert.equal(room.roundNo, 2);
  assert.equal(room.roundEnded, true, '第 2 局打满应标记本轮结束');
  /* 结算下发后房间回等待态（回归：此前 started 不复位，第二局永远开不了） */
  room.backToWaiting();
  assert.equal(room.started, false, '结算后应回到未开始态');
  assert.equal(room.state, null, '结算后应清空牌局状态');
  assert(room.seats.every(s => s.ready), '斗地主式：结算后默认全员继续（已准备）');
  assert.equal(room.canStart().ok, true, '房主此时应能开下一局');
  const r = room.start();
  assert.equal(r.ok, true, '新一轮应能开始：' + (r.msg || ''));
  assert.equal(room.roundNo, 0, '开新一轮应清零局数');
  assert.equal(room.roundEnded, false, '开新一轮应清除结束标记');
});

test('局数「不限」时不置结束标记', () => {
  const { room } = newRoom('gold', { rounds: 0, maxPlayers: 2 });
  assert.equal(room.roundTotal(), 0);
  room._settle({ game: 'gold' });
  room._settle({ game: 'gold' });
  room._settle({ game: 'gold' });
  assert.equal(room.roundEnded, false, '不限局数不应结束');
});

test('等待视图下发房间参数，对局视图下发局数进度', () => {
  const { room } = newRoom('holdem', { maxPlayers: 4, rounds: 6 });
  const w = room.viewFor('devA');
  assert.equal(w.waiting, true);
  assert.equal(w.maxPlayers, 4, '等待页应带人数上限');
  assert.equal(w.rounds, 6, '等待页应带局数');
  assert.equal(w.roundNo, 0, '等待页应带已完成局数');
  /* 模拟开局后的对局视图 */
  room.state = { players: [], turn: -1, stage: 0, pot: 0, board: [], done: false, round: 1 };
  room.started = true;
  room.adapter.publicView = () => ({ game: 'holdem' });
  const v = room.viewFor('devA');
  assert(v.roundInfo && v.roundInfo.no === 1 && v.roundInfo.total === 6, '对局视图应显示第 1/6 局（字段名 roundInfo，避免与玩法 round 冲突）：' + JSON.stringify(v.roundInfo));
});

console.log('好友房参数测试: ' + n + ' 项通过, 0 项失败');
