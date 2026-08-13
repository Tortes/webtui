import os from "node:os";
import path from "node:path";
import puppeteer, {
  type Browser,
  type CDPSession,
  type KeyInput,
  type Page,
} from "puppeteer";
import type { BrowserOptions, BrowserViewport, HintTarget } from "./types.js";

const HINT_ALPHABET = "asdfghjklqwertyuiopzxcvbnm";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function labelLength(count: number): number {
  let len = 1;
  let capacity = HINT_ALPHABET.length;
  while (capacity < count) {
    len++;
    capacity *= HINT_ALPHABET.length;
  }
  return len;
}

function makeHintLabel(index: number, width: number): string {
  let n = index;
  let out = "";
  for (let i = 0; i < width; i++) {
    out = HINT_ALPHABET[n % HINT_ALPHABET.length] + out;
    n = Math.floor(n / HINT_ALPHABET.length);
  }
  return out;
}

export class BrowserController {
  private browser!: Browser;
  private _page!: Page;
  private viewport: BrowserViewport;
  private profileDir: string;
  private cdp?: CDPSession;
  private frameCallback?: (imageBase64: string) => void;

  constructor(
    viewport: BrowserViewport,
    private readonly options: BrowserOptions,
  ) {
    this.viewport = viewport;
    this.profileDir =
      process.env.WEZTUI_USER_DATA_DIR ??
      path.join(os.homedir(), ".weztui-browser-profile");
  }

  get page(): Page {
    return this._page;
  }

  async start(onFrame: (imageBase64: string) => void): Promise<void> {
    this.frameCallback = onFrame;

    this.browser = await puppeteer.launch({
      headless: true,
      executablePath: this.options.chromePath,
      acceptInsecureCerts: this.options.acceptInsecureCerts,
      userDataDir: this.profileDir,
      defaultViewport: {
        width: this.viewport.width,
        height: this.viewport.height,
        deviceScaleFactor: 1,
      },
      args: [
        "--disable-background-timer-throttling",
        "--disable-renderer-backgrounding",
      ],
    });

    const pages = await this.browser.pages();
    this._page = pages[0] ?? (await this.browser.newPage());
    this._page.setDefaultTimeout(12_000);
    this._page.setDefaultNavigationTimeout(25_000);

    this.cdp = await this._page.createCDPSession();
    this.cdp.on("Page.screencastFrame", (event: any) => {
      const sessionId = Number(event.sessionId);
      const data = String(event.data);

      // Ack immediately so Chrome never waits for the terminal renderer. The
      // UI keeps only the newest frame, so slow terminals drop stale frames
      // instead of building an ever-growing latency queue.
      void this.cdp
        ?.send("Page.screencastFrameAck", { sessionId })
        .catch(() => undefined);

      this.frameCallback?.(data);
    });

    await this.cdp.send("Page.enable");
    await this.restartScreencast();
  }

  async close(): Promise<void> {
    if (this.cdp && !this.cdp.detached) {
      await this.cdp.send("Page.stopScreencast").catch(() => undefined);
      await this.cdp.detach().catch(() => undefined);
    }
    if (this.browser) {
      await this.browser.close();
    }
  }

  async setViewport(viewport: BrowserViewport): Promise<void> {
    this.viewport = viewport;
    await this._page.setViewport({
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: 1,
    });
    await this.restartScreencast();
  }

  private async restartScreencast(): Promise<void> {
    if (!this.cdp) return;

    await this.cdp.send("Page.stopScreencast").catch(() => undefined);

    const params: Record<string, string | number> = {
      format: this.options.screencastFormat,
      maxWidth: this.viewport.width,
      maxHeight: this.viewport.height,
      everyNthFrame: 1,
    };

    if (this.options.screencastFormat === "jpeg") {
      params.quality = this.options.jpegQuality;
    }

    await this.cdp.send("Page.startScreencast", params as any);
  }

