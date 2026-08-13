# webtui

A Vim-like interactive browser frontend for **WezTerm**, backed by real Headless Chrome.

Chrome still owns HTML/CSS/JavaScript, cookies, SPA navigation, forms, canvas and the DOM. `webtui` turns the Chrome viewport into terminal graphics and maps Vim-style terminal input back into Chrome.

```text
WezTerm
  └─ webtui
       ├─ Vim input state machine
       ├─ latest-frame-only queue + FPS cap
       ├─ Kitty graphics or iTerm2 image renderer
       └─ Puppeteer + Chrome DevTools Protocol
            └─ Headless Chrome
```

## v0.2 rendering pipeline

v0.1 rendered each action using `page.screenshot()`. v0.2 uses CDP screencast frames instead:

```text
Chrome compositor
      │
      │ Page.startScreencast
      ▼
 latest frame only    <- stale frames are overwritten
      │
      │ 24 FPS cap by default
      ▼
 Kitty graphics / iTerm2 image protocol
      │
      ▼
   WezTerm
```

Screencast frames are acknowledged immediately so Chrome never waits for the terminal renderer. If terminal output cannot keep up, old frames are dropped instead of accumulating input latency.

The default **Kitty renderer** requests PNG frames and forwards CDP's already-base64-encoded PNG directly into Kitty graphics chunks. The **iTerm2 renderer** requests JPEG frames and can use much less bandwidth on photo-heavy pages.

## Install on Arch / Arch WSL

A minimal Arch install may need Chrome runtime libraries:

```bash
sudo pacman -S --needed \
  at-spi2-core libcups libxkbcommon alsa-lib mesa cairo pango \
  libxcomposite libxdamage libxrandr nss gtk3
```

Then:

```bash
git clone https://github.com/Tortes/webtui.git
cd webtui
npm install
npm run build
npm link
```

If Puppeteer did not download Chrome for the current user:

```bash
npx puppeteer browsers install chrome
```

Run:

```bash
webtui https://github.com
```

If your network uses a self-signed/enterprise TLS proxy and you only want to debug first:

```bash
webtui --ignore-certificate-errors https://github.com
```

Prefer installing the correct CA into the OS trust store for normal use.

## Keys

| Key | Action |
|---|---|
| `j` / `k` | scroll down/up |
| `Ctrl-d` / `Ctrl-u` | half page down/up |
| `gg` / `G` | top/bottom |
| `H` / `L` | back/forward |
| `r` | reload |
| `o` | open URL or search |
| `f` | show hints for visible interactive elements |
| `i` | enter Insert mode when an editable element is focused |
| `Esc` | return to Normal mode / cancel |
| `q` | quit |

Selecting an input/textarea/select/contenteditable target with `f` automatically enters Insert mode.

## Performance options

```text
webtui [options] [url-or-search]

--renderer=kitty|iterm
--fps=N
--ignore-certificate-errors
--chrome=/path/to/chrome
--jpeg-quality=N
-h, --help
```

Try both renderers on WSL:

```bash
webtui --renderer=kitty --fps=24 https://github.com
webtui --renderer=iterm --fps=24 https://github.com
```

If scrolling still feels delayed, reduce terminal redraw bandwidth:

```bash
webtui --fps=15 https://github.com
```

Environment equivalents:

```text
WEZTUI_RENDERER=kitty|iterm
WEZTUI_FPS=24
WEZTUI_IGNORE_CERT_ERRORS=1
WEZTUI_CHROME=/usr/bin/chromium
WEZTUI_JPEG_QUALITY=55
WEZTUI_USER_DATA_DIR=~/.weztui-browser-profile
WEZTUI_CELL_WIDTH=9
WEZTUI_CELL_HEIGHT=18
WEZTUI_SEARCH_URL=https://www.google.com/search?q=
```

## Optional WezTerm launcher

Copy `wezterm/webtui.lua` next to `.wezterm.lua`:

```lua
local wezterm = require 'wezterm'
local config = wezterm.config_builder()

local webtui = require 'webtui'
webtui.apply_to_config(config, {
  wsl = true,
  key = 'b',
  mods = 'CTRL|SHIFT',
  url = 'https://www.google.com',
})

return config
```

Then `Ctrl+Shift+B` opens `webtui` in a new WezTerm tab through WSL.

## Current limitations

- Full-screen video/high-FPS animation is constrained by terminal image bandwidth.
- Hint overlays are temporarily injected into the page DOM.
- New-window links currently stay in the same browser tab.
- Browser tabs, downloads, file pickers, clipboard integration and mouse passthrough are not implemented yet.
- Some sites behave differently in headless/automation environments.

## Next steps

- real browser tabs: `J/K`, `t`, `d`, `u`
- `F` for background-tab hints
- `yy`, `p`, `P` clipboard/URL operations
- `/`, `n`, `N` search
- mouse coordinate passthrough
- renderer telemetry: Chrome FPS, dropped frames, terminal MB/s and write latency
