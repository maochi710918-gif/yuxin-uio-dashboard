@echo off
chcp 65001 >nul
rem 把儀表板匯出的 Excel 拖曳到這個檔案上即可補回地端個資。
if "%~1"=="" (
  echo 請把儀表板匯出的 Excel 檔「拖曳」到這個 還原個資.bat 圖示上。
  pause
  exit /b 1
)
python "%~dp0restore_pii.py" "%~1"
if %errorlevel%==0 start "" "%USERPROFILE%\UIO含個資名單"
pause
