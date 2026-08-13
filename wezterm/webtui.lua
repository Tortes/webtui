local wezterm = require 'wezterm'
local M = {}

-- Optional WezTerm helper module.
--
-- local webtui = require 'webtui'
-- webtui.apply_to_config(config, { wsl = true })
function M.apply_to_config(config, opts)
  opts = opts or {}
  config.keys = config.keys or {}

  local url = opts.url or 'https://www.google.com'
  local args

  if opts.wsl then
    args = { 'wsl.exe', 'bash', '-lic', 'webtui ' .. url }
  elseif wezterm.target_triple:find('windows') then
    args = { 'cmd.exe', '/c', 'webtui.cmd', url }
  else
    args = { 'webtui', url }
  end

  table.insert(config.keys, {
    key = opts.key or 'b',
    mods = opts.mods or 'CTRL|SHIFT',
    action = wezterm.action.SpawnCommandInNewTab {
      args = args,
    },
  })
end

return M
