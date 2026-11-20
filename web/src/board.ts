import { swatch } from './palette';

export type Cell = { x: number; y: number };

type Handlers = {
  onHover: (cell: Cell | null) => void;
  onSelect: (cell: Cell) => void;
  onKey: (event: KeyboardEvent) => void;
};

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

/** Draws the board on a tiny canvas (1 canvas pixel = 1 board pixel) that CSS scales up crisply. */
export class BoardView {
  pixels: Uint8Array;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly image: ImageData;
  private readonly ghost: HTMLElement;
  private readonly selection: HTMLElement;
  private readonly pending: HTMLElement;
  private readonly markX: HTMLElement;
  private readonly markY: HTMLElement;

  constructor(
    private readonly root: HTMLElement,
    readonly width: number,
    readonly height: number,
    handlers: Handlers,
  ) {
    this.pixels = new Uint8Array(width * height);
    const frame = root.closest<HTMLElement>('.board-frame')!;
    frame.style.setProperty('--w', String(width));
    frame.style.setProperty('--h', String(height));

    const canvas = root.querySelector('canvas')!;
    canvas.width = width;
    canvas.height = height;
    this.ctx = canvas.getContext('2d')!;
    this.image = this.ctx.createImageData(width, height);

    this.ghost = root.querySelector('.ghost')!;
    this.selection = root.querySelector('.selection')!;
    this.pending = root.querySelector('.pending')!;

    this.buildRuler(frame.querySelector('.ruler-x')!, width);
    this.buildRuler(frame.querySelector('.ruler-y')!, height);
    this.markX = frame.querySelector('.ruler-x .mark')!;
    this.markY = frame.querySelector('.ruler-y .mark')!;

    root.addEventListener('pointermove', (e) => handlers.onHover(this.cellAt(e)));
    root.addEventListener('pointerleave', () => handlers.onHover(null));
    root.addEventListener('click', (e) => {
      const cell = this.cellAt(e);
      if (cell) handlers.onSelect(cell);
    });
    root.addEventListener('keydown', handlers.onKey);
  }

  setAll(bytes: Uint8Array): void {
    this.pixels = bytes.slice(0, this.width * this.height);
    for (let i = 0; i < this.pixels.length; i++) this.writeRgba(i, this.pixels[i]);
    this.ctx.putImageData(this.image, 0, 0);
  }

  setPixel(x: number, y: number, color: number): void {
    const i = y * this.width + x;
    this.pixels[i] = color;
    this.writeRgba(i, color);
    this.ctx.putImageData(this.image, 0, 0, x, y, 1, 1);
  }

  colorAt(cell: Cell): number {
    return this.pixels[cell.y * this.width + cell.x] ?? 0;
  }

  showHover(cell: Cell | null, color: number): void {
    this.place(this.ghost, cell, color);
  }

  showSelection(cell: Cell | null, color: number): void {
    this.place(this.selection, cell, color);
  }

  showPending(cell: Cell | null, color: number): void {
    this.place(this.pending, cell, color);
  }

  /** Highlights the column and row of `cell` on the rulers. */
  markRulers(cell: Cell | null, color: number): void {
    for (const [mark, value] of [
      [this.markX, cell?.x],
      [this.markY, cell?.y],
    ] as const) {
      mark.hidden = value === undefined;
      if (value !== undefined) {
        mark.style.setProperty('--i', String(value));
        mark.style.background = swatch(color).hex;
      }
    }
  }

  /** A ring that grows out of a freshly painted pixel, so you notice where others paint. */
  ripple(x: number, y: number): void {
    if (reducedMotion.matches) return;
    const ring = document.createElement('div');
    ring.className = 'cell ripple';
    ring.style.setProperty('--x', String(x));
    ring.style.setProperty('--y', String(y));
    this.root.append(ring);
    const animation = ring.animate(
      [
        { transform: 'scale(1)', opacity: 1 },
        { transform: 'scale(4)', opacity: 0 },
      ],
      { duration: 700, easing: 'cubic-bezier(.2,.7,.3,1)' },
    );
    animation.onfinish = () => ring.remove();
  }

  private place(el: HTMLElement, cell: Cell | null, color: number): void {
    el.hidden = !cell;
    if (!cell) return;
    el.style.setProperty('--x', String(cell.x));
    el.style.setProperty('--y', String(cell.y));
    el.style.setProperty('--fill', swatch(color).hex);
  }

  private writeRgba(i: number, color: number): void {
    const [r, g, b] = swatch(color).rgb;
    const o = i * 4;
    this.image.data[o] = r;
    this.image.data[o + 1] = g;
    this.image.data[o + 2] = b;
    this.image.data[o + 3] = 255;
  }

  private cellAt(e: MouseEvent): Cell | null {
    const rect = this.root.getBoundingClientRect();
    const bx = this.root.clientLeft; // border widths of the board frame
    const by = this.root.clientTop;
    const x = Math.floor(((e.clientX - rect.left - bx) / (rect.width - bx * 2)) * this.width);
    const y = Math.floor(((e.clientY - rect.top - by) / (rect.height - by * 2)) * this.height);
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return null;
    return { x, y };
  }

  private buildRuler(ruler: HTMLElement, cells: number): void {
    const parts: string[] = [];
    for (let i = 0; i <= cells; i += 4) {
      const major = i % 8 === 0;
      parts.push(`<span class="tick${major ? ' major' : ''}" style="--i:${i}"></span>`);
      if (major && i < cells) parts.push(`<small class="num" style="--i:${i}">${i}</small>`);
    }
    parts.push('<span class="mark" hidden></span>');
    ruler.innerHTML = parts.join('');
  }
}
