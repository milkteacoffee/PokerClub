/**
 * 领取动线冒烟测试（jsdom）
 * 校验：已完成待领优先排序、一键批量领取（新手/每日/周常/签到+周常/成就）、
 *       金额与状态一致、存储失败整体回滚、徽标计数。
 * 运行: node tests/claim-flow.test.js
 */
'use strict';
const fs = require('fs');
const assert = require('assert');
const { JSDOM } = require('jsdom');
const html = fs.readFileSync(require('path').join(__dirname, '../index.html'), 'utf8');
const code = html.match(/<script>([\s\S]*?)<\/script>/)[1]
  .replace(/\(function \(\) \{\s*'use strict';/, '')
  .replace(/\}\)\(\);\s*$/, '')
  .replace(/  init\(\);/,'');
const dom = new JSDOM(html.replace(/<script>[\s\S]*?<\/script>/, ''), { url: 'https://claim.test', runScripts: 'outside-only' });
const w = dom.window;
w.setTimeout = () => 0;
w.requestAnimationFrame = () => 0;
w.eval(code);
w.loadAllSaves();

let n = 0;
function test(name, fn) { fn(); n++; console.log('PASS ' + name); }
function quota() {
  const proto = Object.getPrototypeOf(w.localStorage);
  const raw = proto.setItem;
  proto.setItem = function () { throw Error('quota'); };
  return function () { proto.setItem = raw; };
}
function reset() {
  w.player.coins = 500;
  w.player.newbieTasks = {};
  w.player.newbieProgress = {};
  w.player.dailyClaimed = {};
  w.player.dailyProgress = {};
  w.player.achievementClaims = {};
  w.player.weekly = null;
  w.player.checkin = null;
}
/* 达成前 k 项新手任务 */
function readyNewbie(k) {
  const list = w.NEWBIE_TASKS.slice(0, k);
  list.forEach(t => { w.player.newbieProgress[t.id] = t.target; });
  return list;
}

test('任务面板把已完成未领取排到最前，已领取沉底', () => {
  reset();
  const list = readyNewbie(2);
  w.player.newbieTasks[list[0].id] = true;          // 第 1 项已领取
  w.player.newbieProgress[w.NEWBIE_TASKS[7].id] = 1; // 第 8 项进行中
  w.renderTasks();
  const items = [...w.document.querySelectorAll('#taskListNewbie .task-item')];
  const states = items.map(e => e.classList.contains('claimable') ? 'c' : e.classList.contains('done') ? 'd' : 'u');
  assert.equal(states[0], 'c', '可领取排第一');
  assert.equal(items[0].textContent.includes(list[1].name), true, '首项正是已完成未领取的那条');
  const firstDone = states.indexOf('d');
  assert(firstDone > 0 && states.slice(firstDone).every(s => s === 'd'), '已领取全部沉到底部');
  assert(states.slice(0, firstDone).includes('u'), '未完成排在已领取之前');
  const groups = [...w.document.querySelectorAll('#taskListNewbie .task-group')].map(e => e.textContent);
  assert.equal(groups[0], '已完成 · 待领取');
  assert.equal(w.document.querySelector('#taskListNewbie [data-claim-all]').textContent, '一键领取 1 项');
});

test('一键领取新手任务：金额、状态、按钮同步', () => {
  reset();
  const list = readyNewbie(3);
  const sum = list.reduce((a, t) => a + t.reward, 0);
  w.renderTasks();
  const btn = w.document.querySelector('#taskListNewbie [data-claim-all]');
  btn.click();
  assert.equal(w.player.coins, 500 + sum);
  assert(list.every(t => w.player.newbieTasks[t.id]));
  w.renderTasks();
  assert.equal(w.document.querySelector('#taskListNewbie [data-claim-all]').disabled, true);
  assert.equal(w.document.querySelector('#taskListNewbie [data-claim-all]').textContent, '暂无可领取');
  assert.equal(w.document.querySelectorAll('#taskListNewbie .task-item.claimable').length, 0);
  /* 重复点击不再发钱 */
  w.document.querySelector('#taskListNewbie [data-claim-all]').click();
  assert.equal(w.player.coins, 500 + sum);
});

