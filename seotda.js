import { randomInt } from 'node:crypto';
import { rankHand } from './public/seotda-ranks.js';

export { rankHand };

export const ANTE = 10;
export const STARTING_CHIPS = 1000;
export const DECK = Object.freeze(Array.from({ length: 20 }, (_, id) => Object.freeze({
  id, month: Math.floor(id / 2) + 1, bright: id % 2 === 0 && [1, 3, 8].includes(Math.floor(id / 2) + 1),
})));

export function newSeotdaGame(round = 0) {
  return { status: 'waiting', round, version: 0, players: [], turn: null, dealer: 0, pot: 0, currentBet: ANTE, raises: 0, payouts: {}, reason: null, dealAt: 0, resultAt: null };
}

export function dealSeotda(seats, { round = 1, dealer = 0, deck, now = Date.now() } = {}) {
  if (seats.length < 2 || seats.length > 4) throw new Error('2~4명이 필요합니다.');
  const shuffled = deck ? [...deck] : [...DECK];
  if (!deck) for (let i = shuffled.length - 1; i > 0; i--) {
    const j = randomInt(i + 1); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const players = seats.map(({ color, chips }) => ({
    color, chips: chips ?? STARTING_CHIPS,
    cards: [], committed: 0, folded: false, acted: false, action: '패 받는 중', actionType: 'ready', actionVersion: 0,
  }));
  if (players.some((player) => !Number.isSafeInteger(player.chips) || player.chips <= 0)) throw new Error('칩이 부족합니다.');
  for (let card = 0; card < 2; card++) for (const player of players) player.cards.push(shuffled.shift());
  for (const player of players) {
    const ante = Math.min(ANTE, player.chips);
    player.chips -= ante; player.committed = ante; player.action = '참가';
  }
  const game = { ...newSeotdaGame(round), status: 'playing', players, dealer: dealer % players.length, dealAt: now };
  game.pot = players.reduce((sum, p) => sum + p.committed, 0);
  advance(game, game.dealer - 1);
  return game;
}

function settle(game, reason) {
  const alive = game.players.filter((p) => !p.folded);
  const payouts = Object.fromEntries(game.players.map((p) => [p.color, 0]));
  if (alive.length === 1) payouts[alive[0].color] = game.pot;
  else if (alive.length) {
    // Each contribution tier is its own pot; an all-in can only win covered chips.
    const levels = [...new Set(game.players.map((p) => p.committed).filter(Boolean))].sort((a, b) => a - b);
    let previous = 0;
    for (const level of levels) {
      const contributors = game.players.filter((p) => p.committed >= level);
      const amount = (level - previous) * contributors.length;
      previous = level;
      const eligible = alive.filter((p) => p.committed >= level);
      // Return uncalled excess; a folded hand must never win a side pot.
      if (!eligible.length) {
        for (const p of contributors) payouts[p.color] += amount / contributors.length;
        continue;
      }
      const candidates = eligible;
      const best = Math.max(...candidates.map((p) => rankHand(p.cards).score));
      const winners = candidates.filter((p) => rankHand(p.cards).score === best);
      for (let i = 0; i < winners.length; i++) payouts[winners[i].color] += Math.floor(amount / winners.length) + (i < amount % winners.length ? 1 : 0);
    }
  } else {
    for (const player of game.players) payouts[player.color] = player.committed;
  }
  for (const player of game.players) player.chips += payouts[player.color];
  game.payouts = payouts; game.status = 'finished'; game.turn = null; game.reason = reason;
}

function advance(game, afterIndex) {
  const alive = game.players.filter((p) => !p.folded);
  if (alive.length <= 1) return settle(game, 'fold');
  const pending = (p) => !p.folded && p.chips > 0 && (!p.acted || p.committed < game.currentBet);
  const withChips = alive.filter((p) => p.chips > 0);
  if (withChips.length <= 1 && withChips.every((p) => p.committed >= game.currentBet)) return settle(game, 'showdown');
  for (let step = 1; step <= game.players.length; step++) {
    const next = game.players[(afterIndex + step + game.players.length) % game.players.length];
    if (pending(next)) { game.turn = next.color; return; }
  }
  settle(game, 'showdown');
}

function payBet(game, player, paid, type) {
  const previousBet = game.currentBet;
  player.chips -= paid;
  player.committed += paid;
  game.pot += paid;
  if (player.committed > previousBet) {
    game.currentBet = player.committed;
    game.raises++;
    for (const other of game.players) if (!other.folded && other.chips > 0) other.acted = false;
  }
  player.acted = true;
  player.actionType = player.chips === 0 ? 'all-in' : type;
  const labels = { check: '체크', call: `콜 ${paid}`, raise: `레이즈 +${game.currentBet - previousBet}`, 'all-in': `올인 ${paid}` };
  player.action = labels[player.actionType];
}

export function seotdaAction(game, color, action, amount, { round, version } = {}) {
  if (game.status !== 'playing') throw new Error('진행 중인 판이 없습니다.');
  if (round !== game.round || version !== game.version) throw new Error('판이 갱신됐습니다. 다시 선택해 주세요.');
  const index = game.players.findIndex((p) => p.color === color);
  const player = game.players[index];
  if (!player || game.turn !== color || player.folded) throw new Error('내 차례가 아닙니다.');
  const due = Math.max(0, game.currentBet - player.committed);
  if (action === 'fold') { player.folded = true; player.action = '다이'; player.actionType = 'fold'; }
  else if (action === 'check' || action === 'call') {
    if (action === 'check' && due) throw new Error('콜 또는 다이를 선택해 주세요.');
    payBet(game, player, Math.min(due, player.chips), due ? 'call' : 'check');
  } else if (action === 'raise') {
    if (![10, 50].includes(amount)) throw new Error('레이즈는 +10 또는 +50을 선택해 주세요.');
    if (player.chips < due + amount) throw new Error('칩이 부족합니다.');
    if (!game.players.some((p) => !p.folded && p.color !== color && p.chips > 0)) throw new Error('레이즈할 상대가 없습니다.');
    payBet(game, player, due + amount, 'raise');
  } else if (action === 'all-in') {
    if (player.chips <= 0) throw new Error('남은 칩이 없습니다.');
    if (player.chips > due && !game.players.some((p) => !p.folded && p.color !== color && p.chips > 0)) throw new Error('레이즈할 상대가 없습니다.');
    payBet(game, player, player.chips, 'all-in');
  } else throw new Error('잘못된 베팅입니다.');
  game.version++;
  player.actionVersion = game.version;
  advance(game, index);
}

export function foldSeotda(game, color, reason = 'leave') {
  if (game.status !== 'playing') return;
  const index = game.players.findIndex((p) => p.color === color);
  const player = game.players[index];
  if (!player || player.folded) return;
  player.folded = true; player.action = reason === 'disconnect' ? '연결 종료' : '퇴장'; game.version++;
  player.actionType = reason === 'disconnect' ? 'disconnect' : 'leave'; player.actionVersion = game.version;
  if (game.turn === color || game.players.filter((p) => !p.folded).length <= 1) advance(game, index);
}

export function seotdaView(game, color) {
  return { ...game, players: game.players.map((p) => {
    const reveal = p.color === color || game.status === 'finished' && game.reason === 'showdown' && !p.folded;
    const rank = reveal ? rankHand(p.cards) : null;
    return { ...p, cards: reveal ? p.cards : p.cards.map(() => null), rank: rank?.name ?? null, rankScore: rank?.score ?? null };
  }) };
}
