@echo off
chcp 65001 >nul
cd /d F:\projects\lancer
set LANCER_LOCALE=zh-CN
echo Starting Lancer (dev mode)...
call npx --yes pnpm@10.34.9 dev
if errorlevel 1 (
  echo.
  echo Lancer exited with an error. Check the messages above.
  pause
)
