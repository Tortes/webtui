#!/usr/bin/env node
import readline from "node:readline";
import type { KeyInput } from "puppeteer";
import { BrowserController } from "./browser.js";
import { WezTermRenderer } from "./renderer.js";
import type {
  BrowserOptions,
  BrowserViewport,
  HintTarget,
  Mode,
  RendererKind,
} from "./types.js";

interface Key {
  sequence?: string;
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
}

interface AppOptions {
  url: string;
  renderer: RendererKind;
  fps: number;
  ignoreCertificateErrors: boolean;
  chromePath?: string;
  jpegQuality: number;
}

function parseArgs(argv: string[]): AppOptions {
  let url = "https://example.com";
  let urlWasSet = false;
  let renderer = (process.env.WEZTUI_RENDERER ?? "kitty") as RendererKind;
  let fps = Number(process.env.WEZTUI_FPS ?? "24");
  let ignoreCertificateErrors = process.env.WEZTUI_IGNORE_CERT_ERRORS === "1";
  let chromePath = process.env.WEZTUI_CHROME || undefined;
  let jpegQuality = Number(process.env.WEZTUI_JPEG_QUALITY ?? "55");

  for (const arg of argv) {
    if (arg === "--ignore-certificate-errors") {
      ignoreCertificateErrors = true;
    } else if (arg.startsWith("--renderer=")) {
      renderer = arg.slice("--renderer=".length) as RendererKind;
    } else if (arg.startsWith("--fps=")) {
      fps = Number(arg.slice("--fps=".length));
    } else if (arg.startsWith("--chrome=")) {
      chromePath = arg.slice("--chrome=".length);
    } else if (arg.startsWith("--jpeg-quality=")) {
      jpegQuality = Number(arg.slice("--jpeg-quality=".length));
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else if (!arg.startsWith("-") && !urlWasSet) {
      url = arg;
      urlWasSet = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (renderer !== "kitty" && renderer !== "iterm") {
    throw new Error(`Unsupported renderer: ${renderer}. Use kitty or iterm.`);
  }

  fps = Math.max(1, Math.min(60, Number.isFinite(fps) ? fps : 24));
  jpegQuality = Math.max(
    1,
    Math.min(100, Number.isFinite(jpegQuality) ? jpegQuality : 55),
  );

  return {
    url,
    renderer,
    fps,
    ignoreCertificateErrors,
    chromePath,
    jpegQuality,
  };
}

function printHelp(): void {
  console.log(`webtui [options] [url-or-search]\n\nOptions:\n  --renderer=kitty|iterm       Terminal image protocol (default: kitty)\n  --fps=N                      Max terminal redraw rate (default: 24)\n  --ignore-certificate-errors  Allow invalid HTTPS certificates\n  --chrome=/path/to/chrome     Use a specific Chrome/Chromium executable\n  --jpeg-quality=N             JPEG quality for iTerm renderer (default: 55)\n  -h, --help                   Show this help\n\nEnvironment equivalents:\n  WEZTUI_RENDERER\n  WEZTUI_FPS\n  WEZTUI_IGNORE_CERT_ERRORS=1\n  WEZTUI_CHROME\n  WEZTUI_JPEG_QUALITY\n  WEZTUI_USER_DATA_DIR\n  WEZTUI_CELL_WIDTH / WEZTUI_CELL_HEIGHT\n  WEZTUI_SEARCH_URL`);
}

let options: AppOptions;
try {
  options = parseArgs(process.argv.slice(2));
} catch (err) {
  console.error(String(err));
  process.exit(2);
}

const renderer = new WezTermRenderer(options.renderer);
let browser: BrowserController;
let mode: Mode = "normal";
let inputBuffer = "";
let hintBuffer = "";
let hints: HintTarget[] = [];
let pendingG = false;
let statusNote = "";
let exiting = false;

let latestFrame: string | null = null;
let framePumpRunning = false;
let lastFrameTime = 0;
const frameIntervalMs = 1000 / options.fps;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function viewportFromTerminal(): BrowserViewport {
  const size = renderer.size();
  const cellWidth = Number(process.env.WEZTUI_CELL_WIDTH ?? "9");
  const cellHeight = Number(process.env.WEZTUI_CELL_HEIGHT ?? "18");

  return {
    width: Math.max(640, Math.min(1920, Math.round(size.cols * cellWidth))),
    height: Math.max(
      360,
      Math.min(1200, Math.round(size.imageRows * cellHeight)),
    ),
  };
}

function short(value: string, n = 50): string {
  return value.length <= n ? value : `${value.slice(0, n - 1)}…`;
}

function statusLine(): string {
  if (mode === "open") return ` OPEN  ${inputBuffer}`;
  if (mode === "hint") {
    return ` HINT  ${hintBuffer.toUpperCase()}  (${hints.length} targets)  Esc cancel`;
  }
  if (mode === "insert") {
    return ` INSERT  ${short(browser?.url() ?? "", 65)}  Esc normal`;
  }

  const help =
    "j/k scroll  ^u/^d half  gg/G top/bot  H/L back/fwd  f hint  o open  i insert  r reload  q quit";
  return statusNote ? ` NORMAL  ${statusNote}` : ` NORMAL  ${help}`;
}

function receiveFrame(imageBase64: string): void {
  latestFrame = imageBase64;
  if (!framePumpRunning) void pumpFrames();
}

async function pumpFrames(): Promise<void> {
  if (framePumpRunning || exiting) return;
  framePumpRunning = true;

  try {
    while (latestFrame && !exiting) {
      const elapsed = Date.now() - lastFrameTime;
      const delay = Math.max(0, frameIntervalMs - elapsed);
      if (delay > 0) await sleep(delay);

      // Keep only the newest pending Chrome frame. If terminal output is slower
      // than the browser, stale frames are overwritten instead of queued.
      const frame = latestFrame;
      latestFrame = null;

      await renderer.renderFrame(frame, statusLine());
      lastFrameTime = Date.now();
    }
  } catch (err) {
    renderer.message(` ERROR  renderer: ${String(err)}`);
  } finally {
    framePumpRunning = false;
    if (latestFrame && !exiting) void pumpFrames();
  }
}

async function quit(code = 0): Promise<never> {
  if (exiting) process.exit(code);
  exiting = true;
  try {
    process.stdin.setRawMode?.(false);
    process.stdin.pause();
    await browser?.close();
  } finally {
    renderer.leave();
  }
  process.exit(code);
}

async function handleNormal(str: string, key: Key): Promise<void> {
  statusNote = "";

  if (key.ctrl && key.name === "c") await quit(0);
  if (key.ctrl && key.name === "u") {
    await browser.scrollHalfPage(-1);
    return;
  }
  if (key.ctrl && key.name === "d") {
    await browser.scrollHalfPage(1);
    return;
  }

  if (pendingG) {
    pendingG = false;
    if (str === "g") {
      await browser.scrollTop();
      return;
    }
  }

  switch (str) {
    case "g":
      pendingG = true;
      renderer.message(" NORMAL  g…");
      return;
    case "G":
      await browser.scrollBottom();
      return;
    case "j":
      await browser.scrollPixels(110);
      return;
    case "k":
      await browser.scrollPixels(-110);
      return;
    case "H":
      statusNote = "back";
      renderer.message(statusLine());
      await browser.back();
      return;
    case "L":
      statusNote = "forward";
      renderer.message(statusLine());
      await browser.forward();
      return;
    case "r":
      statusNote = "reloading…";
      renderer.message(statusLine());
      await browser.reload();
      return;
    case "o":
      mode = "open";
      inputBuffer = "";
      renderer.message(statusLine());
      return;
    case "f":
      statusNote = "collecting hints…";
      renderer.message(statusLine());
      hints = await browser.collectAndShowHints();
      hintBuffer = "";
      mode = "hint";
      renderer.message(statusLine());
      return;
    case "i":
      if (await browser.activeElementIsEditable()) {
        mode = "insert";
        renderer.message(statusLine());
      } else {
        statusNote = "no editable element focused; use f to select an input";
        renderer.message(statusLine());
      }
      return;
    case "q":
      await quit(0);
  }

  if (key.name === "escape") {
    pendingG = false;
    renderer.message(statusLine());
  }
}

async function handleOpen(str: string, key: Key): Promise<void> {
  if (key.name === "escape") {
    mode = "normal";
    inputBuffer = "";
    renderer.message(statusLine());
    return;
  }
  if (key.name === "backspace") {
    inputBuffer = Array.from(inputBuffer).slice(0, -1).join("");
    renderer.message(statusLine());
    return;
  }
  if (key.name === "return") {
    const address = inputBuffer;
    inputBuffer = "";
    mode = "normal";
    statusNote = `opening ${short(address, 48)}…`;
    renderer.message(statusLine());
    await browser.goto(address);
    statusNote = "";
    renderer.message(statusLine());
    return;
  }

  if (!key.ctrl && !key.meta && str && str >= " ") {
    inputBuffer += str;
    renderer.message(statusLine());
  }
}

async function handleHint(str: string, key: Key): Promise<void> {
  if (key.name === "escape") {
    await browser.clearHints();
    hints = [];
    hintBuffer = "";
    mode = "normal";
    renderer.message(statusLine());
    return;
  }
  if (key.name === "backspace") {
    hintBuffer = Array.from(hintBuffer).slice(0, -1).join("");
    renderer.message(statusLine());
    return;
  }

  const ch = str.toLowerCase();
  if (!/^[a-z]$/.test(ch)) return;

  hintBuffer += ch;
  const matches = hints.filter((h) => h.label.startsWith(hintBuffer));

  if (matches.length === 0) {
    hintBuffer = "";
    renderer.message(` HINT  no match  (${hints.length} targets)`);
    return;
  }

  const exact = matches.find((h) => h.label === hintBuffer);
  if (exact) {
    mode = "normal";
    statusNote = exact.text ? `→ ${short(exact.text, 55)}` : `→ ${exact.kind}`;
    const { editable } = await browser.activateHint(exact.id);
    hints = [];
    hintBuffer = "";
    if (editable) mode = "insert";
    renderer.message(statusLine());
    return;
  }

  renderer.message(statusLine());
}

const keyMap: Record<string, KeyInput> = {
  return: "Enter",
  enter: "Enter",
  backspace: "Backspace",
  delete: "Delete",
  left: "ArrowLeft",
  right: "ArrowRight",
  up: "ArrowUp",
  down: "ArrowDown",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
  tab: "Tab",
};

async function handleInsert(str: string, key: Key): Promise<void> {
  if (key.name === "escape") {
    mode = "normal";
    renderer.message(statusLine());
    return;
  }

  if (key.ctrl || key.meta || key.name === "tab") {
    const mapped =
      keyMap[key.name ?? ""] ??
      (key.name?.length === 1 ? (key.name as KeyInput) : undefined);
    if (mapped) {
      await browser.sendKey(mapped, {
        ctrl: key.ctrl,
        meta: key.meta,
        shift: key.shift,
      });
    }
    return;
  }

  const mapped = keyMap[key.name ?? ""];
  if (mapped) {
    await browser.sendKey(mapped, { shift: key.shift });
    return;
  }

  if (str && str >= " ") {
    await browser.sendText(str);
  }
}

async function onKeypress(str: string, key: Key): Promise<void> {
  try {
    switch (mode) {
      case "normal":
        await handleNormal(str, key);
        break;
      case "open":
        await handleOpen(str, key);
        break;
      case "hint":
        await handleHint(str, key);
        break;
      case "insert":
        await handleInsert(str, key);
        break;
    }
  } catch (err) {
    statusNote = String(err);
    renderer.message(statusLine());
  }
}

async function main(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error("webtui must be run inside an interactive terminal such as WezTerm.");
    process.exit(2);
  }

  renderer.enter();
  renderer.message(
    ` STARTING  Headless Chrome · ${options.renderer} · ${options.fps} fps`,
  );

  const browserOptions: BrowserOptions = {
    acceptInsecureCerts: options.ignoreCertificateErrors,
    chromePath: options.chromePath,
    screencastFormat: options.renderer === "kitty" ? "png" : "jpeg",
    jpegQuality: options.jpegQuality,
  };

  browser = new BrowserController(viewportFromTerminal(), browserOptions);

  try {
    await browser.start(receiveFrame);
  } catch (err) {
    renderer.leave();
    console.error(`Failed to launch browser: ${String(err)}`);
    process.exit(1);
  }

  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode?.(true);
  process.stdin.resume();

  process.stdin.on("keypress", (str: string, key: Key) => {
    void onKeypress(str, key);
  });

  process.stdout.on("resize", () => {
    void browser.setViewport(viewportFromTerminal()).catch((err) => {
      renderer.message(` ERROR  resize: ${String(err)}`);
    });
  });

  process.on("SIGINT", () => void quit(130));
  process.on("SIGTERM", () => void quit(143));
  process.on("uncaughtException", (err) => {
    renderer.message(` FATAL  ${String(err)}`);
    void quit(1);
  });

  // Navigation starts after input and screencast are live, so loading progress
  // can be shown before DOMContentLoaded completes.
  statusNote = `opening ${short(options.url, 48)}…`;
  renderer.message(statusLine());
  try {
    await browser.goto(options.url);
    statusNote = "";
    renderer.message(statusLine());
  } catch (err) {
    statusNote = String(err);
    renderer.message(statusLine());
  }
}

void main();
