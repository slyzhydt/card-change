@echo off
cd /d "%~dp0"
python selector.py
if errorlevel 1 pause
