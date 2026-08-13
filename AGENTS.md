# Codex instructions for webtui

## Current direction

The existing v0.2 Puppeteer/CDP + terminal-image renderer is a working fallback/prototype. The next architecture is a **Windows-native WebView2 surface hosted by a WezTerm fork**, with a normal terminal pane retained as the mux/layout anchor.

Before changing native code, read:

- `docs/NATIVE_WEBVIEW2_PLAN.md`
- `README.md`

## Mandatory execution discipline

Follow the gates in `docs/NATIVE_WEBVIEW2_PLAN.md` in order.

The first task is **only Gate A: `native/webview2-spike`**. Prove standalone Windowed WebView2 with Windows MSVC before modifying WezTerm.

Do not advance to WezTerm integration until the prior gate's acceptance criteria are actually demonstrated.

## Non-negotiable architecture constraints

- Native mode must not use screenshot/screencast/framebuffer image transport.
- Browser pixels must not travel through PTY, OSC, Kitty, iTerm2, or Sixel.
- Keep v0.2 intact as fallback until native mode passes its acceptance matrix.
- WebView2 runs on Windows, not in WSL.
- Use Windowed WebView2 first; do not start with CompositionController/CEF.
- Do not implement a new `mux::Pane` type in the initial integration.
- Treat the existing terminal pane as the layout/lifecycle anchor via a pane user var.
- WebView2 COM objects must stay on the STA WezTerm GUI thread/message pump.
- Do not block synchronous WebView2 callbacks; enqueue WezTerm actions and return.
- Do not disable TLS certificate validation or Chromium sandboxing in native mode.
- Do not reuse a live Chrome/Edge profile.

## Baselines inspected during planning

- `Tortes/webtui`: `ec8af0500db7320f9b2751748b7a3ddf41040235`
- `wezterm/wezterm`: `fe3006aefcdc4c22924e7bce966b2c430dade4f1`

If upstream WezTerm has moved, re-check the files called out in the plan before adapting the patch. Do not assume line locations stayed stable.

## Validation expectations

Every implementation step should have an executable validation. For native integration, test at minimum: splits, resize, tab switching, zoom, focus transfer, mouse wheel, text input, clipboard, Chinese/IME input, controller cleanup, and repeated open/close cycles.

Prefer small, bisectable commits and record failures/decisions in the plan or a companion development log.
