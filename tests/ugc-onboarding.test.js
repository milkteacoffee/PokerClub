/**
 * UGC 处置（举报/拉黑）、新手引导、好友房丝滑化 测试
 * 运行: node tests/ugc-onboarding.test.js
 */
'use strict';
const fs = require('fs');
const assert = require('assert');
const { JSDOM } = require('jsdom');
const html = fs.readFileSync(require('path').join(__dirname, '../index.html'), 'utf8');
const code = html.match(/<script>([\s\S]*?)<\/script>/)[1]
  .replace(/\(function \(\) \{\s*'use strict';/, '')
  .replace(/\}\)\(\);\s*$/, '')
  .replace(/  init\(\);/, '');
const dom = new JSDOM(html.replace(/<script>[\s\S]*?<\/script>/, ''), { url: 'https://ugc.test', runScripts: 'outside-only' });
const w = dom.window;
w.setTimeout = () => 0;
w.requestAnimationFrame = () => 0;
w.eval(code);
w.loadAllSaves();

const doc = w.document;
let n = 0;
function test(name, fn) { fn(); n++; console.log('PASS ' + name); }
const FRESH = () => { w.createNewSaveAt(1); w.player.blocks = []; w.player.onboarded = false; w.player.coins = 500; w.player.totalHands = 0; w.player.games = {}; };

/* ---------------- 18+ 适龄提示 ---------------- */
test('大厅页脚含 18+ 适龄提示', () => {
  const clone = doc.body.cloneNode(true);
  clone.querySelectorAll('script,style').forEach(e => e.remove());
  assert.ok(clone.innerHTML.indexOf('仅限 18 岁以上') >= 0, '页脚应有 18+ 提示');
  assert.ok(clone.innerHTML.indexOf('不可充值兑现') >= 0, '不可充值兑现声明仍在');
});

/* ---------------- 举报 / 拉黑 ---------------- */
test('拉黑名单：本地即时生效且可解除', () => {
  FRESH();
  assert.deepEqual(w.blockList(), [], '初始无拉黑');
  assert.equal(w.isBlocked('dev-x'), false, '默认未拉黑');
  w.setBlocked('dev-x', true);
  assert.equal(w.isBlocked('dev-x'), true, '拉黑后生效');
  assert.ok(w.blockList().indexOf('dev-x') >= 0, '名单中有该设备');
  w.setBlocked('dev-x', true);
  assert.equal(w.blockList().filter(x => x === 'dev-x').length, 1, '重复拉黑不重复写入');
  w.setBlocked('dev-x', false);
  assert.equal(w.isBlocked('dev-x'), false, '可解除拉黑');
});

test('不能拉黑自己；空目标被忽略', () => {
  FRESH();
  const me = w.onlineDeviceId();
  assert.equal(w.setBlocked(me, true), false, '拒绝拉黑自己');
  assert.equal(w.setBlocked('', true), false, '空目标被忽略');
  assert.equal(w.isBlocked(me), false, '自己从未被拉黑');
});

test('举报原因齐全且无自由文本', () => {
  FRESH();
  assert.ok(Array.isArray(w.REPORT_REASONS) && w.REPORT_REASONS.length === 4, '4 类举报原因');
  w.REPORT_REASONS.forEach(r => assert.ok(typeof r === 'string' && r.length >= 4, '原因文案完整: ' + r));
});

test('玩家菜单：可打开、可选原因、可返回', () => {
  FRESH();
  w.openPlayerMenu('dev-target', '捣乱的人', 'a05', '德扑 · 房号 123456');
  assert.ok(doc.getElementById('ovPMenu').classList.contains('show'), '玩家菜单打开');
  assert.ok(doc.getElementById('pmHead').textContent.indexOf('捣乱的人') >= 0, '菜单显示玩家昵称');
  assert.ok(!!doc.getElementById('pmReport') && !!doc.getElementById('pmBlock'), '有举报与拉黑按钮');
  doc.getElementById('pmReport').click();
  assert.equal(doc.getElementById('pmBody').querySelectorAll('[data-reason]').length, 4, '展开 4 个举报原因');
  doc.getElementById('pmBody').querySelector('[data-reason]').click();
  assert.ok(doc.getElementById('pmBody').textContent.indexOf('举报已提交') >= 0, '提交后给出反馈');
});

test('菜单里的拉黑按钮：拉黑后按钮变为解除', () => {
  FRESH();
  w.openPlayerMenu('dev-target2', '又一个', 'a06', '');
  doc.getElementById('pmBlock').click();
  assert.equal(w.isBlocked('dev-target2'), true, '点击后拉黑生效');
  assert.ok(doc.getElementById('pmBlock').textContent.indexOf('解除拉黑') >= 0, '按钮文案切换为解除');
  doc.getElementById('pmBlock').click();
  assert.equal(w.isBlocked('dev-target2'), false, '再次点击解除拉黑');
});

