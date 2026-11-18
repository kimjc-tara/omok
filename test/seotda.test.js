import test from 'node:test';
import assert from 'node:assert/strict';
import { DECK, rankHand, dealSeotda, seotdaAction, foldSeotda, seotdaView } from '../seotda.js';

const card = (month, second = false) => DECK[(month - 1) * 2 + Number(second)];
function gameFor(hands, chips = hands.map(() => 1000)) {
  const dealt = hands.flatMap((h) => h);
  const deck = [...hands.map((h) => h[0]), ...hands.map((h) => h[1]), ...DECK.filter((c) => !dealt.includes(c))];
  return dealSeotda(hands.map((_, i) => ({ color: i + 1, chips: chips[i] })), { deck });
}
const act = (game, action = 'call', amount) => seotdaAction(game, game.turn, action, amount, { round: game.round, version: game.version });
const chipsIn = (game) => game.players.reduce((sum, p) => sum + p.chips, 0) + (game.status === 'playing' ? game.pot : 0);

test('20-card deck has one each of the three bright cards and four unique hands', () => {
  assert.equal(DECK.length, 20); assert.equal(new Set(DECK.map((c) => c.id)).size, 20);
  assert.deepEqual(DECK.filter((c) => c.bright).map((c) => c.month), [1, 3, 8]);
  const game = dealSeotda([1, 2, 3, 4].map((color) => ({ color })));
  assert.equal(new Set(game.players.flatMap((p) => p.cards.map((c) => c.id))).size, 8);
  assert.equal(chipsIn(game), 4000);
  assert.throws(() => dealSeotda([{ color: 1 }]), /2~4/);
  assert.throws(() => dealSeotda([{ color: 1, chips: 0 }, { color: 2, chips: 1000 }]), /부족/, 'zero chips never refill implicitly');
});

test('rank ordering distinguishes brights, pairs, special ranks and points', () => {
  const hands = [
    [[card(3), card(8)], '38광땡'], [[card(1), card(3)], '13광땡'],
    [[card(10), card(10, true)], '장땡'], [[card(1), card(1, true)], '1땡'],
    [[card(1), card(2)], '알리'], [[card(1), card(4)], '독사'], [[card(1), card(9)], '구삥'],
    [[card(1), card(10)], '장삥'], [[card(4), card(10)], '장사'], [[card(4), card(6)], '세륙'],
    [[card(1, true), card(8, true)], '갑오 · 9끗'], [[card(2), card(6)], '8끗'],
    [[card(2), card(9)], '1끗'], [[card(2), card(8)], '망통'],
  ];
  const ranks = hands.map(([cards, name]) => { const rank = rankHand(cards); assert.equal(rank.name, name); return rank.score; });
  for (let i = 1; i < ranks.length; i++) assert.ok(ranks[i - 1] > ranks[i]);
  assert.equal(rankHand([card(1), card(8)]).score, rankHand([card(1), card(3)]).score);
  assert.equal(rankHand([card(4), card(9)]).name, '3끗', 'reversal/redeal specials are explicitly excluded');
});

test('four-player raise/call/fold settles once, conserves chips and rejects stale actions', () => {
  const game = gameFor([[card(3), card(8)], [card(10), card(10, true)], [card(1), card(2)], [card(5), card(6)]]);
  const snapshot = structuredClone(game);
  assert.throws(() => seotdaAction(game, 2, 'raise', 10, { round: 1, version: 0 }), /차례/);
  assert.throws(() => act(game, 'raise', -10), /레이즈/);
  assert.deepEqual(game, snapshot);
  act(game, 'raise', 50);
  assert.throws(() => seotdaAction(game, 2, 'call', null, { round: 1, version: 0 }), /갱신/);
  assert.throws(() => act(game, 'check'), /콜/);
  act(game, 'call'); act(game, 'fold'); act(game, 'call');
  assert.equal(game.status, 'finished'); assert.equal(game.reason, 'showdown');
  assert.deepEqual(game.payouts, { 1: 190, 2: 0, 3: 0, 4: 0 });
  assert.equal(game.players[0].chips, 1130); assert.equal(chipsIn(game), 4000);
  assert.throws(() => act(game), /진행/);
});

test('opponent hands and ranks stay hidden until showdown; folded hands stay private', () => {
  const game = gameFor([[card(3), card(8)], [card(10), card(10, true)], [card(1), card(2)]]);
  const view = seotdaView(game, 1);
  assert.equal(view.players[0].rank, '38광땡');
  assert.deepEqual(view.players[1].cards, [null, null]); assert.equal(view.players[1].rank, null);
  assert.ok(!JSON.stringify(view).includes('"month":10'));
  act(game); act(game, 'fold'); act(game);
  assert.equal(seotdaView(game, 3).players[0].rank, '38광땡');
  assert.deepEqual(seotdaView(game, 1).players[1].cards, [null, null]);
});

