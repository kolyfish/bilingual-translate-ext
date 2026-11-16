@echo off
rem 雙語對照翻譯：Windows 安裝程式
rem 決策: Chrome 不允許從商店以外一鍵安裝，這裡做到能自動的都自動：
rem       放好檔案、打開擴充頁面、把路徑放進剪貼簿；「載入未封裝項目」要使用者自己點
chcp 65001 >nul
setlocal

set "HERE=%~dp0"
set "DEST=%USERPROFILE%\Extensions\bilingual-translate-ext"

echo == 雙語對照翻譯 安裝程式 ==

if not exist "%HERE%extension\manifest.json" (
  echo 找不到 extension 資料夾。請先把整個 zip 解壓縮，再執行這個安裝程式。
  pause
  exit /b 1
)

if not exist "%USERPROFILE%\Extensions" mkdir "%USERPROFILE%\Extensions"
rem 重新安裝（更新）時先移除舊版
if exist "%DEST%" rmdir /s /q "%DEST%"
xcopy "%HERE%extension" "%DEST%\" /e /i /q /y >nul
if errorlevel 1 (
  echo 複製檔案失敗，請確認有寫入 %USERPROFILE% 的權限。
  pause
  exit /b 1
)

rem 不換行地複製到剪貼簿
<nul set /p "=%DEST%" | clip
echo 已安裝到：%DEST%
echo 這個路徑已經複製到剪貼簿。
echo.

start "" chrome "chrome://extensions"
if errorlevel 1 echo 請自己打開 Chrome，在網址列輸入 chrome://extensions

echo 接下來在 Chrome 的「擴充功能」頁面：
echo   1. 打開右上角的「開發人員模式」
echo   2. 點左上角「載入未封裝項目」
echo   3. 在選資料夾的視窗，點上方的路徑列，按 Ctrl + V 貼上路徑，按 Enter
echo   4. 按「選擇資料夾」
echo 完成後，工具列會出現紅色「譯」字圖示（沒看到的話，點拼圖圖示把它釘選出來）。
echo.
echo 以後要更新：用新版的安裝包再跑一次這個程式，然後在擴充功能頁面按重新載入。
echo.
pause
