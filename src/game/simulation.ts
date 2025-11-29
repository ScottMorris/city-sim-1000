import type { GameState } from './gameState';

export interface SimulationConfig {
  ticksPerSecond: number;
}

export class Simulation {
  private state: GameState;
  private accumulator = 0;
  private readonly dt: number;

  constructor(state: GameState, config: SimulationConfig) {
    this.state = state;
    this.dt = 1 / config.ticksPerSecond;
  }

  update(elapsedSeconds: number) {
    this.accumulator += elapsedSeconds;
    const epsilon = 1e-9;
    while (this.accumulator + epsilon >= this.dt) {
      this.tick();
      this.accumulator -= this.dt;
    }
  }

  private tick() {
    this.state.tick++;
    if (this.state.tick % 20 === 0) {
      this.state.day++;
    }
    // TODO: utilities, RCI demand, zone growth, budget
  }
}
