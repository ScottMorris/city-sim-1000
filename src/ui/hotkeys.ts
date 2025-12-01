export type HotkeyAction =
  | 'moveUp'
  | 'moveDown'
  | 'moveLeft'
  | 'moveRight'
  | 'selectInspect'
  | 'selectTerraformRaise'
  | 'selectTerraformLower'
  | 'selectWater'
  | 'selectTrees'
  | 'selectRoad'
  | 'selectRail'
  | 'selectPower'
  | 'selectHydro'
  | 'selectWaterPump'
  | 'selectWaterTower'
  | 'selectResidential'
  | 'selectCommercial'
  | 'selectIndustrial'
  | 'selectPark'
  | 'selectBulldoze';

export type HotkeyBindings = Record<HotkeyAction, string[]>;

export const defaultHotkeys: HotkeyBindings = {
  moveUp: ['KeyW', 'ArrowUp'],
  moveDown: ['KeyS', 'ArrowDown'],
  moveLeft: ['KeyA', 'ArrowLeft'],
  moveRight: ['KeyD', 'ArrowRight'],
  selectInspect: ['KeyI'],
  selectTerraformRaise: ['KeyE'],
  selectTerraformLower: ['KeyQ'],
  selectWater: ['KeyF'],
  selectTrees: ['KeyT'],
  selectRoad: ['KeyR'],
  selectRail: ['KeyL'],
  selectPower: ['KeyP'],
  selectHydro: ['KeyH'],
  selectWaterPump: ['KeyU'],
  selectWaterTower: ['KeyY'],
  selectResidential: ['KeyZ'],
  selectCommercial: ['KeyX'],
  selectIndustrial: ['KeyC'],
  selectPark: ['KeyK'],
  selectBulldoze: ['KeyB']
};

interface HotkeyOptions {
  bindings?: HotkeyBindings;
  onAction?: (action: HotkeyAction) => void;
}

export interface HotkeyController {
  getMovementVector: () => { x: number; y: number };
  dispose: () => void;
}

const movementActions: HotkeyAction[] = ['moveUp', 'moveDown', 'moveLeft', 'moveRight'];

export function initHotkeys(options: HotkeyOptions = {}): HotkeyController {
  const bindings = options.bindings ?? defaultHotkeys;
  const keyToActions = new Map<string, HotkeyAction[]>();
  Object.entries(bindings).forEach(([action, codes]) => {
    codes.forEach((code) => {
      const list = keyToActions.get(code) ?? [];
      list.push(action as HotkeyAction);
      keyToActions.set(code, list);
    });
  });

  const heldMovement = {
    up: false,
    down: false,
    left: false,
    right: false
  };

  const handleMovement = (action: HotkeyAction, isDown: boolean) => {
    if (action === 'moveUp') heldMovement.up = isDown;
    if (action === 'moveDown') heldMovement.down = isDown;
    if (action === 'moveLeft') heldMovement.left = isDown;
    if (action === 'moveRight') heldMovement.right = isDown;
  };

  const handleKey = (e: KeyboardEvent, isDown: boolean) => {
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
      return;
    }
    const actions = keyToActions.get(e.code);
    if (!actions) return;
    let handled = false;
    actions.forEach((action) => {
      const isMovement = movementActions.includes(action);
      if (isMovement) {
        handleMovement(action, isDown);
        handled = true;
      } else if (isDown && !e.repeat && options.onAction) {
        options.onAction(action);
        handled = true;
      }
    });
    if (handled) {
      e.preventDefault();
    }
  };

  const keydown = (e: KeyboardEvent) => handleKey(e, true);
  const keyup = (e: KeyboardEvent) => handleKey(e, false);

  window.addEventListener('keydown', keydown);
  window.addEventListener('keyup', keyup);

  return {
    getMovementVector: () => {
      const x = (heldMovement.right ? 1 : 0) - (heldMovement.left ? 1 : 0);
      const y = (heldMovement.down ? 1 : 0) - (heldMovement.up ? 1 : 0);
      return { x, y };
    },
    dispose: () => {
      window.removeEventListener('keydown', keydown);
      window.removeEventListener('keyup', keyup);
    }
  };
}