test('all-in creates covered side pots and ties split chips', () => {
  const game = gameFor([[card(3), card(8)], [card(10), card(10, true)], [card(1), card(2)]], [30, 1000, 1000]);
  act(game); act(game, 'raise', 50); act(game); act(game);
  assert.equal(game.status, 'finished'); assert.deepEqual(game.payouts, { 1: 90, 2: 60, 3: 0 });
  assert.equal(chipsIn(game), 2030);
  const tie = gameFor([[card(2), card(7)], [card(4), card(5)]]);
  act(tie); act(tie);
  assert.deepEqual(tie.payouts, { 1: 10, 2: 10 }); assert.equal(chipsIn(tie), 2000);
});

test('departure folds only that seat and the last player wins without revealing the others', () => {
  const game = dealSeotda([1, 2, 3, 4].map((color) => ({ color })));
  foldSeotda(game, 2, 'disconnect'); assert.equal(game.status, 'playing');
  foldSeotda(game, 3); foldSeotda(game, 1);
  assert.equal(game.status, 'finished'); assert.equal(game.payouts[4], 40);
  assert.deepEqual(seotdaView(game, 4).players[0].cards, [null, null]);
  assert.equal(chipsIn(game), 4000);
});

test('players can keep raising until their stacks reach all-in', () => {
  const game = gameFor([[card(3), card(8)], [card(10), card(10, true)]]);
  for (let raise = 0; raise < 19; raise++) act(game, 'raise', 50);
  assert.equal(game.raises, 19);
  assert.equal(game.status, 'playing');
  act(game, 'all-in');
  assert.equal(game.currentBet, 1000);
  assert.equal(game.players[1].chips, 0);
  assert.equal(game.players[1].actionType, 'all-in');
  act(game, 'call');
  assert.equal(game.status, 'finished');
  assert.equal(game.pot, 2000);
  assert.deepEqual(game.players.map((player) => player.chips), [2000, 0]);
  assert.equal(chipsIn(game), 2000);
  const short = gameFor([[card(2), card(7)], [card(4), card(5)]], [15, 1000]);
  assert.throws(() => act(short, 'raise', 10), /부족/);
});

test('four different all-in stacks settle main and side pots without overdrawing chips', () => {
  const game = gameFor([[card(3), card(8)], [card(10), card(10, true)], [card(1), card(2)], [card(5), card(6)]], [100, 250, 400, 1000]);
  act(game, 'all-in'); act(game, 'all-in'); act(game, 'all-in'); act(game, 'call');
  assert.equal(game.status, 'finished');
  assert.deepEqual(game.payouts, { 1: 400, 2: 450, 3: 300, 4: 0 });
  assert.equal(chipsIn(game), 1750);
  const unmatched = gameFor([[card(10), card(10, true)], [card(3), card(8)]], [1000, 100]);
  act(unmatched, 'all-in', 999999);
  assert.equal(unmatched.players[0].committed, 1000, 'server uses the actual remaining stack');
  act(unmatched, 'all-in');
  assert.deepEqual(unmatched.players.map((player) => player.chips), [900, 200], 'unmatched excess returns to its owner');
});

test('varied 2–4 player stacks and betting sequences always terminate and conserve whole chips', () => {
  let seed = 491;
  const random = (n) => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed % n; };
  for (let trial = 0; trial < 120; trial++) {
    const count = 2 + trial % 3;
    const seats = Array.from({ length: count }, (_, i) => ({ color: i + 1, chips: 1 + random(250) }));
    const initial = seats.reduce((sum, p) => sum + p.chips, 0);
    const game = dealSeotda(seats);
    let actions = 0;
    while (game.status === 'playing') {
      assert.ok(actions++ < initial * count, 'finite stacks bound betting actions');
      const player = game.players.find((p) => p.color === game.turn);
      const pick = random(6);
      const due = game.currentBet - player.committed;
      const raisable = game.players.some((p) => !p.folded && p.color !== player.color && p.chips > 0);
      const canRaise = player.chips >= due + 10 && raisable;
      const canAllIn = player.chips <= due || raisable;
      act(game, pick === 0 ? 'fold' : pick === 1 && canRaise ? 'raise' : pick === 2 && canAllIn ? 'all-in' : 'call', 10);
      assert.equal(chipsIn(game), initial);
      assert.ok(game.players.every((p) => Number.isInteger(p.chips) && p.chips >= 0));
    }
  }
});
