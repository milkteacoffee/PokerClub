const fs=require('fs');const assert=require('assert');
const html=fs.readFileSync('D:/Projects/dezhou/index.html','utf8');
assert(!html.includes('workbuddy-cloud-sdk@dev/lib/index.global.js'));
assert(!html.includes('id="lbBtnFriends"'));
assert(html.includes('data-game="guandan"'));
assert(html.includes('五种乐趣 · 纯单机'));
console.log('friend-room shell checks passed');
