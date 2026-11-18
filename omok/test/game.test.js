import test from 'node:test';
import assert from 'node:assert/strict';
import { newGame, placeStone, winningLine } from '../game.js';

for (const [label, dx, dy, startX, startY] of [
  ['horizontal', 1, 0, 0, 0], ['vertical', 0, 1, 14, 0],
  ['diagonal', 1, 1, 0, 0], ['reverse diagonal', 1, -1, 0, 14],
]) {
  test(`five stones win: ${label}, including board edges`, () => {
    const game = newGame();
    game.status = 'playing';
    for (let i = 0; i < 4; i++) game.board[startY + i * dy][startX + i * dx] = 1;
    placeStone(game, 1, startX + 4 * dx, startY + 4 * dy);
    assert.equal(game.status, 'finished');
    assert.equal(game.winner, 1);
    assert.equal(game.winningLine.length, 5);
  });
}

test('free rule accepts an overline formed by filling a gap', () => {
  const game = newGame();
  game.status = 'playing';
  for (const x of [1, 2, 3, 5, 6]) game.board[7][x] = 1;
  placeStone(game, 1, 4, 7);
  assert.equal(game.winningLine.length, 6);
  assert.equal(game.winner, 1);
});

test('invalid moves never mutate the board or turn', () => {
  const game = newGame();
  assert.throws(() => placeStone(game, 1, 0, 0));
  game.status = 'playing';
  for (const [color, x, y] of [[2, 0, 0], [1, -1, 0], [1, 15, 0], [1, 0, 15], [1, 0.2, 2], [1, '1', 2]]) {
    assert.throws(() => placeStone(game, color, x, y));
    assert.equal(game.moves.length, 0);
    assert.equal(game.turn, 1);
  }
  placeStone(game, 1, 7, 7);
  assert.throws(() => placeStone(game, 2, 7, 7));
  assert.equal(game.moves.length, 1);
  assert.equal(game.turn, 2);
});

test('a full board without five in a row ends in a draw', () => {
  const game = newGame();
  game.status = 'playing';
  for (let y = 0; y < 15; y++) for (let x = 0; x < 15; x++) {
    game.board[y][x] = (Math.floor(x / 2) + y) % 2 + 1;
  }
  for (let y = 0; y < 15; y++) for (let x = 0; x < 15; x++) {
    assert.deepEqual(winningLine(game.board, x, y, game.board[y][x]), []);
  }
  game.turn = game.board[14][14];
  game.board[14][14] = 0;
  game.moves = Array(224).fill({ x: 0, y: 0, color: 1 });
  placeStone(game, game.turn, 14, 14);
  assert.equal(game.status, 'finished');
  assert.equal(game.reason, 'draw');
  assert.equal(game.winner, null);
});
