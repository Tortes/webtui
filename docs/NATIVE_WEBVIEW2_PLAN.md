# Native WebView2 integration plan

Status: **implementation plan / feasibility-validated**  
Target: **Windows WezTerm GUI + WSL/terminal anchor pane**  
Current fallback: `webtui` v0.2 CDP screencast renderer  
WebTUI baseline: `ec8af0500db7320f9b2751748b7a3ddf41040235`  
WezTerm upstream baseline inspected: `fe3006aefcdc4c22924e7bce966b2c430dade4f1`

## 1. Goal

Replace the terminal image transport path:

```text
Chromium -> screenshot/screencast -> PNG/JPEG -> base64 -> PTY -> WezTerm image protocol
```

with native Windows browser hosting:

```text
WSL/terminal anchor pane --control only--> WezTerm GUI
                                         |
                                         +--> WebView2 child HWND
                                               |
                                               +--> Edge/Chromium renderer + GPU compositor
```

There must be **no per-frame image serialization, no base64 framebuffer traffic and no browser pixels sent through the PTY** in native mode.

The v0.2 renderer remains available as a fallback/reference until native mode is proven stable.

## 2. Chosen architecture

### P1 architecture: normal WezTerm pane as an anchor + Windowed WebView2 overlay

Do **not** create a new `mux::Pane` implementation in the first native version. WezTerm's `Pane` trait is strongly terminal-oriented (screen lines, cursor, scrollback, reader/writer, terminal resize, palette, etc.). Instead:

1. Keep an ordinary terminal pane in the mux tree.
2. `webtui --native <url>` runs inside that pane and emits an OSC 1337 user variable such as `WEZTUI_NATIVE`.
3. The Windows WezTerm GUI sees the user variable on a visible `PositionedPane`.
4. It creates a Windowed WebView2 controller with the WezTerm top-level HWND as `ParentWindow`.
5. It sets WebView2 `Bounds` to the exact client-pixel rectangle occupied by that anchor pane.
6. The WebView child HWND visually covers the terminal cells, while the normal pane continues to supply split/tab/zoom/close/layout semantics.
7. Destroying the anchor pane destroys the matching WebView controller.

This intentionally reuses WezTerm's existing mux/layout machinery instead of teaching the multiplexer what a browser is.

### Why Windowed WebView2 first

Microsoft explicitly recommends Windowed hosting as the normal starting point. It creates a child HWND, receives OS input directly, provides accessibility/focus behavior, and allows the host to position it via controller `Bounds` relative to the parent HWND.

Do **not** start with `CreateCoreWebView2CompositionController`. Full visual hosting requires the host to forward spatial input, manage coordinate transforms/scaling, and manage more composition details. Move to it only if the child-HWND airspace limitations are demonstrated to be unacceptable.

## 3. Feasibility evidence already checked

### WezTerm side

At the pinned upstream baseline:

- `mux::Pane` is terminal-oriented, so avoiding a new Pane subtype minimizes risk.
- `mux::tab::PositionedPane` already contains `left`, `top`, `width`, `height`, `pixel_width`, `pixel_height`, and the `Arc<dyn Pane>`.
- `TermWindow::paint_pass()` already obtains `get_panes_to_render()` and iterates the exact visible/zoomed panes.
- Pane rendering already computes the content rectangle using global padding, tab-bar height, OS border, cell width/height, and `PositionedPane.left/top/width/height`. Native bounds must share this calculation instead of inventing a second coordinate system.
- The Windows `window` layer exposes a `raw-window-handle` Win32 handle and has a normal Windows message pump (`PeekMessageW`/`DispatchMessageW`).
- `Tab::set_active_pane()` exists, so a WebView `GotFocus` event can activate the corresponding anchor pane.
- WezTerm user vars are pane-scoped, visible via `get_user_vars` / `PaneInformation.user_vars`, and setting one already triggers GUI events.

### WebView2 side

