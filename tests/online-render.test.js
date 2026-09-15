/**
 * 联机牌桌「真实渲染」测试：真 jsdom 加载 index.html，用 Online.renderState 注入 mock state，
 * 断言椭圆桌布局、座位定位、手牌、积分文案、倒计时与行动高亮真的渲染出来。
 * 运行: node tests/online-render.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const errors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', e => { if (!/Not implemented|clipboard/.test(e.message)) errors.push(e.message); });

let pass = 0, fail = 0;
const failures = [];
function ok(c, m) { if (c) pass++; else { fail++; failures.push(m); } }

const seats2 = [
  { seat: 0, name: '玩家', avatar: 'a01', bio: '签名A', online: true, ready: true },
  { seat: 1, name: '大魔王', avatar: 'a05', bio: '', online: true, ready: true },
];

(async () => {
  const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://localhost/', virtualConsole: vc });
  try {
    await new Promise(r => dom.window.addEventListener('load', r, { once: true }));
    const w = dom.window, d = w.document;
    const $ = i => d.getElementById(i);
    ok(typeof w.Online === 'object' && typeof w.Online.renderState === 'function', 'Online.renderState 调试/测试入口已暴露');

    w.Online.seat = 0;
    w.Online.code = '524632';
    w.Online.game = 'holdem';

    /* ---------- 德州：椭圆桌 ---------- */
    w.Online.renderState({
      game: 'holdem', stage: 'flop', turn: 1, done: false, board: ['Ah', 'Kd', '7c'], pot: 120,
      currentBet: 20, minRaise: 20, turnLeftMs: 24000, seatInfo: seats2,
      players: [
        { seat: 0, name: '玩家', chips: 980, bet: 20, hole: ['As', 'Kh'], folded: false },
        { seat: 1, name: '大魔王', chips: 980, bet: 20, hole: ['??', '??'], folded: false },
      ],
      history: [{ seat: 0, action: 'call' }],
    });
    await new Promise(r => setTimeout(r, 30));

    ok($('onlineScreen').classList.contains('active'), '德州 state → 联机屏激活');
    ok($('odTable').hidden === false, '桌面容器显示');
    ok($('odWaiting').hidden === true, '等待视图隐藏');
    ok($('odSeats').querySelectorAll('.ost').length === 2, '2 个椭圆席位渲染（实际 ' + $('odSeats').querySelectorAll('.ost').length + '）');
    const ost0 = $('odSeats').querySelector('.ost');
    ok(/left:\s*50(\.0)?%/.test(ost0.getAttribute('style')), '自己（座位0）水平居中：' + ost0.getAttribute('style'));
    ok(/top:\s*(8[7-9]|9\d)/.test(ost0.getAttribute('style')), '自己在底部：' + ost0.getAttribute('style'));
    ok($('odSeats').querySelectorAll('.ost .odav svg').length === 2, '每个座位都渲染头像 SVG');
    ok($('odSeats').querySelectorAll('.ost.turn').length === 1, '当前行动方只有一个高亮座位');
    ok($('odSeats').querySelector('.ost.turn').querySelector('.odav'), '高亮座位带头像容器');
    ok($('odPot').textContent.indexOf('分') > 0, '底池按积分展示：' + $('odPot').textContent);
    ok($('odBoard').innerHTML.indexOf('翻牌圈') > 0, '中央显示阶段文案');
    ok($('odBoard').querySelectorAll('.od-card').length === 3, '中央渲染 3 张公共牌');
    ok($('odHand').querySelectorAll('.od-card').length === 2, '自己底牌大牌展示 2 张');
    ok($('odSeats').querySelectorAll('.ost-timer').length === 2, '每个座位都有思考倒计时槽');
    ok(/剩 \d+ 秒/.test($('odTurn').textContent), '行动方倒计时已写入回合文案：' + $('odTurn').textContent);
    ok($('odActions').querySelectorAll('.online-btn').length === 3, '德州操作按钮 3 个（弃牌/跟注/加注）');
    ok($('odActions').querySelector('#odFold') && $('odActions').querySelector('#odFold').disabled === true, '非我方回合时操作按钮禁用');
    ok($('odRoom').textContent.indexOf('积分欢乐局') > 0, '房号栏标明积分欢乐局');

    /* ---------- 炸金花 ---------- */
    w.Online.game = 'gold';
    w.Online.renderState({
      game: 'gold', round: 3, unit: 50, base: 50, maxUnit: 200, pot: 300, cost: 100, turn: 0, done: false, turnLeftMs: 29000,
      seatInfo: seats2, log: [{ seat: 1, text: '跟注' }],
      players: [
        { seat: 0, name: '玩家', chips: 700, hand: ['As', 'Kh', '9d'], seen: true, paid: 150, folded: false },
        { seat: 1, name: '大魔王', chips: 700, hand: ['??', '??', '??'], seen: false, paid: 150, folded: false },
      ],
    });
    await new Promise(r => setTimeout(r, 30));
    ok($('odSeats').querySelectorAll('.ost').length === 2, '金花 2 席渲染');
    ok($('odHand').querySelectorAll('.od-card').length === 3, '金花自己 3 张牌大牌展示');
    ok($('odPot').textContent.indexOf('分') > 0, '金花底池按积分展示');
    ok($('odBoard').textContent.indexOf('可比牌') > 0, '第 3 轮提示可比牌');
    ok($('odActions').querySelector('#odGCall') && $('odActions').querySelector('#odGCall').disabled === false, '我方回合按钮可用');

    /* ---------- 骰子比大小 ---------- */
    w.Online.game = 'diceduel';
    w.Online.renderState({
      game: 'diceduel', turn: 1, done: false, pot: 200, turnLeftMs: 12000, seatInfo: seats2, log: [],
      players: [
        { seat: 0, name: '玩家', dice: [3, 5, 6], sum: 14, triple: false },
        { seat: 1, name: '大魔王', dice: null, sum: 0, triple: false },
      ],
    });
    await new Promise(r => setTimeout(r, 30));
    ok($('odSeats').querySelectorAll('.ost').length === 2, '骰子 2 席渲染');
    ok($('odSeats').textContent.indexOf('14 点') > 0, '骰子座位显示点数');
    ok($('odSeats').textContent.indexOf('未掷') > 0, '未掷玩家显示「未掷」');
    ok($('odActions').querySelector('#odRoll').disabled === true, '非我方回合掷骰按钮禁用');

    /* ---------- 掼蛋：4 人固定方位 你/右/上/左 ---------- */
    w.Online.game = 'guandan';
    w.Online.renderState({
      game: 'guandan', level: 5, moves: 8, turn: 0, done: false, turnLeftMs: 27000,
      seatInfo: [
        { seat: 0, name: '玩家', avatar: 'a01', bio: '', online: true },
        { seat: 1, name: '右敌', avatar: 'a02', bio: '', online: true },
        { seat: 2, name: '队友', avatar: 'a03', bio: '', online: true },
        { seat: 3, name: '左敌', avatar: 'a04', bio: '', online: true },
      ],
      handCounts: [27, 27, 27, 26],
      myHand: [{ r: 5, s: 0, id: '5s-1' }, { r: 14, s: 1, id: '14h-2' }],
      last: { text: '对子 A' }, leader: 1, passed: [], log: [{ seat: 1, text: '对子 A' }],
    });
    await new Promise(r => setTimeout(r, 30));
    ok($('odSeats').querySelectorAll('.ost').length === 4, '掼蛋 4 席渲染（实际 ' + $('odSeats').querySelectorAll('.ost').length + '）');
    const sts = Array.from($('odSeats').querySelectorAll('.ost')).map(e => e.getAttribute('style'));
    ok(/top:\s*(8[0-9]|9\d)(\.\d+)?%/.test(sts[0]), '掼蛋：自己在下 ' + sts[0]);
    ok(/left:\s*(8[5-9]|9\d)(\.\d+)?%/.test(sts[1]), '掼蛋：座位1 在右侧 ' + sts[1]);
    ok(/top:\s*(\d|1[0-5])(\.\d+)?%/.test(sts[2]), '掼蛋：座位2（队友）在上方 ' + sts[2]);
    ok(/left:\s*(\d|1[0-5])(\.\d+)?%/.test(sts[3]), '掼蛋：座位3 在左侧 ' + sts[3]);
    ok($('odSeats').textContent.indexOf('队友') > 0, '掼蛋标注队友');
    ok($('odSeats').textContent.indexOf('剩 26 张') > 0, '掼蛋显示剩牌数');
    ok($('odHand').querySelectorAll('.od-hcard').length === 2, '掼蛋手牌渲染');
    ok($('odBoard').textContent.indexOf('对子 A') > 0, '中央显示上一手牌型');
    ok($('odActions').querySelector('#odPlay') && $('odActions').querySelector('#odPlay').disabled === false, '我方回合可出牌');

    /* ---------- 无致命错误 ---------- */
    ok(errors.length === 0, '渲染过程无致命脚本错误：' + errors.slice(0, 3).join(' | '));
  } catch (e) {
    fail++; failures.push('测试异常: ' + e.message);
  }
  try { dom.window.close(); } catch (e) {}

  console.log('联机牌桌渲染测试: ' + pass + ' 项通过, ' + fail + ' 项失败');
  if (fail) { failures.slice(0, 15).forEach(f => console.log('  - ' + f)); process.exit(1); }
  process.exit(0);
})();