test('打不开自己的菜单、空目标不打开', () => {
  FRESH();
  w.openPlayerMenu(w.onlineDeviceId(), '我', 'a01', '');
  assert.ok(!doc.getElementById('ovPMenu').classList.contains('show'), '自己不弹菜单');
  w.openPlayerMenu('', '无名', 'a01', '');
  assert.ok(!doc.getElementById('ovPMenu').classList.contains('show'), '空目标不弹菜单');
});

test('联机座位点击入口与已拉黑占位已接入', () => {
  assert.ok(/\.ost/.test(code) && code.indexOf("closest('.ost')") > 0, '座位卡点击已绑定玩家菜单');
  assert.ok(code.indexOf('已屏蔽玩家') > 0, '被拉黑玩家在座位上显示占位');
  assert.ok(code.indexOf("sbox.__pmBound") > 0, '座位委托只绑定一次');
});

test('房间座位下发 deviceId（举报/拉黑依赖）', () => {
  const rooms = fs.readFileSync(require('path').join(__dirname, '../server/src/rooms.js'), 'utf8');
  assert.ok(/seatInfo = this\.seats\.map\([\s\S]{0,200}deviceId: s\.deviceId/.test(rooms), 'seatInfo 带 deviceId');
  const store = fs.readFileSync(require('path').join(__dirname, '../server/src/store.js'), 'utf8');
  assert.ok(/CREATE TABLE IF NOT EXISTS blocks/.test(store), 'blocks 表已建');
  assert.ok(/CREATE TABLE IF NOT EXISTS reports/.test(store), 'reports 表已建');
  const idx = fs.readFileSync(require('path').join(__dirname, '../server/src/index.js'), 'utf8');
  assert.ok(idx.indexOf("path === '/api/blocks'") > 0, '/api/blocks 路由存在');
  assert.ok(idx.indexOf("path === '/api/report'") > 0, '/api/report 路由存在');
});

/* ---------------- 新手引导 ---------------- */
test('首启需要引导，老存档与已看过的不打扰', () => {
  FRESH();
  assert.equal(w.needsOnboarding(), true, '新档首启需要引导');
  w.player.onboarded = true;
  assert.equal(w.needsOnboarding(), false, '标记已看过则不再引导');
  FRESH(); w.player.coins = 1200;
  assert.equal(w.needsOnboarding(), false, '金币变动过的老档不打扰');
  FRESH(); w.player.totalHands = 3;
  assert.equal(w.needsOnboarding(), false, '有对局记录的老档不打扰');
});

test('引导三步：高亮目标、可跳过、结束落库并开始游戏', () => {
  FRESH();
  w.showOnboarding();
  assert.ok(doc.querySelector('.ob-mask') && doc.querySelector('.ob-card'), '引导遮罩与卡片出现');
  assert.ok(doc.querySelector('.ob-high'), '有高亮目标元素');
  assert.ok(doc.querySelector('.ob-card .t').textContent.indexOf('第一步') >= 0, '显示第一步');
  doc.getElementById('obNext').click();
  assert.ok(doc.querySelector('.ob-card .t').textContent.indexOf('第二步') >= 0, '进入第二步');
  doc.getElementById('obNext').click();
  assert.ok(doc.querySelector('.ob-card .t').textContent.indexOf('第三步') >= 0, '进入第三步');
  assert.equal(doc.querySelectorAll('.ob-dots i.on').length, 1, '进度点跟随');
  doc.getElementById('obNext').click();
  assert.equal(doc.querySelector('.ob-mask'), null, '结束后遮罩被清理');
  assert.equal(w.player.onboarded, true, '标记已看过引导（不再重复弹出）');
});

test('引导可跳过', () => {
  FRESH();
  w.showOnboarding();
  doc.getElementById('obSkip').click();
  assert.equal(doc.querySelector('.ob-mask'), null, '跳过也清理遮罩');
  assert.equal(w.player.onboarded, true, '跳过同样记为已看过');
});

/* ---------------- 好友房丝滑化 ---------------- */
test('好友房：全员准备后自动开局 / 重连提示条', () => {
  assert.ok(doc.getElementById('odReconnect'), '重连提示条元素存在');
  assert.ok(code.indexOf('Online.autoStartAt') > 0, '自动开局倒计时已接入');
  assert.ok(code.indexOf("onlineSend('start', {})") > 0, '自动开局调用与手动开局同一条指令');
  assert.ok(code.indexOf('连接已断开 · 正在重连…') > 0, '掉线提示文案存在');
  assert.ok(code.indexOf('已重连') > 0, '重连成功提示存在');
});

console.log('\nUGC 处置与新手引导测试: ' + n + ' 项通过, 0 项失败');
process.exit(0);
