@echo off
rem dsh-bridge - lop dem cho DSH web (WebSocket native + transport polling).
rem Chay cua so nay trong nen; dong cua so la tat bridge.
setlocal
cd /d "%~dp0"
if "%BRIDGE_PORT%"=="" set BRIDGE_PORT=3090
if "%BRIDGE_UPSTREAM_PORT%"=="" set BRIDGE_UPSTREAM_PORT=3080
echo dsh-bridge: http://127.0.0.1:%BRIDGE_PORT%  ->  DSH http://127.0.0.1:%BRIDGE_UPSTREAM_PORT%
echo chan doan:   http://127.0.0.1:%BRIDGE_PORT%/__dsh_bridge/diag
node "%~dp0dsh-bridge.cjs"
echo.
echo dsh-bridge da dung. Bam phim bat ky de dong.
pause >nul