const fs=require('fs');const assert=require('assert');
const html=fs.readFileSync('D:/Projects/dezhou/index.html','utf8');
assert(!html.includes('workbuddy-cloud-sdk@dev/lib/index.global.js'));
assert(!html.includes('id="lbBtnFriends"'));
assert(html.includes('data-game="guandan"'));
assert(html.includes('data-game="diceduel"'));
assert(html.includes('纯单机'));
assert(/[一二三四五六七八九十]种乐趣 · 纯单机/.test(html));
console.log('friend-room shell checks passed');
