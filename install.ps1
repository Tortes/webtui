$ErrorActionPreference = "Stop"

Write-Host "[webtui] Installing npm dependencies..."
npm install

Write-Host "[webtui] Building TypeScript..."
npm run build

Write-Host "[webtui] Linking the webtui command globally..."
npm link

Write-Host ""
Write-Host "Installed. Open WezTerm and try:"
Write-Host "  webtui https://github.com"
