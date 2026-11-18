export const BOARD_SIZE = 15;

export function newGame(round = 1) {
  return {
    board: Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(0)),
    status: 'waiting', turn: 1, winner: null, reason: null,
    moves: [], winningLine: [], round,
  };
}

export function winningLine(board, x, y, color) {
  for (const [dx, dy] of [[1, 0], [0, 1], [1, 1], [1, -1]]) {
    const line = [[x, y]];
    for (const sign of [-1, 1]) {
      let nx = x + dx * sign;
      let ny = y + dy * sign;
      while (nx >= 0 && ny >= 0 && nx < BOARD_SIZE && ny < BOARD_SIZE && board[ny][nx] === color) {
        sign === -1 ? line.unshift([nx, ny]) : line.push([nx, ny]);
        nx += dx * sign;
        ny += dy * sign;
      }
    }
    if (line.length >= 5) return line;
  }
  return [];
}

export function placeStone(game, color, x, y) {
  if (game.status !== 'playing') throw new Error('대국이 진행 중일 때만 둘 수 있어요.');
  if (game.turn !== color) throw new Error('상대방의 차례예요.');
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= BOARD_SIZE || y >= BOARD_SIZE) {
    throw new Error('오목판 안의 위치를 선택해 주세요.');
  }
  if (game.board[y][x]) throw new Error('이미 돌이 놓인 자리예요.');
  game.board[y][x] = color;
  game.moves.push({ x, y, color });
  game.winningLine = winningLine(game.board, x, y, color);
  if (game.winningLine.length) {
    game.status = 'finished';
    game.winner = color;
    game.reason = 'five';
  } else if (game.moves.length === BOARD_SIZE * BOARD_SIZE) {
    game.status = 'finished';
    game.reason = 'draw';
  } else {
    game.turn = color === 1 ? 2 : 1;
  }
}
