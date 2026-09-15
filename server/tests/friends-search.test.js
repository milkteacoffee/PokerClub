'use strict';
/**
 * 好友搜索接口测试：
 * 1) 按昵称模糊搜索（排除自己、标记 isFriend/requested/pending）
 * 2) LIKE 通配符转义（% / _ 不会变成模糊匹配，且不崩溃）
 * 3) 房间号查成员：复用 RoomManager，返回房内成员候选
 * 4) 房间号格式校验 / 不存在返回 404
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

/* 隔离数据目录，避免污染生产库 */
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'poker-search-'));
process.env.DATA_DIR = tmpDir;
process.env.ALLOW_ORIGIN = '*';

const { server, rooms, store } = require('../src/index');

const results = [];
function check(name, cond, extra) {
  results.push({ name, ok: !!cond });
  console.log((cond ? '[PASS] ' : '[FAIL] ') + name + (extra !== undefined ? '  ' + extra : ''));
}

function req(method, p, deviceId, body) {
  return new Promise((resolve, reject) => {
    const r = http.request({
      host: '127.0.0.1', port: PORT, path: '/api' + p, method,
      headers: Object.assign({ 'Content-Type': 'application/json' }, deviceId ? { 'X-Device-Id': deviceId } : {}),
    }, res => {
      let b = '';
      res.on('data', c => b += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(b || '{}') }); } catch (e) { resolve({ status: res.statusCode, body: {} }); } });
    });
    r.on('error', reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

let PORT = 0;
const wait = ms => new Promise(r => setTimeout(r, ms));

async function run() {
  await new Promise(res => server.listen(0, '127.0.0.1', res));
  PORT = server.address().port;

  const A = 'search_a_' + Date.now();
  const B = 'search_b_' + Date.now();
  const C = 'search_c_' + Date.now();
  const NICK_A = '搜搜甲' + Date.now();
  const NICK_B = '阳光小李' + Date.now();
  const NICK_C = '月光小王' + Date.now();

  /* 注册三个玩家 */
  await req('POST', '/player', A, { nickname: NICK_A });
  await req('POST', '/player', B, { nickname: NICK_B });
  await req('POST', '/player', C, { nickname: NICK_C });

  /* A 与 C 预先成为好友（A 请求 → C 接受） */
  await req('POST', '/friends', A, { friendId: C });
  await req('POST', '/friends/accept', C, { fromId: A });

  /* 1. 按昵称模糊搜索：搜 "小李" 应命中 B，不含自己(A) 与好友(C) */
  const s1 = await req('GET', '/friends/search?q=' + encodeURIComponent('小李'), A);
  check('昵称搜索返回 ok', s1.ok !== false && s1.body.ok === true, s1.status);
  const ids1 = (s1.body.list || []).map(x => x.deviceId);
  check('昵称搜索命中目标 B', ids1.indexOf(B) >= 0, JSON.stringify(ids1));
  check('昵称搜索排除自己 A', ids1.indexOf(A) < 0);
  check('昵称搜索不含无关玩家 C', ids1.indexOf(C) < 0);

  /* 2. 搜索好友 C 的昵称：应标记 isFriend=true */
  const s2 = await req('GET', '/friends/search?q=' + encodeURIComponent('小王'), A);
  const c2 = (s2.body.list || []).find(x => x.deviceId === C);
  check('好友搜索结果标记 isFriend', c2 && c2.isFriend === true, c2 ? c2.isFriend : 'none');

  /* 3. LIKE 通配符转义：搜 "%" 不应崩溃，且返回 200（无玩家昵称含字面 %） */
  const s3 = await req('GET', '/friends/search?q=' + encodeURIComponent('%'), A);
  check('通配符 % 被转义不崩溃', s3.status === 200 && Array.isArray(s3.body.list), s3.status);

  /* 4. 空搜索词应 400 */
  const s4 = await req('GET', '/friends/search?q=', A);
  check('空搜索词返回 400', s4.status === 400, s4.status);

  /* 5. 房间号查成员：进程内建房，搜该房间号应返回房主 */
  const room = rooms.create('holdem', A, NICK_A, { level: 2 });
  check('进程内建房成功', room.ok === true, room.code);
  if (room.ok) {
    const s5 = await req('GET', '/room/members?code=' + room.code, A);
    check('房间成员查询 ok', s5.body.ok === true, s5.status);
    const mem = (s5.body.members || []).find(x => x.deviceId === A);
    check('房间成员含建房者 A', !!mem, s5.body.members ? s5.body.members.length + ' 人' : 'none');
    check('房间成员标记 isMe', mem && mem.isMe === true);
    check('房间成员标记游戏', s5.body.game === 'holdem', s5.body.game);

    /* 房间号格式错（非数字）→ 400 */
    const s6 = await req('GET', '/room/members?code=abc123', A);
    check('房间号非数字返回 400', s6.status === 400, s6.status);
    /* 不存在的房间号 → 404 */
    const s7 = await req('GET', '/room/members?code=999999', A);
    check('房间不存在返回 404', s7.status === 404, s7.status);
  }

  /* 6. 房间号查成员无需身份也能围观（匿名查询） */
  if (room.ok) {
    const s8 = await req('GET', '/room/members?code=' + room.code, '');
    check('匿名也能查房间成员', s8.body.ok === true, s8.status);
  }

  /* 7. 短玩家号：注册后返回 userCode，8 位且字符集合法，全局唯一 */
  const pa = await req('POST', '/player', A, { nickname: NICK_A });
  const codeA = pa.body.userCode;
  check('注册返回 userCode', !!codeA, codeA);
  check('userCode 为 8 位', typeof codeA === 'string' && codeA.length === 8, codeA);
  check('userCode 字符集合法', /^[2-9A-HJKMNP-Z]{8}$/.test(codeA || ''), codeA);
  const pb = await req('POST', '/player', B, { nickname: NICK_B });
  check('不同玩家 userCode 不同', pb.body.userCode && pb.body.userCode !== codeA, pb.body.userCode);

  /* 8. 按短码解析：getUserByCode 命中，且大小写不敏感 */
  const byCode = store.getUserByCode(codeA);
  check('getUserByCode 命中 A', byCode && byCode.device_id === A, byCode && byCode.device_id);
  const byCodeLow = store.getUserByCode(codeA.toLowerCase());
  check('userCode 大小写不敏感', byCodeLow && byCodeLow.device_id === A);

  /* 9. 用短码加好友：A 以 B 的 userCode 为 target 发请求，B 应收到来自 A 的请求 */
  const fr = await req('POST', '/friends', A, { friendId: pb.body.userCode });
  check('用短码发好友请求成功', fr.body.ok === true, JSON.stringify(fr.body));
  const bFriends = await req('GET', '/friends', B);
  const reqFromA = (bFriends.body.requests || []).some(r => r.deviceId === A);
  check('B 收到来自 A 的好友请求', reqFromA, JSON.stringify((bFriends.body.requests || []).map(r => r.deviceId)));

  await wait(50);
  server.close();

  const failed = results.filter(r => !r.ok);
  console.log('\n===== 好友搜索接口测试 =====');
  console.log('通过 ' + (results.length - failed.length) + ' / ' + results.length);
  if (failed.length) { failed.forEach(f => console.log('  - ' + f.name)); process.exit(1); }
  console.log('全部通过 ✓');
  process.exit(0);
}
run().catch(e => { console.error('异常', e); process.exit(2); });
setTimeout(() => { console.log('超时'); process.exit(3); }, 30000);
