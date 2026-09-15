/**
 * 自定义头像上传（vm 去壳，可访问主作用域内部函数）
 * 覆盖：预设头像回落 / dataURL 渲染 / 他人自定义头像 / 资料面板渲染 /
 *       移除后回落预设 / 存档持久化 / 上传体积上限常量。
 * 运行: node tests/avatar-custom.test.js
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
const dom = new JSDOM(html.replace(/<script>[\s\S]*?<\/script>/, ''), { url: 'https://avatar.test', runScripts: 'outside-only' });
const w = dom.window;
w.setTimeout = () => 0;
w.requestAnimationFrame = () => 0;
w.eval(code);
w.loadAllSaves();

const doc = w.document;
const FAKE = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD//gATQ1JFQVRPUg==';

let n = 0;
function test(name, fn) { fn(); n++; console.log('PASS ' + name); }
function fresh() {
  w.createNewSaveAt(1);
  w.player.customAvatar = '';
  w.player.avatar = 'a01';
}

test('预设头像按 id 渲染，未知 id 回落 a01', () => {
  assert.ok(w.avatarSVG('a05', 44).indexOf('<svg') === 0, 'a05 渲染为 SVG');
  assert.ok(w.avatarSVG('a05', 44).indexOf('url(#pavbg)') > 0, '预设头像带底纹');
  assert.equal(w.avatarSVG('not-exist', 44), w.avatarSVG('a01', 44), '未知 id 回落 a01');
});

test('本人自定义头像（avatar=custom）渲染为 SVG image', () => {
  fresh();
  w.player.customAvatar = FAKE;
  w.player.avatar = 'custom';
  const s = w.avatarSVG('custom', 60);
  assert.ok(s.indexOf('<image href="' + FAKE + '"') > 0, '自定义头像用 image href 输出');
  assert.ok(s.indexOf('clip-path="url(#pavclip)"') > 0, '自定义头像裁圆角');
  assert.ok(s.indexOf('#cfa85b') > 0, '自定义头像保留鎏金描边');
});

test('他人自定义头像（直接传 dataURL）同样渲染', () => {
  const s = w.avatarSVG(FAKE, 30);
  assert.ok(s.indexOf('<image href="' + FAKE + '"') > 0, '他人自定义头像渲染');
  assert.ok(s.indexOf('width="30"') > 0, '尺寸跟随入参');
});

test('未设置自定义头像时不走 image 分支', () => {
  fresh();
  assert.ok(w.avatarSVG('custom', 44).indexOf('<image') < 0, '无自定义数据回落预设图形');
});

test('资料面板与大厅头像渲染自定义头像', () => {
  fresh();
  w.player.customAvatar = FAKE;
  w.player.avatar = 'custom';
  w.renderProfile();
  assert.ok(doc.getElementById('pfAvatar').innerHTML.indexOf('<image') > 0, '资料面板头像为自定义图');
  const customBtn = doc.getElementById('pfGrid').querySelector('[data-pav="custom"]');
  assert.ok(customBtn, '头像网格有自定义入口');
  assert.ok(customBtn.innerHTML.indexOf('<image') > 0, '自定义入口显示已上传的图');
  assert.equal(doc.getElementById('pfAvatarRemove').hidden, false, '有自定义图时显示「移除」');
});

test('点预设头像会切回预设并隐藏移除按钮', () => {
  fresh();
  w.player.customAvatar = FAKE;
  w.player.avatar = 'custom';
  w.renderProfile();
  const a07 = doc.getElementById('pfGrid').querySelector('[data-pav="a07"]');
  a07.click();
  assert.equal(w.player.avatar, 'a07', '切换到预设 a07');
  w.renderProfile();
  assert.equal(doc.getElementById('pfAvatarRemove').hidden, false, '自定义图仍在（可再次选用）');
  fresh();
  w.renderProfile();
  assert.equal(doc.getElementById('pfAvatarRemove').hidden, true, '无自定义图时隐藏「移除」');
});

test('移除自定义头像后回落 a01', () => {
  fresh();
  w.player.customAvatar = FAKE;
  w.player.avatar = 'custom';
  w.renderProfile();
  doc.getElementById('pfAvatarRemove').click();
  assert.equal(w.player.customAvatar, '', '清空自定义数据');
  assert.equal(w.player.avatar, 'a01', '头像回落 a01');
  assert.ok(doc.getElementById('pfAvatar').innerHTML.indexOf('<image') < 0, '资料面板不再显示自定义图');
});

test('自定义头像随存档持久化', () => {
  fresh();
  w.player.customAvatar = FAKE;
  w.player.avatar = 'custom';
  w.savePlayer();
  let hit = '';
  for (let i = 0; i < w.localStorage.length; i++) {
    const k = w.localStorage.key(i);
    const v = w.localStorage.getItem(k) || '';
    if (v.indexOf('customAvatar') > 0 && v.indexOf(FAKE) > 0) hit = k;
  }
  assert.ok(hit, '存档中落库了 customAvatar 与图片数据（命中键: ' + hit + '）');
});

test('体积上限常量存在且合理', () => {
  assert.ok(w.AVATAR_MAX_BYTES >= 8000 && w.AVATAR_MAX_BYTES <= 20000, '存档上限 ' + w.AVATAR_MAX_BYTES);
  assert.ok(w.AVATAR_UPLOAD_MAX <= w.AVATAR_MAX_BYTES, '上传上限不超过存档上限');
  assert.equal(typeof w.avatarCompress, 'function', '压缩函数存在');
  assert.equal(typeof w.handleAvatarFile, 'function', '上传处理函数存在');
});

test('上传非图片文件不改动头像', () => {
  fresh();
  let toasted = '';
  const oldToast = w.showToast;
  w.showToast = function (m) { toasted = m; };
  w.handleAvatarFile({ type: 'text/plain' });
  w.showToast = oldToast;
  assert.ok(/图片/.test(toasted), '给出「请选择图片文件」提示: ' + toasted);
  assert.equal(w.player.avatar, 'a01', '头像未被改动');
});

console.log('\n自定义头像测试: ' + n + ' 项通过, 0 项失败');
process.exit(0);
