@echo off
chcp 65001 >nul
title 天之川沙夜 · 创建桌面快捷方式

cd /d "%~dp0"

set "ICON=%~dp0assets\icons\icon.ico"
set "TARGET=%~dp0启动沙夜.bat"
set "DESKTOP=%USERPROFILE%\Desktop"
set "LNK=%DESKTOP%\天之川沙夜.lnk"

if not exist "%ICON%" (
    echo.
    echo  [错误] 找不到图标：assets\icons\icon.ico
    echo.
    pause
    exit /b 1
)

if not exist "%TARGET%" (
    echo.
    echo  [错误] 找不到启动脚本：启动沙夜.bat
    echo.
    pause
    exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ws = New-Object -ComObject WScript.Shell; ^
   $s = $ws.CreateShortcut('%LNK%'); ^
   $s.TargetPath = '%TARGET%'; ^
   $s.WorkingDirectory = '%~dp0'; ^
   $s.IconLocation = '%ICON%'; ^
   $s.Description = '天之川沙夜 · 桌面陪伴'; ^
   $s.Save(); ^
   Write-Host '已创建桌面快捷方式：' '%LNK%'"

if errorlevel 1 (
    echo.
    echo  [错误] 创建快捷方式失败
    pause
    exit /b 1
)

echo.
echo  完成。桌面上应出现「天之川沙夜」图标。
echo.
pause