  async goto(input: string): Promise<void> {
    const url = normalizeAddress(input);
    try {
      await this._page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 25_000,
      });
    } catch (err) {
      // Many modern pages intentionally keep requests alive. If Chromium has
      // navigated successfully, a navigation timeout is not fatal for this UI.
      if (this._page.url() === "about:blank") throw err;
    }
  }

  async title(): Promise<string> {
    return await this._page.title();
  }

  url(): string {
    return this._page.url();
  }

  async scrollPixels(delta: number): Promise<void> {
    await this._page.evaluate((dy) => {
      window.scrollBy({ top: dy, left: 0, behavior: "instant" });
    }, delta);
  }

  async scrollHalfPage(direction: 1 | -1): Promise<void> {
    await this._page.evaluate((dir) => {
      window.scrollBy({
        top: dir * window.innerHeight * 0.5,
        left: 0,
        behavior: "instant",
      });
    }, direction);
  }

  async scrollTop(): Promise<void> {
    await this._page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  }

  async scrollBottom(): Promise<void> {
    await this._page.evaluate(() =>
      window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" }),
    );
  }

  async back(): Promise<void> {
    await this._page.goBack({ waitUntil: "domcontentloaded", timeout: 12_000 }).catch(() => null);
  }

  async forward(): Promise<void> {
    await this._page.goForward({ waitUntil: "domcontentloaded", timeout: 12_000 }).catch(() => null);
  }

  async reload(): Promise<void> {
    await this._page.reload({ waitUntil: "domcontentloaded", timeout: 12_000 }).catch(() => null);
  }

  async collectAndShowHints(): Promise<HintTarget[]> {
    await this.clearHints();

    const raw = await this._page.evaluate(() => {
      const selector = [
        "a[href]",
        "button",
        "input:not([type='hidden'])",
        "textarea",
        "select",
        "summary",
        "[role='button']",
        "[onclick]",
        "[contenteditable='true']",
      ].join(",");

      const els = Array.from(document.querySelectorAll<HTMLElement>(selector));
      const results: Array<{
        id: number;
        text: string;
        kind: string;
        href: string | null;
        rect: { x: number; y: number; width: number; height: number };
      }> = [];

      let id = 0;
      for (const el of els) {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        const visible =
          rect.width > 1 &&
          rect.height > 1 &&
          rect.bottom >= 0 &&
          rect.right >= 0 &&
          rect.top <= innerHeight &&
          rect.left <= innerWidth &&
          style.visibility !== "hidden" &&
          style.display !== "none" &&
          Number(style.opacity || "1") > 0.05;

        if (!visible) continue;

        el.setAttribute("data-weztui-target", String(id));

        const href =
          el instanceof HTMLAnchorElement ? el.href :
          el.closest("a[href]") instanceof HTMLAnchorElement
            ? (el.closest("a[href]") as HTMLAnchorElement).href
            : null;

        results.push({
          id,
          text: (el.innerText || el.getAttribute("aria-label") || el.getAttribute("title") || "")
            .trim()
            .replace(/\s+/g, " ")
            .slice(0, 80),
          kind: el.tagName.toLowerCase(),
          href,
          rect: {
            x: rect.left,
            y: rect.top,
            width: rect.width,
            height: rect.height,
          },
        });
        id++;
      }
      return results;
    });

    const width = labelLength(Math.max(raw.length, 1));
    const hints: HintTarget[] = raw.map((item, index) => ({
      id: item.id,
      label: makeHintLabel(index, width),
      text: item.text,
      kind: item.kind,
      href: item.href,
    }));

    const overlayItems = raw.map((item, index) => ({
      id: item.id,
      label: hints[index].label,
      x: item.rect.x,
      y: item.rect.y,
    }));

    await this._page.evaluate((items) => {
      const old = document.getElementById("__weztui_hints__");
      old?.remove();

      const root = document.createElement("div");
      root.id = "__weztui_hints__";
      Object.assign(root.style, {
        position: "fixed",
        inset: "0",
        zIndex: "2147483647",
        pointerEvents: "none",
      });

      for (const item of items) {
        const badge = document.createElement("div");
        badge.textContent = item.label.toUpperCase();
        Object.assign(badge.style, {
          position: "absolute",
          left: `${Math.max(0, item.x)}px`,
          top: `${Math.max(0, item.y)}px`,
          padding: "1px 4px",
          borderRadius: "3px",
          font: "bold 12px monospace",
          lineHeight: "16px",
          color: "#111",
          background: "#ffd75f",
          border: "1px solid #111",
          boxShadow: "0 1px 3px rgba(0,0,0,.45)",
        });
        root.appendChild(badge);
      }

      document.documentElement.appendChild(root);
    }, overlayItems);

    return hints;
  }

  async clearHints(): Promise<void> {
    await this._page.evaluate(() => {
      document.getElementById("__weztui_hints__")?.remove();
      document.querySelectorAll("[data-weztui-target]").forEach((el) => {
        el.removeAttribute("data-weztui-target");
      });
    }).catch(() => {});
  }

  async activateHint(id: number): Promise<{ editable: boolean }> {
    const result = await this._page.evaluate((targetId) => {
      const el = document.querySelector<HTMLElement>(
        `[data-weztui-target="${targetId}"]`,
      );
      if (!el) return { editable: false };

      const editable =
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        el instanceof HTMLSelectElement ||
        el.isContentEditable;

      const anchor =
        el instanceof HTMLAnchorElement
          ? el
          : (el.closest("a[href]") as HTMLAnchorElement | null);

      if (editable) {
        el.focus();
        el.click();
      } else if (anchor?.href && anchor.target === "_blank") {
        window.location.href = anchor.href;
      } else {
        el.click();
      }

      return { editable };
    }, id);

    await this.clearHints();
    await sleep(120);
    return result;
  }

  async activeElementIsEditable(): Promise<boolean> {
    return await this._page.evaluate(() => {
      const el = document.activeElement;
      return (
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        el instanceof HTMLSelectElement ||
        (el instanceof HTMLElement && el.isContentEditable)
      );
    });
  }

  async sendText(text: string): Promise<void> {
    await this._page.keyboard.type(text);
  }

  async sendKey(
    key: KeyInput,
    modifiers: { ctrl?: boolean; alt?: boolean; shift?: boolean; meta?: boolean } = {},
  ): Promise<void> {
    const downs: Array<"Control" | "Alt" | "Shift" | "Meta"> = [];
    if (modifiers.ctrl) downs.push("Control");
    if (modifiers.alt) downs.push("Alt");
    if (modifiers.shift) downs.push("Shift");
    if (modifiers.meta) downs.push("Meta");

    for (const mod of downs) await this._page.keyboard.down(mod);
    try {
      await this._page.keyboard.press(key);
    } finally {
      for (const mod of downs.reverse()) await this._page.keyboard.up(mod);
    }
  }
}

export function normalizeAddress(input: string): string {
  const value = input.trim();
  if (!value) return "about:blank";

  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) return value;

  if (!value.includes(" ") && (value.includes(".") || value.startsWith("localhost"))) {
    return `https://${value}`;
  }

  const search =
    process.env.WEZTUI_SEARCH_URL ??
    "https://www.google.com/search?q=";
  return `${search}${encodeURIComponent(value)}`;
}
