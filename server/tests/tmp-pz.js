const g = require('D:/Projects/dezhou/server/engine/guandan.js');
// 构造：级牌 8，红桃8 = wild；手牌 H8 + K + K + 4 + 4
const mk = (r, s) => ({ r, s, id: 900 + r * 4 + s });
const hand = [mk(8,1), mk(13,0), mk(13,2), mk(4,1), mk(4,3)];
const cls = g.classify(hand, 8, null);
console.log('H8+KK+44 (打8, 领出) →', JSON.stringify({ t: cls.t, v: cls.v, cards: cls.cards.map(c=>c.id) }));
// 断言：应配成 KKK+44（v=13）而不是 444+KK（v=4）
if (cls.t === 'full' && cls.v === 17) console.log('PASS: 级牌配成 K（power 17）✓');
else if (cls.t === 'full') console.log('注意: 配成 r=' + cls.v);
// 对局场景：有人出了 55+55 双顺（pairs）压不过的检验——跳过，核心是领出解释