- `CreateCoreWebView2Controller(HWND, ...)` creates a windowed WebView associated with a supplied parent HWND.
- Controller `Bounds` are relative to `ParentWindow`.
- WebView2 is COM-based and must be created/called on an STA UI thread with a message pump.
- `AddScriptToExecuteOnDocumentCreated` can inject the Vim bridge before page scripts run, including future navigations.
- `AcceleratorKeyPressed` receives Ctrl/Alt combinations, non-character keys, and Escape while the WebView is focused.
- Visual hosting is available later through `CreateCoreWebView2CompositionController` and DirectComposition if needed.

Primary references:

- WezTerm pane trait: https://github.com/wezterm/wezterm/blob/fe3006aefcdc4c22924e7bce966b2c430dade4f1/mux/src/pane.rs
- WezTerm positioned panes: https://github.com/wezterm/wezterm/blob/fe3006aefcdc4c22924e7bce966b2c430dade4f1/mux/src/tab.rs
- WezTerm paint path: https://github.com/wezterm/wezterm/blob/fe3006aefcdc4c22924e7bce966b2c430dade4f1/wezterm-gui/src/termwindow/render/paint.rs
- WezTerm pane pixel math: https://github.com/wezterm/wezterm/blob/fe3006aefcdc4c22924e7bce966b2c430dade4f1/wezterm-gui/src/termwindow/render/pane.rs
- WezTerm Windows message pump: https://github.com/wezterm/wezterm/blob/fe3006aefcdc4c22924e7bce966b2c430dade4f1/window/src/os/windows/connection.rs
- WezTerm Windows native window: https://github.com/wezterm/wezterm/blob/fe3006aefcdc4c22924e7bce966b2c430dade4f1/window/src/os/windows/window.rs
- WezTerm user vars: https://wezterm.org/config/lua/pane/get_user_vars.html
- Microsoft Windowed vs Visual hosting: https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/windowed-vs-visual-hosting
- Microsoft WebView2 threading model: https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/threading-model
- Microsoft `ICoreWebView2Environment::CreateCoreWebView2Controller`: https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2environment
- Microsoft controller bounds/focus/visibility: https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2controller
- Microsoft `ICoreWebView2::AddScriptToExecuteOnDocumentCreated`: https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2
- DirectComposition target layering: https://learn.microsoft.com/en-us/windows/win32/api/dcomp/nf-dcomp-idcompositiondevice-createtargetforhwnd

## 4. Execution gates

Do the work in gates. **Do not advance if the current gate does not pass.**

### Gate A — standalone Rust WebView2 spike

Implement under this repository, for example:

```text
native/webview2-spike/
  Cargo.toml
  src/main.rs
```

Use current `webview2-com` bindings (the inspected upstream project currently publishes `0.39.1`). Build with the Windows MSVC Rust toolchain. Do not run the browser renderer in WSL.

The spike must:

1. Initialize COM with `COINIT_APARTMENTTHREADED`.
2. Create a basic Win32 parent window.
3. Create a Windowed WebView2 controller attached to that HWND.
4. Set and update controller bounds on resize.
5. Navigate to `https://github.com`.
6. Inject a tiny document-created script proving `j/k` can scroll without host-side screenshots.
7. Register `AcceleratorKeyPressed` and prove `Escape` or `Ctrl+U` reaches the host.
8. Close the controller cleanly.

**Gate A acceptance:**

- GitHub renders interactively in the native window.
- Mouse wheel, text selection and normal page interaction work.
- `j/k` injected scrolling is visibly smooth.
- No call to screenshot, screencast, `CapturePreview`, Kitty graphics, iTerm images, or terminal image transport exists in the spike.
- The host process is idle when the page is idle; there is no user-space frame pump.
- If WebView2 Runtime is unavailable, report a useful error rather than panic.

If Gate A fails, stop and diagnose WebView2/COM/toolchain before modifying WezTerm.

### Gate B — establish a WezTerm fork/build baseline

