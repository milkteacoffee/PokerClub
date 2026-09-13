/**
 * 真实 DOM 冒烟测试（jsdom）
 * 校验：HTML 结构完整、脚本无报错、界面切换与按钮交互可用、渲染内容正确
 * 运行: node tests/dom.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

let pass = 0, fail = 0;
const failures = [];
function ok(c, m) { if (c) pass++; else { fail++; failures.push(m); console.log('  ✗ ' + m); } }

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

/* 静态检查：不能残留占位标记 */
ok(!html.includes('__BODY__'), '无残留 __BODY__ 占位符');
ok(!html.includes('__JS_A__'), '无残留 __JS_A__ 占位符');
ok(!html.includes('__JS_B__'), '无残留 __JS_B__ 占位符');
ok(!/\[content truncated\]/.test(html), '无残留截断标记');
ok((html.match(/<script>/g) || []).length === 1, '恰好一个 <script> 块');
ok(/<\/html>\s*$/.test(html.trim()), 'HTML 正确闭合');

const errors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', e => {
  const msg = String(e && e.message || e);
  if (/Could not parse CSS|Not implemented|Error: Not implemented/.test(msg)) return;
  errors.push('jsdomError: ' + msg);
});
vc.on('error', (...a) => errors.push('console.error: ' + a.join(' ')));
vc.on('warn', (...a) => {
  const s = a.join(' ');
  if (/Not implemented|Could not parse/.test(s)) return;
});

const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  url: 'https://localhost/',
  virtualConsole: vc,
});
const { window } = dom;
const doc = window.document;
const $ = id => doc.getElementById(id);

/* 等待异步初始化 */
function tick(ms) { return new Promise(r => setTimeout(r, ms || 0)); }
function click(el) {
  el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
}

