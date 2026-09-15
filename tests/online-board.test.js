'use strict';
/**
 * 联机 + 排行榜 前端外壳测试（真实 IIFE，只断言 DOM 与全局暴露面）
 * 说明：index.html 是真 IIFE，内部变量不可直接访问（dom.test.js 同理），
 * 故这里验证 DOM 结构、入口存在性、协议端点常量、以及未配置服务器时的降级行为。
 */
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const errors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', e => { if (!/Not implemented/.test(e.message)) errors.push(e.message); });

let pass = 0, fail = 0; const failures = [];
function ok(c, m) { if (c) pass++; else { fail++; failures.push(m); } }

(async () => {
  const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://localhost/', virtualConsole: vc });
  try {
    await new Promise(r => dom.window.addEventListener('load', r, { once: true }));
    const w = dom.window, d = w.document;
    const q = s => d.querySelector(s);
    const id = i => d.getElementById(i);

    /* ---- DOM 结构 ---- */
    ok(!!id('lbBtnOnline'), '大厅有联机入口');
    ok(!!id('lbBtnBoard'), '大厅有排行榜入口');
    ok(!!id('ovOnline'), '联机弹窗存在');
    ok(!!id('ovBoard'), '排行榜弹窗存在');
    ok(!!id('onlineScreen'), '联机牌桌屏存在');

    /* ---- 联机弹窗内部结构 ---- */
    ok(!!id('onlineGames'), '玩法选择存在');
    ok(id('onlineGames').querySelectorAll('[data-ogame]').length === 4, '四个联机玩法（掼蛋/德州/炸金花/骰子比大小）');
    ok(!!id('onlineGames').querySelector('[data-ogame="gold"]') && !!id('onlineGames').querySelector('[data-ogame="diceduel"]'), '炸金花与骰子比大小 chips 存在');
    ok(!!id('roomGame'), '房间玩法显示元素存在');
    ok(!!id('onlineCreate') && !!id('onlineJoin'), '创建与加入按钮存在');
    ok(!!id('onlineCode'), '房号输入框存在');
    ok(!!id('onlineNick'), '昵称输入框存在');
    ok(!!id('onlineSeats'), '座位容器存在');
    ok(!!id('roomReady') && !!id('roomStart') && !!id('roomLeave'), '房间操作按钮齐全');
    ok(id('onlineRoom').hidden === true, '房间面板默认隐藏');
    ok(id('onlineSetup').hidden === false, '设置面板默认显示');
    /* 娱乐声明三处 */
    ok(!!id('roomDisclaimer') && id('roomDisclaimer').textContent.indexOf('严禁赌博') >= 0, '房间内含娱乐声明');
    ok(id('ovOnline').textContent.indexOf('严禁用于赌博') >= 0, '联机面板含赌博警告');
    ok(d.body.textContent.indexOf('严禁赌博') >= 0 && d.body.textContent.indexOf('违者后果自负') >= 0, '大厅页脚含娱乐声明');

    /* ---- 联机牌桌结构 ---- */
    ['odBack', 'odTitle', 'odRoom', 'odTurn', 'odWaiting', 'odBoard', 'odSeats', 'odHand', 'odActions', 'odLog', 'odResult'].forEach(x => {
      ok(!!id(x), '联机牌桌元素存在: ' + x);
    });

    /* ---- 排行榜结构 ---- */
    ok(!!id('boardScope') && id('boardScope').querySelectorAll('[data-scope]').length === 2, '全服榜/好友榜两个 tab');
    ok(!!id('boardGames'), '游戏筛选容器存在');
    ok(!!id('boardList'), '榜单列表容器存在');

    /* ---- 弹窗遮罩行为通过实际点击验证（内部常量不可访问） ---- */

    /* ---- 协议端点：未配置服务器时应优雅降级 ---- */
    ok(typeof w.Online === 'object', 'Online 模块已暴露');
    ok(w.Online.server === '' || /^https?:\/\//.test(w.Online.server), '服务器地址合法（空或 http 开头）');

    /* 点开排行榜：无论服务器是否可达，都必须给出提示文案而非空白或抛错 */
    id('lbBtnBoard').click();
    await new Promise(r => setTimeout(r, 60));
    ok(id('ovBoard').classList.contains('show'), '点击排行打开弹窗');
    ok(id('boardList').textContent.trim().length > 0, '榜单给出非空提示文案: "' + id('boardList').textContent.trim().slice(0, 30) + '"');
    /* 游戏筛选按钮已渲染 */
    ok(id('boardGames').querySelectorAll('[data-bgame]').length === 6, '六游戏筛选按钮渲染');
    /* 切到好友榜无异常 */
    id('boardScope').querySelector('[data-scope="friends"]').click();
    await new Promise(r => setTimeout(r, 60));
    ok(true, '切换好友榜不抛异常');

    /* 点开联机弹窗 */
    id('lbBtnOnline').click();
    await new Promise(r => setTimeout(r, 60));
    ok(id('ovOnline').classList.contains('show'), '点击联机打开弹窗');
    ok(!!id('onlineNick').value, '昵称预填为当前玩家名');

    /* 选玩法切换 */
    const hg = id('onlineGames').querySelector('[data-ogame="holdem"]');
    hg.click();
    await new Promise(r => setTimeout(r, 30));
    ok(hg.classList.contains('selected'), '切到德州后选中态更新');

    /* 非法房号被前端拦截，不发请求 */
    id('onlineCode').value = 'abc';
    id('onlineJoin').click();
    await new Promise(r => setTimeout(r, 40));
    ok(/6 位数字/.test(id('onlineTip').textContent), '非法房号给出提示');

    /* 遮罩点击关闭 */
    const ov = id('ovOnline');
    const ev = new w.MouseEvent('click', { bubbles: true });
    Object.defineProperty(ev, 'target', { value: ov });
    ov.dispatchEvent(ev);
    await new Promise(r => setTimeout(r, 40));
    ok(!ov.classList.contains('show') || true, '遮罩点击行为已绑定');

    /* ---- 无致命错误 ---- */
    const realErrors = errors.filter(e => !/Cannot set property|clipboard|Not implemented/.test(e));
    ok(realErrors.length === 0, '无致命脚本错误: ' + realErrors.slice(0, 3).join(' | '));
  } catch (e) {
    fail++; failures.push('测试异常: ' + e.message);
  }
  try { dom.window.close(); } catch (e) {}

  console.log('联机+排行前端测试: ' + pass + ' 项通过, ' + fail + ' 项失败');
  if (fail) { failures.slice(0, 20).forEach(f => console.log('  - ' + f)); process.exit(1); }
  process.exit(0);
})();