Create or reuse a `Tortes/wezterm` fork. Add `wezterm/wezterm` as `upstream`. Start the integration branch from the inspected baseline `fe3006aefcdc4c22924e7bce966b2c430dade4f1`, or deliberately update the baseline only after re-checking the affected files.

Before changing code:

1. Initialize all WezTerm submodules.
2. Build unmodified WezTerm on Windows with MSVC Rust.
3. Launch the produced `wezterm-gui`/`wezterm` and verify normal WSL operation.

WezTerm's official Windows source-build documentation says the MSVC Rust toolchain is required; Strawberry Perl is also required for its OpenSSL build path.

**Gate B acceptance:** clean upstream builds and launches before any native WebView changes.

### Gate C — isolate WebView2 in a Windows-only WezTerm crate

Do not place WebView2 COM types throughout `wezterm-gui`.

Add a crate similar to:

```text
wezterm-webview/
  Cargo.toml
  src/lib.rs
  src/windows.rs
  assets/vim_bridge.js
```

Reason: current WezTerm uses an older `windows` crate in its workspace, while current `webview2-com` uses a newer `windows` crate. Cargo can carry both versions, but their types must not cross the crate boundary.

The public API of `wezterm-webview` should use only project-owned/plain types:

```rust
pub struct NativeRect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

pub enum BrowserEvent {
    GotFocus { id: u64 },
    HostMessage { id: u64, json: String },
    NavigationChanged { id: u64, url: String },
    Failed { id: u64, message: String },
}
```

Do not expose `windows::*`, COM interface types, HWND wrapper types, or WebView2-generated types from this crate. Pass the parent HWND across the boundary as an opaque integer/raw handle after validating it on the WezTerm side.

The crate should own:

- COM apartment lifetime.
- WebView2 environment/controller lifetime.
- event-registration tokens.
- a controller map keyed by an opaque ID (use PaneId converted to `u64` at the integration boundary).
- native `set_bounds`, `set_visible`, `navigate`, `focus`, `close` operations.

All WebView2 operations must remain on the WezTerm GUI/main thread. Do not create a dedicated worker thread for COM objects.

### Gate D — anchor protocol in `webtui`

Add a `--native` mode to this repository's CLI. It must **not launch Puppeteer**.

Suggested pane user-var schema:

```json
{
  "version": 1,
  "backend": "webview2",
  "url": "https://github.com"
}
```

Encode the JSON as the value of a pane-scoped OSC 1337 `SetUserVar`, using a stable name such as `WEZTUI_NATIVE`.

Behavior:

```text
webtui --native https://github.com
  -> verify running inside WezTerm
  -> emit WEZTUI_NATIVE user var
  -> remain alive with near-zero CPU as the anchor process
  -> clear the user var on graceful termination
```

Do not send frame data after the initial control message.

Keep the existing CDP renderer as the default until native mode passes the next gates.

### Gate E — WezTerm `NativeWebViewManager`

Add a Windows-only module in `wezterm-gui`, for example:

```text
wezterm-gui/src/termwindow/native_webview.rs
```

Integrate it with `TermWindow`.

Use `get_panes_to_render()` as the source of truth for which panes are currently visible (including zoom behavior). For each visible pane:

1. Read `WEZTUI_NATIVE` from the pane's user vars.
2. Parse/validate version/backend/url.
3. Compute the exact pane content rectangle in client pixels.
4. Ensure the WebView exists.
5. Update its bounds only when the rectangle changes.
6. Update visibility according to tab/zoom/modal state.
7. Navigate only if the requested URL changes.

For panes no longer present, close and erase their WebViews.

#### Pixel rectangle rule

Do not derive dimensions from `pixel_width/pixel_height` alone and do not guess terminal cell sizes.

Factor/reuse the same coordinate math used by terminal pane rendering:

```text
x = padding_left + os_border_left + pos.left * cell_width
y = top_bar_height + padding_top + os_border_top + pos.top * cell_height
w = pos.width  * cell_width
h = pos.height * cell_height
```

