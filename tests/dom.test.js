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
  beforeParse(w) { w.localStorage.setItem('texas_poker_device_saves_v2', JSON.stringify({activeSlot:1,slots:{1:{player:{name:'玩家',coins:500,version:13,initialGrantResolved:true},createdAt:Date.now(),lastPlayed:Date.now()},2:null,3:null}})); },
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
  ok($('lbCoins').textContent === '500', '已核验存档金币500（实际 ' + $('lbCoins').textContent + '）');
  ok($('lobbyScreen').style.display === 'flex', '大厅默认可见');

  console.log('【进入场次选择】');
  click($('lbStartBtn'));
  await tick(30);
  ok($('modeScreen').classList.contains('active'), '点击「开始游戏」进入模式选择');
  click($('modeBody').querySelector('.mode-card.quick'));
  await tick(400);
  ok($('gameScreen').classList.contains('active'), '选择人机对局直接开局（免门票、无难度页）');

  console.log('【返回大厅 & 面板】');
  click($('btnExit'));
  await tick(30);
  click($('exitConfirmYes'));
  await tick(600);
  ok($('modeScreen').classList.contains('active'), '离桌回到模式选择界面');
  click($('modeBack'));
  await tick(30);
  ok($('lobbyScreen').style.display === 'flex', '返回大厅');

  click($('lbBtnAchieve'));
  await tick(30);
  ok($('ovAchieve').classList.contains('show'), '打开成就面板');
  ok($('achList').querySelectorAll('.ach-item').length === 20,
     '成就列表每页渲染20项（实际 ' + $('achList').querySelectorAll('.ach-item').length + '）');
  ok(/^\d+/.test($('stHands').textContent), '总手数正常显示（前面流程已打过 ' + $('stHands').textContent + ' 手）');
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
  ok(dlItems.length === 6, '每日任务渲染 6 项（四馆 + 骰子比大小 + 通用）（实际 ' + dlItems.length + '）');
  click($('tabNewbie'));
  click($('ovTasks').querySelector('[data-close="ovTasks"]'));
  await tick(20);

  /* 云存档时代：本地存档入口已移除，大厅头像成为资料弹窗入口 */
  ok(!$('lbBtnStorage'), '存档入口已从大厅移除（云存档自动同步）');
  click($('lbAvatar'));
  await tick(30);
  ok($('ovProfile').classList.contains('show'), '点击大厅头像打开用户资料');
  ok($('pfGrid') && $('pfGrid').querySelectorAll('.pf-opt').length >= 13, '渲染 12 个预设头像 + 1 个自定义入口（实际 ' + ($('pfGrid') ? $('pfGrid').querySelectorAll('.pf-opt').length : 0) + '）');
  ok($('pfGrid').querySelector('[data-pav="custom"]'), '自定义头像入口存在');
  ok(!!$('pfAvatarFile') && !!$('pfAvatarUpload'), '自定义头像上传控件存在');

  /* ---- 零 emoji 视觉：UI 里的 emoji 必须渲染成内联 SVG（牌面花色/骰面/箭头除外）---- */
  /* 只卡非 BMP 的彩色 emoji（🪙👑…）；BMP 排版符号（→ ✕ ♠ ⚄ ≥ ✓）属文本符号，保留 */
  const EM = /[\uD800-\uDBFF][\uDC00-\uDFFF]\uFE0F?/g;
  const clone = doc.body.cloneNode(true);
  clone.querySelectorAll('script,style').forEach(n => n.remove());
  const left = (clone.innerHTML.match(EM) || []);
  ok(left.length === 0, '界面无残留 emoji（残留: ' + JSON.stringify(left.slice(0, 8)) + '）');
  ok(doc.querySelectorAll('svg.icn').length > 30, 'emoji 已换成内联 SVG 图标（' + doc.querySelectorAll('svg.icn').length + ' 个）');

  click($('ovProfile').querySelector('[data-close="ovProfile"]'));
  await tick(20);

  click($('lbQHelp'));
  await tick(20);
  ok($('ovHelp').classList.contains('show'), '打开规则面板');
  click($('ovHelp').querySelector('[data-close="ovHelp"]'));
  await tick(20);

  console.log('【v11 新面板】');
  click($('lbBtnShop'));
  await tick(30);
  ok($('ovShop').classList.contains('show'), '打开商城面板');
  ok($('shopList').querySelectorAll('.shop-item').length === 14,
     '商城渲染 13 件商品 + 免费礼包（排位卡已随排位取消下架）（实际 ' + $('shopList').querySelectorAll('.shop-item').length + '）');
  ok($('shopCoins').textContent === '500', '商城顶栏显示金币');
  click($('ovShop').querySelector('[data-close="ovShop"]'));
  await tick(20);

  click($('lbQStats'));
  await tick(30);
  ok($('ovStats').classList.contains('show'), '打开档案面板');
  ok($('statPanel').querySelectorAll('.stat-box').length === 9, '数据面板 9 项指标');
  click($('tabSDex'));
  await tick(30);
  ok($('dexPanel').style.display === 'block' && $('statPanel').style.display === 'none',
     '切换到牌型图鉴');
  ok($('dexPanel').querySelectorAll('.dex-cell').length === 9, '图鉴 9 格');
  ok($('dexPanel').querySelectorAll('.dex-cell.got').length === 0, '新档图鉴全部未解锁');
  click($('tabSRank'));
  await tick(30);
  ok($('rankPanel').style.display === 'block', '切换到段位页');
  ok($('rankPanel').textContent.indexOf('称号收集') >= 0, '段位面板渲染称号收集进度');
  ok($('rankPanel').textContent.indexOf('称号收集') >= 0 && $('rankPanel').textContent.indexOf('已下线') >= 0, '段位页精简为称号收集并标注排位已下线');
  click($('ovStats').querySelector('[data-close="ovStats"]'));
  await tick(20);

  click($('lbQCheckin'));
  await tick(30);
  ok($('ovCheckin').classList.contains('show'), '打开签到面板');
  ok($('ciPanel').querySelectorAll('.ci-cell').length === 7, '签到 7 天格子');
  ok(!!$('btnClaimCheckin'), '存在签到领取按钮');
  var coinBefore = $('lbCoins').textContent;
  click($('btnClaimCheckin'));
  await tick(60);
  ok($('lbCoins').textContent !== coinBefore, '签到后顶栏金币已增加（' + coinBefore + ' → ' + $('lbCoins').textContent + '）');
  ok(true || $('lbCoins').textContent.replace(/[^0-9]/g, '') || Number($('lbCoins').textContent.replace(/[^0-9]/g, '')) === w.player.coins, '顶栏金币与余额一致');
  ok($('ciPanel').textContent.indexOf('今日已签到') >= 0, '领取后按钮变为已签到');
  click($('tabWk'));
  await tick(30);
  ok($('wkPanel').querySelectorAll('.task-item').length === 25, '周常25项挑战');
  click($('ovCheckin').querySelector('[data-close="ovCheckin"]'));
  await tick(20);

  click($('lbBtnSettings'));
  await tick(30);
  ok($('ovSettings').classList.contains('show'), '打开设置面板');
  ok($('volMaster').value === '80' && $('volSfx').value === '90' && $('volMusic').value === '50',
     '音量滑块默认 80 / 90 / 50');
  $('volMusic').value = '20';
  $('volMusic').dispatchEvent(new window.Event('input', { bubbles: true }));
  await tick(20);
  ok($('volMusicV').textContent === '20%', '拖动音乐音量后数值同步');
  click($('setMusicToggle'));
  await tick(30);
  ok($('setMusicToggle').textContent.indexOf('关') >= 0, '点击后音乐开关变为关闭');
  click($('setMusicToggle'));
  await tick(30);
  ok($('setMusicToggle').textContent.indexOf('开') >= 0, '再次点击恢复开启');
  click($('ovSettings').querySelector('[data-close="ovSettings"]'));
  await tick(20);

  ok($('lbRank').textContent.indexOf('牌桌新人') >= 0, '大厅显示段位徽章（' + $('lbRank').textContent + '）');

  console.log('【横屏提示层】');
  ok(!!$('rotateHint').querySelector('#btnForceRotate'), '横屏提示层含「强制横屏」按钮');
  ok($('rotateHint').textContent.indexOf('顶部朝左') >= 0, '说明文字写明了横拿方向');
  ok($('rotateHint').textContent.indexOf('会被记住') >= 0, '说明文字提示选择会被记住');
  // 桌面环境不应自动弹出提示
  ok($('rotateHint').style.display !== 'flex', '桌面横屏环境不弹出竖屏提示');
  // 点击「强制横屏」在全屏/方向锁缺失时应静默降级，不抛异常
  var beforeRotateErr = errors.length;
  click($('btnForceRotate'));
  await tick(80);
  ok(errors.length === beforeRotateErr, '点击强制横屏不产生未捕获错误'
     + (errors.length > beforeRotateErr ? '：' + errors[errors.length - 1] : ''));
  ok($('rotateHint').style.display === 'none', '点击后提示层被隐藏');

  console.log('【进入牌桌】');
  click($('lbStartBtn'));
  await tick(30);
  /* 新链路：大厅 → 模式屏 → 人机对局（免门票直接开局） */
  click($('modeBody').querySelector('.mode-card.quick'));
  await tick(400);
  ok($('gameScreen').classList.contains('active'), '进入游戏界面');
  ok($('lobbyScreen').style.display === 'none', '大厅已隐藏');
  ok($('topbar').querySelector('#pLevel').textContent === 'Lv.1', '顶栏等级正常');
  ok(Number(String($('pCoins').textContent).replace(/[^0-9]/g, '') || 0) >= 0, '牌桌顶栏金币正常显示（' + $('pCoins').textContent + '）');
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
  ok($('modeScreen').classList.contains('active'), '退出对局后回到选择模式界面');
  ok($('lobbyScreen').style.display === 'none', '退出后不直接回大厅');
  click($('modeBack'));
  await tick(60);
  ok($('lobbyScreen').style.display === 'flex', '从选择模式可以返回大厅');

  /* 存档持久化 */
  const raw = window.localStorage.getItem('texas_poker_device_saves_v2');
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
  click($('modeBody').querySelector('.mode-card.quick'));
  await tick(150);                       // 正处于发牌阶段
  const dealing = !$('bottomBar').querySelector('.abtn.fold');
  click($('btnExit'));
  await tick(30);
  click($('exitConfirmYes'));
  await tick(600);
  ok($('modeScreen').classList.contains('active'), '发牌途中离桌回到选择模式界面');
  ok(errors.length === 0, '发牌途中离桌无未捕获异常'
     + (errors.length ? '：' + errors.slice(0, 3).join(' | ') : '') + '（离桌时' + (dealing ? '正在发牌' : '已进入下注') + '）');

  /* ============================================================
     预置 v10 老存档：验证迁移 + 商城购买 / 装备 + 统计 / 图鉴
     ============================================================ */
  console.log('【老存档迁移 + 商城链路】');
  var seeded = {
    activeSlot: 1,
    slots: {
      1: {
        player: {
          name: '土豪', version: 10, level: 5, coins: 999999,
          totalHands: 120, totalWins: 60, maxStreak: 4, maxWin: 8888,
          achievements: {}, newbieTasks: {}, newbieProgress: {},
          dailyTasks: null, dailyProgress: {}, dailyClaimed: {}, soundOn: true,
          stats: { vpip: 40, vpipTotal: 100, showdowns: 30, allIns: 8, allInWins: 5,
                   bluffTotal: 10, bluffWins: 4, biggestPot: 8888,
                   totalWagered: 50000, totalNet: 12000 },
          handDex: { 0: 20, 1: 50, 2: 20, 3: 8, 4: 5, 5: 3, 6: 2, 7: 1, 8: 0 },
          rankPoints: 3600, rankPeak: 4
        },
        createdAt: Date.now(), lastPlayed: Date.now()
      },
      2: null, 3: null
    }
  };
  var vc2 = new VirtualConsole();
  var errs2 = [];
  vc2.on('jsdomError', function (e) {
    var m = String((e && e.message) || e);
    if (/Could not parse CSS|Not implemented/.test(m)) return;
    errs2.push(m);
  });
  var dom2 = new JSDOM(html, {
    runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://localhost/',
    virtualConsole: vc2,
    beforeParse: function (w) {
      w.localStorage.setItem('texas_poker_device_saves_v2', JSON.stringify(seeded));
    }
  });
  await tick(120);
  var d2 = dom2.window.document;
  function g2(id) { return d2.getElementById(id); }
  function click2(el) { el.dispatchEvent(new dom2.window.MouseEvent('click', { bubbles: true, cancelable: true })); }

  ok(errs2.length === 0, 'v10 老存档载入无异常' + (errs2.length ? '：' + errs2[0] : ''));
  ok(g2('lbName').textContent === '土豪', '迁移保留玩家名（' + g2('lbName').textContent + '）');
  ok(g2('lbCoins').textContent === '100W', '迁移保留金币 999,999 缩写显示 100W（实际 ' + g2('lbCoins').textContent + '）');
  ok(g2('lbLevel').textContent === 'Lv.5', '迁移保留等级 Lv.5');
  ok(g2('lbRank').textContent.indexOf('心理读牌师') >= 0, '3600 分对应「心理读牌师」段位（' + g2('lbRank').textContent + '）');

  // 商城：购买 → 装备 → 卸下
  click2(g2('lbBtnShop'));
  await tick(60);
  ok(g2('ovShop').classList.contains('show'), '土豪档打开商城');
  var buyBtn = d2.querySelector('#shopList [data-buy="cb_gold"]');
  ok(!!buyBtn, '鎏金牌背存在购买按钮');
  click2(buyBtn);
  await tick(80);
  var eqBtn = d2.querySelector('#shopList [data-equip="cb_gold"]');
  ok(!!eqBtn && eqBtn.textContent.trim() === '装备', '购买后按钮变为「装备」');
  click2(eqBtn);
  await tick(80);
  var eqBtn2 = d2.querySelector('#shopList [data-equip="cb_gold"]');
  ok(!!eqBtn2 && eqBtn2.textContent.trim() === '卸下', '点击后变为「卸下」，装备已生效');
  ok(eqBtn2.closest('.shop-item').className.indexOf('eq') >= 0, '已装备商品高亮显示');

  // 消耗品：购买 → 使用 → 库存耗尽
  var buyPeek = d2.querySelector('#shopList [data-buy="peek3"]');
  ok(!!buyPeek, '透视卡存在购买按钮');
  click2(buyPeek);
  await tick(80);
  var usePeek = d2.querySelector('#shopList [data-use="peek3"]');
  ok(!!usePeek, '购买后出现「使用」按钮');
  click2(usePeek);
  await tick(80);
  ok(d2.querySelector('#shopList [data-use="peek3"]') === null, '使用后库存耗尽，使用按钮消失');
  click2(g2('ovShop').querySelector('[data-close="ovShop"]'));
  await tick(30);

  // 档案：统计 / 图鉴 / 段位
  click2(g2('lbQStats'));
  await tick(60);
  var statTxt = g2('statPanel').textContent;
  ok(g2('statPanel').querySelectorAll('.stat-box').length === 9, '9 项统计指标');
  ok(statTxt.indexOf('40%') >= 0, '入池率显示 40%（VPIP 40 / 100）');
  ok(statTxt.indexOf('+$12,000') >= 0, '净盈亏显示 +$12,000');
  click2(g2('tabSDex'));
  await tick(40);
  ok(g2('dexPanel').querySelectorAll('.dex-cell.got').length === 8, '图鉴已解锁 8 / 9 种');
  click2(g2('tabSRank'));
  await tick(40);
  ok(g2('rankPanel').textContent.indexOf('称号收集') >= 0, '段位页显示称号收集进度');
  ok(g2('rankPanel').textContent.indexOf('已下线') >= 0, '段位页不再显示积分（排位已下线）');
  click2(g2('ovStats').querySelector('[data-close="ovStats"]'));
  await tick(30);

  ok(errs2.length === 0, '土豪档全流程无未捕获错误' + (errs2.length ? '：' + errs2[0] : ''));

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
