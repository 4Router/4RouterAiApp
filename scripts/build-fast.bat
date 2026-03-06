@echo off
chcp 65001 >nul 2>&1
setlocal enabledelayedexpansion

echo.
echo === 4RouterAi Fast Build (unpack only) ===
echo.

:: 1. Kill processes that may lock files
echo [1/6] Stopping processes...
taskkill /f /im electron.exe >nul 2>&1
taskkill /f /im 4RouterAi.exe >nul 2>&1
timeout /t 2 /nobreak >nul

:: 2. Clean old build
echo [2/6] Cleaning old build...
if exist release (
    rmdir /s /q release
)
timeout /t 1 /nobreak >nul

:: 3. Compile TypeScript (main process)
echo [3/6] Compiling TypeScript...
call npx tsc -p tsconfig.main.json
if %errorlevel% neq 0 (
    echo [FAILED] TypeScript compile failed!
    exit /b 1
)
echo   tsc OK

:: 4. Build Vite (renderer)
echo [4/6] Building Vite...
call npx vite build
if %errorlevel% neq 0 (
    echo [FAILED] Vite build failed!
    exit /b 1
)
echo   vite OK

:: 5. Bundle Node.js runtime and CLI tools
echo [5/6] Bundling Node.js runtime and CLI tools...
call node scripts\bundle-tools.mjs
if %errorlevel% neq 0 (
    echo [FAILED] Bundled runtime/tools failed!
    exit /b 1
)
echo   bundled tools OK

:: 6. Pack to dir only (no NSIS installer)
echo [6/6] Packaging to directory (skip installer)...
call npx electron-builder --win dir --config.win.requestedExecutionLevel=asInvoker
if %errorlevel% neq 0 (
    echo [RETRY] electron-builder failed, retrying...
    timeout /t 3 /nobreak >nul
    if exist release (
        rmdir /s /q release
    )
    timeout /t 2 /nobreak >nul
    call npx electron-builder --win dir --config.win.requestedExecutionLevel=asInvoker
    if !errorlevel! neq 0 (
        echo [FAILED] Package failed!
        exit /b 1
    )
)

echo.
if exist "release\win-unpacked\4RouterAi.exe" (
    echo === Fast Build Complete ===
    echo   Output: release\win-unpacked\
    echo   Run:    release\win-unpacked\4RouterAi.exe
) else (
    echo === Fast Build Complete (exe not found) ===
)

endlocal
