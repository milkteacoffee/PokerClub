/**
 * 佩戴称号展示 + 快速匹配 UI 测试
 * 前半段用真 jsdom 验 UI 结构，后半段用 vm 去壳验函数逻辑。
 * 运行: node tests/match-title.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { JSDOM } = require('jsdom');

const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
let pass = 0, fail = 0;
const failures = [];
function ok(c, m) { if (c) pass++; else { fail++; failures.push(m); } }
const tick = ms => new Promise(r => setTimeout(r, ms));

/* ================= 真 jsdom：匹配 UI 结构 ================= */
(async () => {
  const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://localhost/', virtualConsole: new (require('jsdom').VirtualConsole)() });
  try {
    await new Promise(r => dom.window.addEventListener('load', r, { once: true }));
    const w = dom.window, d = w.document;
    const $ = i => d.getElementById(i);

    ok(!!$('omBox'), '快速匹配面板存在');
    ok(!!$('omGames') && !!$('omStart') && !!$('omCancel') && !!$('omStatus'), '匹配控件齐全');
    ok($('omCancel').hidden === true, '未匹配时「取消匹配」隐藏');
    const chips = $('omGames').querySelectorAll('.om-chip');
    ok(chips.length === 4, '四种可匹配玩法（实际 ' + chips.length + '）');
    ok($('omGames').querySelector('.om-chip.selected').getAttribute('data-mgame') === 'holdem', '默认选中德州扑克');
    ok(/自动开局|不需要准备/.test($('omStatus').textContent), '匹配说明文案完整');

    /* 切换玩法 */
    $('omGames').querySelector('[data-mgame="gold"]').click();
    await tick(30);
    ok($('omGames').querySelector('.om-chip.selected').getAttribute('data-mgame') === 'gold', '点击可切换匹配玩法');

    /* 称号标签位（默认无佩戴时隐藏） */
    ok(!!$('lbTitle'), '大厅有佩戴称号标签位');
    ok($('lbTitle').hidden === true, '未佩戴称号时标签隐藏');

    /* 静态链路断言 */
    ok(html.indexOf('ost-title') > 0, '联机座位有称号样式');
    ok(html.indexOf("titleInfoById(info.title)") > 0, '联机座位渲染佩戴称号');
    ok(html.indexOf("m.type === 'matching'") > 0, '匹配中状态已接入消息处理');
    ok(html.indexOf("title: (player.equipped && player.equipped.title) || ''") > 0, '佩戴称号随档案同步服务器');
    ok(html.indexOf("omReset()") > 0, '开局时重置匹配界面');
  } catch (e) { fail++; failures.push('jsdom 段异常: ' + e.message); }
  try { dom.window.close(); } catch (e) {}

  /* ================= vm 去壳：称号逻辑 ================= */
  const code = html.match(/<script>([\s\S]*?)<\/script>/)[1]
    .replace(/\(function \(\) \{\s*'use strict';/, '')
    .replace(/\}\)\(\);\s*$/, '')
    .replace(/  init\(\);/, '');
  const dom2 = new JSDOM(html.replace(/<script>[\s\S]*?<\/script>/, ''), { url: 'https://title.test', runScripts: 'outside-only' });
  const w2 = dom2.window;
  w2.setTimeout = () => 0;
  w2.requestAnimationFrame = () => 0;
  w2.eval(code);
  w2.loadAllSaves();
  const d2 = w2.document;

  try {
    ok(w2.titleInfoById('tt_top_holdem') && w2.titleInfoById('tt_top_holdem').name === '德州王牌', 'titleInfoById 能解析称号名');
    ok(w2.titleInfoById('not_exist') === null && w2.titleInfoById('') === null, '未知/空称号 id 返回 null');

    w2.createNewSaveAt(1);
    ok(w2.equippedTitleInfo() === null, '未佩戴时 equippedTitleInfo 为 null');

    w2.player.titles = { tt_top_holdem: true };
    ok(w2.equipTitle('tt_top_holdem') === true, '可佩戴已解锁称号');
    const ti = w2.equippedTitleInfo();
    ok(ti && ti.name === '德州王牌', '佩戴后可解析出称号名');
    w2.renderLobby();
    const lb = d2.getElementById('lbTitle');
    ok(lb && lb.hidden === false && lb.textContent === '德州王牌', '大厅标签显示佩戴中的称号（' + (lb && lb.textContent) + '）');

    ok(w2.equipTitle('') === true, '可解除佩戴');
    w2.renderLobby();
    ok(d2.getElementById('lbTitle').hidden === true, '解除后标签隐藏');

    /* 未解锁的称号不能佩戴 */
    ok(w2.equipTitle('tt_six_crowns') === false, '未解锁称号无法佩戴');
  } catch (e) { fail++; failures.push('vm 段异常: ' + e.message); }
  try { dom2.window.close(); } catch (e) {}

  console.log('佩戴称号与快速匹配测试: ' + pass + ' 项通过, ' + fail + ' 项失败');
  if (fail) { failures.slice(0, 12).forEach(f => console.log('  - ' + f)); process.exit(1); }
  process.exit(0);
})();
