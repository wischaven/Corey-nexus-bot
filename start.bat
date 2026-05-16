@echo off
title NEXUS Bot Servers
cd /d "C:\Users\corey\Coreynexus"

echo Starting NEXUS Bot...
echo.

:: Start proxy server in a new window
start "NEXUS Proxy (port 3000)" cmd /k "node proxy.js"

:: Small delay so proxy starts first
timeout /t 2 /nobreak >nul

:: Start static file server accessible on local network
start "NEXUS Frontend (port 8000)" cmd /k "npx serve -p 8000 -l tcp://0.0.0.0:8000"

echo.
echo Both servers starting...
echo Proxy:    http://localhost:3000
echo Frontend: http://localhost:8000
echo.
echo Close this window when done. Use the other windows to monitor server logs.
pause
