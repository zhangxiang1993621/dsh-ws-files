@echo off
rem ============================================================
rem  dsh-ws-files - one-click repack & reinstall script
rem  1) npm pack -> dist\dsh-ws-files-<version>.tgz
rem  2) install the tarball into the web profile
rem  3) you must restart dsh web afterwards
rem  Usage: double-click build.bat
rem ============================================================
setlocal
cd /d "%~dp0"

rem 1) Locate node/npm: prefer D:\install\node\nodejs, else PATH
set "NODEDIR=D:\install\node\nodejs"
if exist "%NODEDIR%\node.exe" (
    set "PATH=%NODEDIR%;%PATH%"
)
node -v >nul 2>nul
if errorlevel 1 (
    echo [ERROR] node not found on PATH.
    pause
    exit /b 1
)

rem 2) Package version (bump here when package.json version changes)
set "VERSION=0.1.4"
echo Packing dsh-ws-files v%VERSION% ...

rem 3) npm pack (creates dist\ if missing)
if not exist "dist" mkdir dist
call npm pack --pack-destination "dist"
if errorlevel 1 (
    echo [FAILED] npm pack error, see log above.
    pause
    exit /b 1
)

rem 4) Install the tarball into the web profile (from the harness repo)
set "REPO=D:\agent-workspace\deepseek-harness"
set "TGZ=file:D:/agent-workspace/dsh-ws-files/dist/dsh-ws-files-%VERSION%.tgz"
if exist "%REPO%\apps\cli\src\bin.ts" (
    echo Installing into web profile ...
    cd /d "%REPO%"
    node --import tsx/esm apps/cli/src/bin.ts plugin --profile web add "%TGZ%"
    if errorlevel 1 (
        echo [FAILED] plugin install error, see log above.
        pause
        exit /b 1
    )
) else (
    echo [WARN] harness repo not found at %REPO%; tarball created at %~dp0dist\ but not installed.
)

echo.
echo [OK] Repacked and installed dsh-ws-files v%VERSION%.
echo      Remember to restart dsh web to apply the change.
pause
