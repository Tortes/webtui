import { once } from "node:events";
import type { RendererKind, TerminalSize } from "./types.js";

const ESC = "\x1b";
const BEL = "\x07";
const ST = `${ESC}\\`;
const KITTY_CHUNK_SIZE = 4096;

async function writeWithBackpressure(data: string): Promise<void> {
  if (process.stdout.write(data)) return;
  await once(process.stdout, "drain");
}

export class WezTermRenderer {
  private firstFrame = true;
  private lastRows = 0;
  private lastCols = 0;
  private currentImageId = 0;
  private nextImageId = 1;

  constructor(readonly kind: RendererKind = "kitty") {}

  enter(): void {
    process.stdout.write(`${ESC}[?1049h${ESC}[2J${ESC}[H${ESC}[?25l`);
  }

  leave(): void {
    if (this.kind === "kitty") {
      process.stdout.write(`${ESC}_Ga=d,d=A,q=2${ST}`);
    }
    process.stdout.write(`${ESC}[?25h${ESC}[?1049l`);
  }

  size(): TerminalSize {
    const cols = Math.max(40, process.stdout.columns ?? 120);
    const rows = Math.max(10, process.stdout.rows ?? 40);
    return {
      cols,
      rows,
      imageRows: Math.max(1, rows - 1),
    };
  }

  async renderFrame(imageBase64: string, status: string): Promise<void> {
    const { cols, rows, imageRows } = this.size();
    const resized = cols !== this.lastCols || rows !== this.lastRows;

    if (this.firstFrame || resized) {
      process.stdout.write(`${ESC}[2J${ESC}[H`);
      this.firstFrame = false;
      this.lastCols = cols;
      this.lastRows = rows;
      this.currentImageId = 0;
    }

    if (this.kind === "kitty") {
      await this.renderKitty(imageBase64, cols, imageRows);
    } else {
      await this.renderIterm(imageBase64, cols, imageRows);
    }

    this.renderStatus(status);
  }

  private async renderKitty(
    imageBase64: string,
    cols: number,
    imageRows: number,
  ): Promise<void> {
    const imageId = this.allocateImageId();
    const pieces: string[] = [`${ESC}[H`];

    for (let offset = 0; offset < imageBase64.length; offset += KITTY_CHUNK_SIZE) {
      const chunk = imageBase64.slice(offset, offset + KITTY_CHUNK_SIZE);
      const more = offset + KITTY_CHUNK_SIZE < imageBase64.length ? 1 : 0;

      if (offset === 0) {
        pieces.push(
          `${ESC}_Ga=T,f=100,t=d,i=${imageId},p=1,c=${cols},r=${imageRows},C=1,q=2,m=${more};${chunk}${ST}`,
        );
      } else {
        pieces.push(`${ESC}_Gm=${more},q=2;${chunk}${ST}`);
      }
    }

    if (this.currentImageId !== 0) {
      pieces.push(`${ESC}_Ga=d,d=I,i=${this.currentImageId},q=2${ST}`);
    }

    this.currentImageId = imageId;
    await writeWithBackpressure(pieces.join(""));
  }

  private async renderIterm(
    imageBase64: string,
    cols: number,
    imageRows: number,
  ): Promise<void> {
    const imageSequence =
      `${ESC}[H` +
      `${ESC}]1337;File=inline=1;width=${cols};height=${imageRows};` +
      `preserveAspectRatio=0;doNotMoveCursor=1:${imageBase64}${BEL}`;

    await writeWithBackpressure(imageSequence);
  }

  private allocateImageId(): number {
    const id = this.nextImageId;
    this.nextImageId = this.nextImageId >= 0xfffffff0 ? 1 : this.nextImageId + 1;
    return id;
  }

  renderStatus(status: string): void {
    const { cols, rows } = this.size();
    const clean = status.replace(/[\r\n\x1b]/g, " ");
    const clipped = clean.length > cols ? clean.slice(0, Math.max(0, cols - 1)) : clean;
    const padded = clipped.padEnd(cols, " ");

    process.stdout.write(
      `${ESC}[${rows};1H${ESC}[7m${padded}${ESC}[0m${ESC}[?25l`,
    );
  }

  message(status: string): void {
    this.renderStatus(status);
  }
}