test('一键领取每日任务与周常，金额与标记一致', () => {
  reset();
  w.ensureDailyTasks();
  const ids = [...w.player.dailyTasks.ids];
  ids.forEach(id => { w.player.dailyProgress[id] = 9999; });
  w.renderTasks();
  const daySum = ids.reduce((a, id) => a + w.getDailyTaskById(id).reward, 0);
  w.document.querySelector('#taskListDaily [data-claim-all]').click();
  assert.equal(w.player.coins, 500 + daySum);
  assert(ids.every(id => w.player.dailyClaimed[id]));

  reset();
  w.ensureWeekly();
  const wk = w.WEEKLY_TASKS.slice(0, 4);
  wk.forEach(t => { w.player.weekly.progress[t.id] = t.target; });
  w.renderWeekly();
  const wkSum = wk.reduce((a, t) => a + t.reward, 0);
  const wkBtn = w.document.querySelector('#wkPanel [data-claim-all]');
  assert.equal(wkBtn.textContent, '一键领取 4 项');
  wkBtn.click();
  assert.equal(w.player.coins, 500 + wkSum);
  assert(wk.every(t => w.player.weekly.claimed[t.id]));
  assert.equal(w.document.querySelector('#wkPanel [data-claim-all]').disabled, true);
  /* 排序：已领取沉底，剩下的进行中在前 */
  const rows = [...w.document.querySelectorAll('#wkPanel .task-item')];
  const firstDone = rows.findIndex(e => e.classList.contains('done'));
  assert(firstDone >= 0 && rows.slice(firstDone).every(e => e.classList.contains('done')), '周常已领取沉底');
});

test('签到面板一键领取签到与周常', () => {
  reset();
  w.ensureCheckin();
  w.ensureWeekly();
  const t1 = w.WEEKLY_TASKS[0];
  w.player.weekly.progress[t1.id] = t1.target;
  w.renderCheckin();
  const expect = w.checkinRewardOf(w.player.checkin.streak) + t1.reward;
  const btn = w.document.querySelector('#ciPanel [data-claim-all]');
  assert.equal(btn.textContent, '一键领取 2 项');
  btn.click();
  assert.equal(w.player.coins, 500 + expect);
  assert.equal(w.player.checkin.claimed, true);
  assert.equal(w.player.weekly.claimed[t1.id], true);
  /* 周常无可领时隐藏合并按钮，只留签到自己的按钮 */
  assert.equal(w.document.querySelector('#ciPanel [data-claim-all]'), null);
  assert.equal(w.document.querySelector('#ciPanel .reward-bar .sum').textContent.includes('待领取 0 项'), true);
});

test('成就一键领取覆盖未翻到的分页，且不改动未达成项', () => {
  reset();
  const ready = w.ACHIEVEMENTS.filter(a => a.metric).slice(0, 25);
  ready.forEach(a => { w.profile15(a.game).metrics[a.event] = a.target; });
  w.achGame15 = 'all';
  w.achFilter = 'all';
  w.achPage = 0;
  w.renderAchList();
  const sum = ready.reduce((acc, a) => acc + a.reward, 0);
  const btn = w.document.querySelector('[data-ach-claim-all]');
  assert.equal(btn.textContent, '一键领取 ' + ready.length + ' 项');
  assert.equal(w.document.querySelectorAll('#achList .ach-item').length, 20, '界面仍保持每页 20 条');
  btn.click();
  assert.equal(w.player.coins, 500 + sum);
  assert(ready.every(a => w.player.achievementClaims[a.id]));
  w.renderAchList();
  assert.equal(w.document.querySelector('[data-ach-claim-all]').disabled, true);
  assert.equal(w.document.querySelectorAll('#achList .ach-item.claimable').length, 0);
});

test('存储失败时一键领取整体回滚，不吞金币也不置标记', () => {
  reset();
  const list = readyNewbie(4);
  const sum = list.reduce((a, t) => a + t.reward, 0);
  w.renderTasks();
  const stop = quota();
  w.document.querySelector('#taskListNewbie [data-claim-all]').click();
  stop();
  assert.equal(w.player.coins, 500, '回滚后金币不变');
  assert(list.every(t => !w.player.newbieTasks[t.id]), '回滚后标记未置位');
  w.renderTasks();
  assert.equal(w.document.querySelector('#taskListNewbie [data-claim-all]').disabled, false, '失败后可重试');
  assert.equal(w.document.querySelector('#taskListNewbie [data-claim-all]').textContent, '一键领取 4 项');
  assert.equal(500 + sum > 0, true);
});

test('徽标显示待领取数量，领完后归零', () => {
  reset();
  const list = readyNewbie(2);
  w.updateTasksBadges();
  assert.equal(w.document.getElementById('nbBadge').textContent, '2');
  assert.equal(w.document.getElementById('nbBadge').style.display, 'inline-block');
  w.player.newbieTasks = {};
  list.forEach(t => { w.player.newbieTasks[t.id] = true; });
  w.updateTasksBadges();
  assert.equal(w.document.getElementById('nbBadge').style.display, 'none');
});

console.log('TOTAL ' + n);
dom.window.close();
