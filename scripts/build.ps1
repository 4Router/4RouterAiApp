# 4RouterAi Build Script
# Usage: .\scripts\build.ps1

Write-Host "=== 4RouterAi Build ===" -ForegroundColor Cyan

# 1. Kill processes that may lock files
Write-Host "[1/5] Stopping processes..." -ForegroundColor Yellow
Get-Process -Name "electron","4RouterAi" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep 2

# 2. Clean old build
Write-Host "[2/5] Cleaning old build..." -ForegroundColor Yellow
Remove-Item -Recurse -Force release -ErrorAction SilentlyContinue
Start-Sleep 1

# 3. Compile TypeScript (main process)
Write-Host "[3/5] Compiling TypeScript..." -ForegroundColor Yellow
npx tsc -p tsconfig.main.json
if ($LASTEXITCODE -ne 0) {
    Write-Host "TypeScript compile FAILED!" -ForegroundColor Red
    exit 1
}
Write-Host "  tsc OK" -ForegroundColor Green

# 4. Build Vite (renderer)
Write-Host "[4/5] Building Vite..." -ForegroundColor Yellow
npx vite build
if ($LASTEXITCODE -ne 0) {
    Write-Host "Vite build FAILED!" -ForegroundColor Red
    exit 1
}
Write-Host "  vite OK" -ForegroundColor Green

# 5. Package EXE
Write-Host "[5/5] Packaging EXE..." -ForegroundColor Yellow
npx electron-builder --win nsis --config.win.requestedExecutionLevel=asInvoker
if ($LASTEXITCODE -ne 0) {
    Write-Host "electron-builder failed, retrying..." -ForegroundColor Yellow
    Start-Sleep 3
    Remove-Item -Recurse -Force release -ErrorAction SilentlyContinue
    Start-Sleep 2
    npx electron-builder --win nsis --config.win.requestedExecutionLevel=asInvoker
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Package FAILED!" -ForegroundColor Red
        exit 1
    }
}

# Done
$exe = Get-ChildItem release -Filter "*.exe" | Where-Object { $_.Name -like "*Setup*" } | Select-Object -First 1
if ($exe) {
    $sizeMB = [math]::Round($exe.Length / 1MB, 1)
    Write-Host "`n=== Build Complete ===" -ForegroundColor Green
    Write-Host "  File: release\$($exe.Name)" -ForegroundColor Green
    Write-Host "  Size: ${sizeMB} MB" -ForegroundColor Green
} else {
    Write-Host "=== Build Complete (no installer found) ===" -ForegroundColor Yellow
}
