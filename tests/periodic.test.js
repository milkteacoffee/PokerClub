/**
 * 周期性刷新机制测试（jsdom）
 * 覆盖：签到 / 日常 / 周常 的跨天跨周重置、refreshPeriodic 的变更检测、
 *       页面长期开着时由看门狗（visibilitychange / focus）自动刷新。
 * 运行: node tests/periodic.test.js
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
const dom = new JSDOM(html.replace(/<script>[\s\S]*?<\/script>/, ''), { url: 'https://p.test', runScripts: 'outside-only' });
const w = dom.window;
w.setTimeout = () => 0;
w.requestAnimationFrame = () => 0;
w.eval(code);
w.loadAllSaves();

let FAKE = '2026-09-14';          // 周一
w.todayStr = function () { return FAKE; };

let n = 0;
function test(name, fn) { fn(); n++; console.log('PASS ' + name); }
function resetPeriodic() {
  w.player.checkin = null;
  w.player.dailyTasks = null;
  w.player.dailyProgress = {};
  w.player.dailyClaimed = {};
  w.player.weekly = null;
}

test('签到跨天重置为未领取，连续天数累加', () => {
  resetPeriodic();
  w.ensureCheckin();
  w.claimCheckin();
  assert.equal(w.player.checkin.claimed, true);
  FAKE = '2026-09-15';
  w.ensureCheckin();
  assert.equal(w.player.checkin.claimed, false, '第二天应恢复为可领取');
  assert.equal(w.player.checkin.streak, 2, '连续天数应累加');
  FAKE = '2026-09-14';
});

test('签到断签后从第一天重新开始', () => {
  resetPeriodic();
  w.ensureCheckin();
  w.claimCheckin();
  FAKE = '2026-09-17';                    // 跳过 15、16
  w.ensureCheckin();
  assert.equal(w.player.checkin.streak, 1);
  assert.equal(w.player.checkin.claimed, false);
  FAKE = '2026-09-14';
});

test('日常任务跨天刷新，进度与已领清空', () => {
  resetPeriodic();
  w.ensureDailyTasks();
  const d1 = w.player.dailyTasks.date;
  const id = w.player.dailyTasks.ids[0];
  w.player.dailyProgress[id] = 99;
  w.player.dailyClaimed[id] = true;
  FAKE = '2026-09-15';
  w.ensureDailyTasks();
  assert.notEqual(w.player.dailyTasks.date, d1, '日期应更新');
  assert.deepEqual(w.player.dailyProgress, {}, '进度应清空');
  assert.deepEqual(w.player.dailyClaimed, {}, '已领应清空');
  FAKE = '2026-09-14';
});

test('周常跨周刷新，周一翻篇', () => {
  resetPeriodic();
  assert.equal(w.weekKeyOf('2026-09-20'), '2026-09-14', '周日仍属同一周');
  assert.equal(w.weekKeyOf('2026-09-21'), '2026-09-21', '周一翻篇');
  w.ensureWeekly();
  w.player.weekly.progress.a = 5;
  w.player.weekly.claimed.b = true;
  FAKE = '2026-09-21';
  w.ensureWeekly();
  assert.equal(w.player.weekly.week, '2026-09-21');
  assert.deepEqual(w.player.weekly.progress, {}, '进度应清空');
  assert.deepEqual(w.player.weekly.claimed, {}, '已领应清空');
  FAKE = '2026-09-14';
});

test('同日内 refreshPeriodic 不误报，也不重复刷新', () => {
  resetPeriodic();
  w.ensureCheckin(); w.ensureDailyTasks(); w.ensureWeekly();
  assert.equal(w.refreshPeriodic({ toast: false }), false, '同一天应判定为无变化');
});

test('跨天后 refreshPeriodic 检出变化并重置签到', () => {
  resetPeriodic();
  w.ensureCheckin();
  w.claimCheckin();
  assert.equal(w.player.checkin.claimed, true);
  FAKE = '2026-09-15';
  assert.equal(w.refreshPeriodic({ toast: false }), true, '应检出跨天');
  assert.equal(w.player.checkin.claimed, false, '签到应恢复可领取');
  assert.equal(w.player.checkin.date, '2026-09-15');
  FAKE = '2026-09-14';
});

test('看门狗在页面重新可见时自动刷新（不重启页面）', () => {
  resetPeriodic();
  w.ensureCheckin();
  w.claimCheckin();
  w.startPeriodicWatchdog();
  assert.equal(w.player.checkin.claimed, true);
  FAKE = '2026-09-15';
  try {
    Object.defineProperty(w.document, 'visibilityState', { value: 'visible', configurable: true });
  } catch (e) {}
  w.document.dispatchEvent(new w.Event('visibilitychange'));
  assert.equal(w.player.checkin.claimed, false, '重新可见后应自动刷新签到');
  assert.equal(w.player.checkin.date, '2026-09-15');
  FAKE = '2026-09-14';
});

console.log('TOTAL ' + n);
dom.window.close();
