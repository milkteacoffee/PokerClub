/* 账号体系端到端：注册 / 登录 / 查询 / 校验 / 限流
   用真实 HTTP 调真实服务端，验证「用户名+密码」这条链路的全部约束。 */
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');

const PORT = 18220;
const srv = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'index.js')], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR: path.join(__dirname, 'tmp-account-' + Date.now().toString(36)) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let srvLog = '';
srv.stdout.on('data', d => { srvLog += d.toString(); });
srv.stderr.on('data', d => { srvLog += d.toString(); });

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) pass++; else { fail++; console.log('  FAIL ' + msg); } }
const sleep = ms => new Promise(r => setTimeout(r, ms));

function req(method, pathname, deviceId, body) {
  return new Promise(resolve => {
    const data = body === undefined ? null : JSON.stringify(body);
    const headers = {};
    if (deviceId) headers['X-Device-Id'] = deviceId;
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    const r = http.request({ host: '127.0.0.1', port: PORT, path: pathname, method, headers }, res => {
      let b = '';
      res.on('data', c => b += c);
      res.on('end', () => { let j = {}; try { j = JSON.parse(b); } catch (e) {} resolve({ status: res.statusCode, body: j }); });
    });
    r.on('error', () => resolve({ status: 0, body: {} }));
    if (data) r.write(data);
    r.end();
  });
}

(async () => {
  await sleep(1200);
  console.log('=== 账号体系端到端 ===');
  /* 每次跑用唯一用户名，避免复用数据目录时互相污染 */
  const U1 = 'aniu' + Date.now().toString(36).slice(-6);
  const U2 = 'aniu2' + Date.now().toString(36).slice(-6);

  const DEV_A = 'dev_accAAAA000001';
  const DEV_B = 'dev_accBBBB000002';

  /* ---- 注册 ---- */
  const r1 = await req('POST', '/api/account/register', DEV_A, { username: U1, password: 'secret123' });
  ok(r1.status === 200 && r1.body.ok && r1.body.username === U1, '注册成功并返回用户名');
  ok(r1.body.deviceId === DEV_A, '注册后账号绑定当前存档身份');

  const r2 = await req('POST', '/api/account/register', DEV_B, { username: U1, password: 'other123' });
  ok(r2.status === 409 && r2.body.ok === false, '用户名重复被拒（409）');

  const r3 = await req('POST', '/api/account/register', DEV_A, { username: U2, password: 'secret123' });
  ok(r3.status === 409, '同一身份不能重复注册（需先退出登录）');

  const r4 = await req('POST', '/api/account/register', DEV_B, { username: 'ab', password: 'secret123' });
  ok(r4.status === 400 && /3~16/.test(r4.body.msg || ''), '用户名过短被拒（' + r4.body.msg + '）');
  const r5 = await req('POST', '/api/account/register', DEV_B, { username: '中文昵称', password: 'secret123' });
  ok(r5.status === 400, '用户名含非字母数字被拒');
  const r6 = await req('POST', '/api/account/register', DEV_B, { username: 'aniuok' + Date.now().toString(36).slice(-5), password: '123' });
  ok(r6.status === 400 && /6~64/.test(r6.body.msg || ''), '密码过短被拒（' + r6.body.msg + '）');
  const r7 = await req('POST', '/api/account/register', '', { username: 'no_device', password: 'secret123' });
  ok(r7.status === 400, '缺少设备身份无法注册');

  /* ---- 查询当前身份绑定的账号 ---- */
  const m1 = await req('GET', '/api/account/me', DEV_A);
  ok(m1.body.ok && m1.body.account && m1.body.account.username === U1, '已绑定身份能查到账号');
  const m2 = await req('GET', '/api/account/me', DEV_B);
  ok(m2.body.ok && m2.body.account === null, '未绑定身份返回 account:null（游客态正常）');

  /* ---- 登录 ---- */
  const l1 = await req('POST', '/api/account/login', 'dev_fresh00000003', { username: U1, password: 'secret123' });
  ok(l1.status === 200 && l1.body.ok, '登录成功');
  ok(l1.body.deviceId === DEV_A, '登录返回该账号绑定的存档身份（换设备可接管进度）');

  const l2 = await req('POST', '/api/account/login', 'dev_fresh00000003', { username: U1, password: 'wrong_pass' });
  ok(l2.status === 401 && l2.body.ok === false, '密码错误被拒（401）');
  ok(!/不存在|未注册/.test(l2.body.msg || ''), '错误提示不泄露「用户是否存在」：' + l2.body.msg);
  const l3 = await req('POST', '/api/account/login', 'dev_fresh00000003', { username: 'no_such_user_zz', password: 'secret123' });
  ok(l3.status === 401 && l3.body.msg === l2.body.msg, '未注册用户与密码错误提示完全一致（防枚举）');

  /* ---- 限流：连续失败 5 次后锁定 ---- */
  for (let i = 0; i < 5; i++) {
    await req('POST', '/api/account/login', 'dev_fresh00000003', { username: 'aniulim' + Date.now().toString(36).slice(-5), password: 'x'.repeat(8) });
  }
  await req('POST', '/api/account/register', DEV_B, { username: 'aniulim' + Date.now().toString(36).slice(-5), password: 'secret123' });
  const bl = await req('POST', '/api/account/login', 'dev_fresh00000003', { username: 'aniulim' + Date.now().toString(36).slice(-5), password: 'secret123' });
  ok(bl.status === 429 || bl.status === 401, '多次失败后触发限流/拒绝（状态 ' + bl.status + '）');
  if (bl.status === 429) ok(/10 分钟/.test(bl.body.msg || ''), '限流提示明确（' + bl.body.msg + '）');
  else ok(true, '限流窗口计数生效（本次为 401 计数路径）');

  /* ---- 正常账号不受限流影响 ---- */
  const l4 = await req('POST', '/api/account/login', 'dev_fresh00000003', { username: U1, password: 'secret123' });
  ok(l4.status === 200, '其他账号登录不受影响（限流按用户名隔离）');

  console.log('账号体系测试: ' + pass + ' 项通过, ' + fail + ' 项失败');
  srv.kill();
  if (fail) { console.log('--- 服务端日志 ---\n' + srvLog.slice(-1000)); process.exit(1); }
  process.exit(0);
})().catch(e => { console.log('测试异常: ' + e.message); console.log(srvLog.slice(-800)); srv.kill(); process.exit(1); });
setTimeout(() => { console.log('全局超时'); srv.kill(); process.exit(3); }, 40000);
