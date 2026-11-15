@echo off
setlocal DisableDelayedExpansion
node "%~dp0scripts\start-dev.cjs"
exit /b %errorlevel%
