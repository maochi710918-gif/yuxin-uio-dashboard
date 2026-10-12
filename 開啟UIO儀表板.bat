@echo off
rem Opens the UIO dashboard; starts the dev server first when it is not running (logic in scripts\start-dashboard.ps1).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-dashboard.ps1"
