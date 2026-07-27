@echo off
chcp 65001 >nul
title 天之川沙夜 · 启动器

:: 切换到脚本所在目录（%~dp0 末尾带反斜杠，直接使用即可）
cd /d "%~dp0"

:: ── 检查 Node.js ──────────────────────────────────────────────
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo  [错误] 未找到 Node.js
    echo         请先安装：https://nodejs.org
    echo.
    pause
    exit /b 1
)

:: ── 首次运行：安装依赖 ────────────────────────────────────────
if not exist "node_modules\" (
    echo.
    echo  [信息] 首次运行，正在安装依赖，请稍候...
    echo.
    call npm install
    if errorlevel 1 (
        echo.
        echo  [错误] 依赖安装失败，请检查网络后重试。
        pause
        exit /b 1
    )
)

:: ── 用 start 脱离 CMD 独立启动 Electron ──────────────────────
:: start "" 让 Electron 作为独立进程运行，CMD 窗口随即自动关闭
start "" /d "%~dp0" node_modules\.bin\electron.cmd .
