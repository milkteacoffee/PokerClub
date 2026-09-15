/**
 * 联机牌桌布局（椭圆桌）+ 积分化 + 思考倒计时 测试
 * 说明：渲染函数在嵌套 IIFE 内不可直接调用，这里用「抽取函数源码 + 独立求值」的方式
 *      单测纯逻辑（座位几何、积分文案），并对结构/样式做静态断言。
 * 运行: node tests/online-table-layout.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const code = html.match(/<script>([\s\S]*?)<\/script>/)[1];

/* 把指定函数声明源码抽出来，在独立作用域求值，返回该函数 */
function grab(name) {
  const re = new RegExp('function ' + name + '\\s*\\([\\s\\S]*?\\n\\}', 'm');
  const m = code.match(re);
  if (!m) throw new Error('未找到函数 ' + name);
  return new Function('window', 'fmt', m[0] + '; return ' + name + ';')({ innerWidth: 900 }, n => String(n));
}

let n = 0, fail = 0;
function ok(c, m) { if (c) { n++; console.log('PASS ' + m); } else { fail++; console.log('FAIL ' + m); } }

/* ---------------- 座位几何 ---------------- */
const seatPos = grab('onlineSeatPos');

ok(typeof seatPos === 'function', 'onlineSeatPos 存在且可独立求值');

/* 2 人：自己在下、对手在上 */
(function () {
  const p = seatPos(2, 0);
  ok(p.length === 2, '2 人 → 2 个座位');
  ok(Math.abs(p[0].x - 50) < 0.01 && p[0].y > 80, '自己固定在底部中央（' + p[0].x.toFixed(1) + '%/' + p[0].y.toFixed(1) + '%）');
  ok(Math.abs(p[1].x - 50) < 0.01 && p[1].y < 20, '2 人对手在顶部（' + p[1].y.toFixed(1) + '%）');
})();

/* 4 人：你(下) → 右 → 上(队友) → 左（顺时针，掼蛋语义） */
(function () {
  const p = seatPos(4, 0);
  ok(p.length === 4, '4 人 → 4 个座位');
  ok(p[1].x > 85 && Math.abs(p[1].y - 50) < 0.01, '座位 1 在正右（' + p[1].x.toFixed(1) + '%）');
  ok(Math.abs(p[2].x - 50) < 0.01 && p[2].y < 20, '座位 2 在正上（队友位）');
  ok(p[3].x < 15 && Math.abs(p[3].y - 50) < 0.01, '座位 3 在正左（' + p[3].x.toFixed(1) + '%）');
})();

/* 自己坐哪个座位都在底部（视角跟随） */
(function () {
  for (let my = 0; my < 4; my++) {
    const p = seatPos(4, my);
    ok(p[my].y > 80 && Math.abs(p[my].x - 50) < 0.01, '自己坐座位 ' + my + ' 时仍在底部中央');
  }
})();

/* 6 人：均匀分布且没有座位压在正中央 */
(function () {
  const p = seatPos(6, 0);
  ok(p.length === 6, '6 人 → 6 个座位');
  ok(p.every(q => Math.abs(q.x - 50) > 12 || Math.abs(q.y - 50) > 12), '6 人无座位落在桌面正中');
  ok(p.every(q => q.x >= 0 && q.x <= 100 && q.y >= 0 && q.y <= 100), '所有座位都在可视范围内');
  ok(p[0].y > 80, '6 人时自己仍在底部');
})();

/* 5 人：奇数人也对称 */
(function () {
  const p = seatPos(5, 0);
  ok(p.length === 5 && p.every(q => q.y >= 0 && q.y <= 100), '5 人座位合法');
  ok(p[0].y > 80, '5 人时自己仍在底部');
})();

/* 窄屏用不同椭圆比例 */
(function () {
  const f = grab('onlineSeatPos');
  const wide = new Function('window', 'fmt', code.match(/function onlineSeatPos\s*\([\s\S]*?\n\}/)[0] + '; return onlineSeatPos;')({ innerWidth: 1024 }, String);
  const narrow = new Function('window', 'fmt', code.match(/function onlineSeatPos\s*\([\s\S]*?\n\}/)[0] + '; return onlineSeatPos;')({ innerWidth: 380 }, String);
  ok(narrow(4, 0)[2].y < wide(4, 0)[2].y, '窄屏椭圆更高（顶部座位更靠上），避免与牌区挤压');
})();

/* ---------------- 积分化 ---------------- */
const pts = grab('onlinePts');
ok(pts(0) === '0 分' && pts(1240) === '1240 分', '积分文案统一带「分」后缀（' + pts(1240) + '）');
ok(code.indexOf("onlinePts(st.pot)") > 0, '底池用积分文案');
ok(code.indexOf('积分欢乐局') > 0, '房间与结算标明「积分欢乐局」');
ok(code.indexOf("' 分 · 你的积分 '") > 0, '结算面板按积分展示输赢');

/* ---------------- 思考倒计时 ---------------- */
ok(/setInterval\(function\(\)\{[\s\S]{0,900}?Online\._deadline/.test(code), '存在每秒刷新的倒计时定时器（只改文本不重渲染）');
ok(code.indexOf('turnLeftMs') > 0, '倒计时优先使用服务端下发的剩余毫秒');
ok(/function onlineArmTimer/.test(code) && code.indexOf("Online._turnKey") > 0, 'turn 变化时重新武装倒计时');
ok(/st\.history \? st\.history\.length : 0[\s\S]{0,120}st\.moves/.test(code), '连行动时用「进度」也参与 key，保证倒计时重置');
ok(code.indexOf('即将自动代打') > 0, '倒计时归零提示自动代打');

/* ---------------- 动画与去线框 ---------------- */
ok(/@keyframes odDeal/.test(html), '发牌入场动画 keyframes 存在');
ok(/\.deal\{animation:odDeal/.test(html), '新增牌才带 .deal 动画类（旧牌不重放）');
ok(/i >= prevBoard \? 'deal' : ''/.test(code), '公共牌按「新增」加动画');
ok(/class="ost' \+ \(extraCls/.test(code) || code.indexOf('onlineSeatCard') > 0, '座位卡统一由 onlineSeatCard 生成');
ok(/\.ost\{position:absolute/.test(html), '座位卡绝对定位在椭圆上（不再是列表条）');
ok(!/\.od-seat\{/.test(html), '旧的横条座位样式已移除（.od-seat）');
ok(/\.od-log\{position:absolute/.test(html), '日志改为右上角小字浮层（去底板线框）');
ok(/@media \(max-width:520px\)/.test(html), '窄屏媒体查询已加');

/* ---------------- 服务端字段 ---------------- */
const serverRooms = fs.readFileSync(path.join(__dirname, '../server/src/rooms.js'), 'utf8');
ok(/v\.turnLeftMs = /.test(serverRooms), '服务端 viewFor 下发 turnLeftMs');
ok(/actionTimeoutMs - Date\.now\(\)/.test(serverRooms), '剩余毫秒与自动代打超时同源计算');

console.log('\n联机牌桌布局测试: ' + n + ' 项通过, ' + fail + ' 项失败');
process.exit(fail ? 1 : 0);
