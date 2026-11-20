// Same order as the comment in PixelBoard.sol: the contract stores only the index (0–15).
const COLORS: Array<[hex: string, name: string]> = [
  ['#FFFFFF', 'Chalk'],
  ['#C9CED6', 'Fog'],
  ['#7A808A', 'Slate'],
  ['#1B1D22', 'Ink'],
  ['#FF9EC7', 'Bubblegum'],
  ['#E8343A', 'Poppy'],
  ['#FF8A1F', 'Tangerine'],
  ['#8C5A35', 'Walnut'],
  ['#FFD42A', 'Sunflower'],
  ['#9BE22D', 'Lime'],
  ['#22B14C', 'Clover'],
  ['#2CD4D9', 'Lagoon'],
  ['#3B82F6', 'Azure'],
  ['#2335B8', 'Ultramarine'],
  ['#B967FF', 'Orchid'],
  ['#7A1FA2', 'Plum'],
];

export type Swatch = { index: number; hex: string; name: string; rgb: [number, number, number] };

export const PALETTE: Swatch[] = COLORS.map(([hex, name], index) => ({
  index,
  hex,
  name,
  rgb: [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number],
}));

export function swatch(index: number): Swatch {
  return PALETTE[index] ?? PALETTE[0];
}

/** Ink or white, whichever reads better on top of the given palette color (WCAG contrast). */
export function textOn(index: number): string {
  const lum = swatch(index)
    .rgb.map((c) => {
      const s = c / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    })
    .reduce((acc, c, i) => acc + c * [0.2126, 0.7152, 0.0722][i], 0);
  const contrastWithWhite = 1.05 / (lum + 0.05);
  const contrastWithInk = (lum + 0.05) / 0.0646; // ink #1A1F2B has luminance ≈ 0.0146
  return contrastWithWhite >= contrastWithInk ? '#FFFFFF' : '#1A1F2B';
}
