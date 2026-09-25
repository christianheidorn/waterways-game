import './styles/game.css';
import { readBootConfig } from './core/config';
import { Game } from './core/Game';

const game = new Game(readBootConfig());
void game.start();

if (import.meta.env.DEV) {
    (window as unknown as { game: Game }).game = game;
}
