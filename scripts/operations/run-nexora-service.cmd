@echo off
setlocal
set "USERPROFILE=C:\Users\Nexora"
set "PAPERCLIP_NO_DESKTOP_ALERTS=true"
"C:\Program Files\nodejs\node.exe" --require "C:\Users\Nexora\paperclip\scripts\operations\nexora-supervisor-diagnostics.cjs" "C:\Users\Nexora\paperclip\scripts\operations\paperclip-control-plane-supervisor.mjs" --watch
exit /b %errorlevel%
