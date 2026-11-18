const SPECIAL_RANKS = [
  { score: 66, name: '알리', months: [1, 2] },
  { score: 65, name: '독사', months: [1, 4] },
  { score: 64, name: '구삥', months: [1, 9] },
  { score: 63, name: '장삥', months: [1, 10] },
  { score: 62, name: '장사', months: [4, 10] },
  { score: 61, name: '세륙', months: [4, 6] },
];

export const SEOTDA_RANKS = Object.freeze([
  { score: 120, name: '38광땡', combination: '3광 + 8광', group: 'bright' },
  { score: 110, name: '13·18광땡', combination: '1광 + 3광 / 8광', group: 'bright' },
  ...Array.from({ length: 10 }, (_, index) => {
    const month = 10 - index;
    return { score: 80 + month, name: month === 10 ? '장땡' : `${month}땡`, combination: `${month}월 두 장`, group: 'pair' };
  }),
  ...SPECIAL_RANKS.map((rank) => ({ ...rank, combination: rank.months.join(' + '), group: 'special' })),
  ...Array.from({ length: 10 }, (_, index) => {
    const point = 9 - index;
    return { score: point, name: point === 9 ? '갑오 · 9끗' : point === 0 ? '망통' : `${point}끗`, combination: `합의 끝자리 ${point}`, group: 'point' };
  }),
].map(Object.freeze));

export function rankHand(cards) {
  if (!Array.isArray(cards) || cards.length !== 2) throw new Error('패 두 장이 필요합니다.');
  const [a, b] = [...cards].sort((first, second) => first.month - second.month);
  if (a.bright && b.bright) {
    return { score: a.month === 3 && b.month === 8 ? 120 : 110, name: `${a.month}${b.month}광땡` };
  }
  if (a.month === b.month) {
    return { score: 80 + a.month, name: a.month === 10 ? '장땡' : `${a.month}땡` };
  }
  const special = SPECIAL_RANKS.find((rank) => rank.months[0] === a.month && rank.months[1] === b.month);
  if (special) return { score: special.score, name: special.name };
  const point = (a.month + b.month) % 10;
  return { score: point, name: point === 9 ? '갑오 · 9끗' : point === 0 ? '망통' : `${point}끗` };
}
