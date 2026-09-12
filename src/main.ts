import { GameLoop } from './engine/gameLoop';

const container = document.getElementById('app')!;
const loop = new GameLoop(container);
loop.start();

document.getElementById('test-punch')?.addEventListener('click', () => {
  loop.debugThrowTestPunch();
});
