import * as PIXI from 'pixi.js';

export async function loadPaletteTexture(): Promise<PIXI.Texture> {
  return PIXI.Assets.load('/assets/palette.png');
}
