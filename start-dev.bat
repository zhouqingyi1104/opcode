@echo off
title opcode (dev)
cd /d D:\Projects\opcode
echo ==========================================================
echo   opcode - starting in development mode
echo.
echo   First compile after a code change: 20-40 seconds.
echo   The app window opens when the compile finishes.
echo   Close this console window to stop the app.
echo ==========================================================
echo.
call npm run tauri dev
echo.
echo [app exited] press any key to close this window...
pause
