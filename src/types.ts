export type Mode = "normal" | "open" | "hint" | "insert";
export type RendererKind = "kitty" | "iterm";
export type ScreencastFormat = "png" | "jpeg";

export interface TerminalSize {
  cols: number;
  rows: number;
  imageRows: number;
}

export interface BrowserViewport {
  width: number;
  height: number;
}

export interface HintTarget {
  id: number;
  label: string;
  text: string;
  kind: string;
  href: string | null;
}

export interface BrowserOptions {
  acceptInsecureCerts: boolean;
  chromePath?: string;
  screencastFormat: ScreencastFormat;
  jpegQuality: number;
}