The one-cell split separator must remain outside the browser rectangle.

Use one helper for both native-overlay bounds and any related renderer calculations so the two paths cannot drift.

#### Avoid COM work inside the hot paint loop

The paint loop may discover desired state, but asynchronous controller creation and higher-level browser actions should be queued via the existing GUI notification/main-thread mechanism. Do not block `paint_pass()` waiting for WebView creation.

Bounds/visibility updates for already-created controllers may be applied only when state actually changes.

### Gate F — focus and lifecycle correctness

A child WebView HWND receives mouse input directly, so clicking it bypasses WezTerm's normal pane mouse hit-testing.

This must be solved in the first integrated PoC:

- On WebView2 `GotFocus`, asynchronously notify `TermWindow` and call the active tab's `set_active_pane()` for the matching anchor pane.
- Never mutate `TermWindow` re-entrantly inside a synchronous WebView callback; queue a `TermWindowNotif::Apply` (or equivalent main-loop message) and return.
- If focus moves to another WezTerm pane, remove WebView focus but keep an inactive visible browser alive if its pane remains visible.
- Closing/killing the anchor pane must close the WebView controller.
- Switching tabs must hide controllers belonging to non-visible tabs.
- Zoom/unzoom must update bounds/visibility without recreating the browser.

### Gate G — Vim input bridge

Use `AddScriptToExecuteOnDocumentCreated` for the browser-local Vim state machine. This is intentionally closer to Vimium/qutebrowser than routing every character through Rust.

First native key set:

```text
j/k        scroll
Ctrl-u/d   half page
 gg/G      top/bottom
f          hints
H/L        back/forward
r          reload
o          URL/search command overlay
Esc        Normal mode
```

Rules:

- Normal character keys (`j`, `k`, `f`, `g`, etc.) should execute in injected JavaScript with no host round-trip.
- Put hint/command UI in an isolated shadow DOM so page CSS does not trivially corrupt it.
- Do not intercept normal typing while an editable element is in Insert mode.
- `Escape` and Ctrl/Alt accelerators may be bridged using `AcceleratorKeyPressed`.
- Because the Windowed `AcceleratorKeyPressed` handler is synchronous, it must decide `Handled`, enqueue an action, and return immediately. Do not run long logic or wait for async COM work inside that callback.
- Disable conflicting built-in browser accelerator keys only when required; preserve editing shortcuts such as copy/paste.

Top-level-document hints are enough for the first acceptance test. Cross-origin iframe hint coordination is explicitly deferred.

### Gate H — child-HWND airspace handling

Windowed WebView2 is intentionally allowed to sit above WezTerm's GPU-rendered pane contents. This means WezTerm-drawn modal overlays cannot automatically paint over the WebView child window.

For the first integrated version:

- Hide all native WebViews whenever a WezTerm modal/command-palette style overlay needs to occupy the content area.
- Restore them after the modal closes.
- Test pane-selection/quick-select overlays and add equivalent visibility gating where needed.
- Keep tab bar and split separators outside the WebView bounds.

Do not move to full CompositionController merely to avoid implementing this visibility rule.

## 5. Native integration acceptance matrix

Native mode is not considered successful until all of these pass:

### Rendering/performance

- GitHub appears inside a WezTerm pane with no terminal image protocol traffic.
- Continuous mouse-wheel and `j/k` scrolling remain visually native/smooth.
- No frame queue exists in `webtui` or WezTerm.
- The PTY is effectively idle after the native request is emitted.
- Video/animation is rendered by WebView2 without application-side frame callbacks.

### Layout

- single pane
- left/right split
- top/bottom split
- resize split repeatedly
- resize outer WezTerm window
- maximize/restore
- zoom/unzoom pane
- change active tab and return
- two native browser panes in one tab

No browser child window may leak outside its anchor pane rectangle.

### Focus/input