(async function run() {
  await tick(50);

  console.log('【DOM 结构】');
  const ids = ['rotateHint','stage','lobbyScreen','difficultyScreen','gameScreen','table','boardArea',
    'potDisplay','stageBox','seat0','seat1','seat2','seat3','bottomBar','topbar','timerWrapper',
    'screenWarning','toast','ovAchieve','ovTasks','ovHelp','ovGameOver','ovLevelUp','ovExitConfirm',
    'ovStorage','ovNewSaveConfirm','ovDeleteConfirm','slotList','achList','taskListNewbie',
    'taskListDaily','lbStartBtn','diffBody','btnExit'];
  let missing = ids.filter(i => !$(i));
  ok(missing.length === 0, '所有关键元素存在' + (missing.length ? '，缺失: ' + missing.join(',') : ''));

  console.log('【脚本执行】');
  ok(errors.length === 0, '脚本运行无未捕获错误' + (errors.length ? '：' + errors.slice(0, 3).join(' | ') : ''));

  console.log('【大厅渲染】');
  ok($('lbLevel').textContent === 'Lv.1', '初始等级 Lv.1（实际 ' + $('lbLevel').textContent + '）');
  ok($('lbCoins').textContent === '1,000', '初始金币 1,000（实际 ' + $('lbCoins').textContent + '）');
  ok($('lobbyScreen').style.display === 'flex', '大厅默认可见');

  console.log('【进入场次选择】');
  click($('lbStartBtn'));
  await tick(30);
  ok($('difficultyScreen').classList.contains('active'), '点击「开始游戏」进入场次选择');
  const cards = $('diffBody').querySelectorAll('.diff-card');
  ok(cards.length === 4, '渲染 4 个难度卡片（实际 ' + cards.length + '）');
  ok(!!$('diffBody').querySelector('.diff-card.easy'), '包含简单场卡片');
  ok(!!$('diffBody').querySelector('.diff-card.champion'), '包含冠军场卡片');
  const locked = $('diffBody').querySelectorAll('.diff-card.locked');
  ok(locked.length === 3, '金币 1000 时高额场次被锁定（锁定 ' + locked.length + ' 个）');

  console.log('【返回大厅 & 面板】');
  click($('diffBack'));
  await tick(30);
  ok($('lobbyScreen').style.display === 'flex', '返回大厅');

  click($('lbBtnAchieve'));
  await tick(30);
  ok($('ovAchieve').classList.contains('show'), '打开成就面板');
  ok($('achList').querySelectorAll('.ach-item').length === 16,
     '成就列表渲染 16 项（实际 ' + $('achList').querySelectorAll('.ach-item').length + '）');
  ok($('stHands').textContent === '0', '总手数初始为 0');
  click($('ovAchieve').querySelector('[data-close="ovAchieve"]'));
  await tick(20);
  ok(!$('ovAchieve').classList.contains('show'), '关闭成就面板');

  click($('lbBtnTasks'));
  await tick(30);
  ok($('ovTasks').classList.contains('show'), '打开任务面板');
  const nbItems = $('taskListNewbie').querySelectorAll('.task-item');
  ok(nbItems.length === 21, '新手任务渲染 21 项（实际 ' + nbItems.length + '）');
  click($('tabDaily'));
  await tick(30);
  ok($('taskListDaily').style.display === 'block' && $('taskListNewbie').style.display === 'none',
     'Tab 切换到每日任务');
  const dlItems = $('taskListDaily').querySelectorAll('.task-item');
  ok(dlItems.length === 5, '每日任务渲染 5 项（实际 ' + dlItems.length + '）');
  click($('tabNewbie'));
  click($('ovTasks').querySelector('[data-close="ovTasks"]'));
  await tick(20);

  click($('lbBtnStorage'));
  await tick(30);
  ok($('ovStorage').classList.contains('show'), '打开存档面板');
  const slots = $('slotList').querySelectorAll('.slot-item');
  ok(slots.length === 3, '渲染 3 个存档槽（实际 ' + slots.length + '）');
  ok($('slotList').querySelectorAll('.slot-item.active').length === 1, '恰有 1 个当前存档标记');
  ok($('slotList').querySelectorAll('.slot-item.empty').length === 2, '2 个空槽位');
  click($('ovStorage').querySelector('[data-close="ovStorage"]'));
  await tick(20);

  click($('lbQHelp'));
  await tick(20);
  ok($('ovHelp').classList.contains('show'), '打开规则面板');
  click($('ovHelp').querySelector('[data-close="ovHelp"]'));
  await tick(20);

  console.log('【进入牌桌】');
  click($('lbStartBtn'));
  await tick(30);
  click($('diffBody').querySelector('.diff-card.easy'));
  await tick(400);
  ok($('gameScreen').classList.contains('active'), '进入游戏界面');
  ok($('lobbyScreen').style.display === 'none', '大厅已隐藏');
  ok($('topbar').querySelector('#pLevel').textContent === 'Lv.1', '顶栏等级正常');
  ok($('pCoins').textContent === '1,000', '顶栏金币 1,000（实际 ' + $('pCoins').textContent + '）');
  const seats = [0,1,2,3].map(i => $('seat' + i));
  ok(seats.every(s => s.querySelector('.chips')), '4 个座位均渲染了筹码');

  /* 等待发牌完成，人类回合应出现操作按钮 */
  let guard = 0;
  while (guard++ < 600) {
    await tick(25);
    if ($('bottomBar').querySelector('.abtn.fold')) break;
  }
  ok(!!$('bottomBar').querySelector('.abtn.fold'), '人类回合出现「弃牌」按钮');
  ok(!!$('bottomBar').querySelector('.abtn.check, .abtn.call'), '人类回合出现「过牌/跟注」按钮');
  const btns = $('bottomBar').querySelectorAll('.abtn');
  ok(btns.length >= 2, '底栏渲染出操作按钮（' + btns.length + ' 个）');
  ok(!!$('boardArea').querySelectorAll('.card').length, '公共牌区已渲染占位牌');
  ok(!!$('seat0').querySelector('.chips'), '玩家座位显示筹码');
  ok($('potDisplay').classList.contains('show'), '底池数字已显示');

  /* 点击弃牌，验证交互链路 */
  const fold = $('bottomBar').querySelector('.abtn.fold');
  if (fold) {
    click(fold);
    await tick(200);
    ok(!!$('bottomBar').querySelector('.abtn.skip, .abtn.start'),
       '弃牌后出现「跳过本手」或「下一手」按钮');
  }

  /* 退出确认 */
  click($('btnExit'));
  await tick(30);
  ok($('ovExitConfirm').classList.contains('show'), '弹出退出确认');
  click($('exitConfirmYes'));
  await tick(120);
  ok($('lobbyScreen').style.display === 'flex', '退出后回到大厅');

  /* 存档持久化 */
  const raw = window.localStorage.getItem('texas_poker_multi_saves_v1');
  ok(!!raw, '对局后存档已写入 localStorage');
  try {
    const s = JSON.parse(raw);
    ok(s.slots && s.slots[1] && typeof s.slots[1].player.totalHands === 'number',
       '存档含手数统计（' + (s.slots[1].player.totalHands) + ' 手）');
    ok(s.slots[1].player.totalHands >= 1, '本局手数已被记录');
  } catch (e) { ok(false, '存档可解析: ' + e.message); }

  /* 回归：发牌途中直接离桌，不应抛异常（曾因 playHand 发牌循环缺少 G.active 检查而崩溃） */
  click($('lbStartBtn'));
  await tick(30);
  click($('diffBody').querySelector('.diff-card.easy'));
  await tick(150);                       // 正处于发牌阶段
  const dealing = !$('bottomBar').querySelector('.abtn.fold');
  click($('btnExit'));
  await tick(30);
  click($('exitConfirmYes'));
  await tick(600);
  ok($('lobbyScreen').style.display === 'flex', '发牌途中离桌可正常返回大厅');
  ok(errors.length === 0, '发牌途中离桌无未捕获异常'
     + (errors.length ? '：' + errors.slice(0, 3).join(' | ') : '') + '（离桌时' + (dealing ? '正在发牌' : '已进入下注') + '）');

  await tick(50);
  ok(errors.length === 0, '全流程无未捕获错误' + (errors.length ? '：' + errors.slice(0, 3).join(' | ') : ''));

  console.log('\n============================');
  console.log('  通过 ' + pass + ' / 失败 ' + fail);
  console.log('============================');
  if (fail) {
    console.log('\n失败项：');
    failures.forEach(f => console.log('  - ' + f));
    process.exit(1);
  }
  console.log('\n✅ DOM 冒烟测试全部通过');
  process.exit(0);
})().catch(e => {
  console.error('✗ 测试异常:', e);
  process.exit(1);
});