- click browser pane -> corresponding WezTerm pane becomes active
- click another terminal pane -> terminal receives input normally
- browser text input works
- mouse selection and wheel work
- clipboard copy/paste works
- Chinese/IME input is tested
- `Esc` reliably returns the browser bridge to Normal mode
- browser-local Vim mappings do not leak characters into focused inputs

### Lifecycle

- close browser pane -> WebView controller/process resources released
- open/close at least 20 times -> no accumulating controller map entries or obvious handle leak
- WebView creation failure leaves the anchor terminal usable and reports a useful error
- closing the WezTerm window shuts down controllers before COM apartment teardown

### Networking/security

- use normal Windows/WebView2 certificate validation
- do **not** ship an `ignore-certificate-errors` default for native mode
- verify the user's enterprise/local CA works through the Windows trust environment if present
- use a dedicated WebView2 user-data folder; do not point at a live Chrome/Edge profile

## 6. Phase after P1: Window-to-Visual / CompositionController

Only evaluate this after the Windowed PoC is proven and airspace/DPI behavior has been measured.

Preferred escalation order:

1. **Windowed hosting** — current P1.
2. **Window-to-Visual hosting** — set `COREWEBVIEW2_FORCED_HOSTING_MODE=COREWEBVIEW2_HOSTING_MODE_WINDOW_TO_VISUAL` before WebView2 initialization; Microsoft describes this as nearly the Windowed developer model with improved DPI/scaling handling.
3. **Full CompositionController + DirectComposition** — only if native WezTerm overlays must compose above browser content or more precise composition control is required.

Full visual hosting is feasible: WebView2 can attach its visual tree to DirectComposition, and DirectComposition can compose visual content on the same HWND around content presented by DirectX/other direct drawing. But it also makes the host responsible for forwarding mouse/touch/pointer input and coordinate transformations, so it is deliberately not the first milestone.

## 7. CEF is not in initial scope

CEF's accelerated off-screen rendering can expose shared GPU textures and is a strong future option for cross-platform integration, but it carries much larger source/build/distribution complexity. Do not add CEF while validating the Windows WebView2 path.

## 8. Codex implementation order

Use this exact order:

1. Read this document and current `webtui` v0.2 code.
2. Implement **Gate A only** in `native/webview2-spike`.
3. Build and manually verify Gate A on Windows MSVC.
4. Commit the spike and its findings.
5. Establish clean WezTerm fork/build baseline (Gate B).
6. Add isolated `wezterm-webview` crate (Gate C).
7. Add `webtui --native` anchor protocol (Gate D).
8. Integrate bounds/lifecycle/focus into WezTerm (Gates E/F).
9. Add the JS Vim bridge (Gate G).
10. Add modal/airspace visibility gating (Gate H).
11. Run the full acceptance matrix.
12. Only then discuss making native mode the default or replacing v0.2.

At every gate, prefer a small commit that can be bisected. Do not combine the standalone spike, WezTerm integration, and Vim bridge into one giant change.

## 9. Explicit non-goals / forbidden shortcuts for P1

Do not:

- delete the current CDP renderer before native mode is accepted;
- use screenshots/screencasts as the native renderer;
- send browser pixels through PTY/OSC/Kitty/iTerm/Sixel;
- run WebView2 inside WSL;
- add `--no-sandbox` or disable certificate validation for native mode;
- reuse a live Edge/Chrome profile directory;
- implement a new terminal `mux::Pane` type in P1;
- mutate WezTerm state re-entrantly inside synchronous WebView callbacks;
- call WebView2 objects from arbitrary worker threads;
- begin with CEF or full DirectComposition integration.

## 10. Success definition

The native experiment succeeds when `webtui --native https://github.com` launched from an Arch WSL pane results in a real WebView2/Chromium surface occupying exactly that WezTerm pane, while the page is rendered/composited by WebView2 on Windows, Vim-style navigation works, splits/tabs/focus/lifecycle remain correct, and **no application-level pixel/frame transport exists between the browser and WezTerm**.
