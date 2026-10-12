# 啟動裕信 UIO 儀表板：伺服器沒在跑時，開一個最小化視窗執行 npm run dev，就緒後用預設瀏覽器開啟。
# 伺服器視窗是獨立的 Windows 程序，不依附 Claude 或任何編輯器。
$root = Split-Path -Parent $PSScriptRoot
$url = "http://127.0.0.1:5173/"

# 以「連接埠是否在監聽」判斷伺服器是否已啟動（首次啟動頁面編譯可能要數十秒，不能用網頁回應判斷）。
function Test-Listening { [bool](Get-NetTCPConnection -LocalPort 5173 -State Listen -ErrorAction SilentlyContinue) }
function Test-Starting { [bool](Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'run-framework' }) }

if (-not (Test-Listening)) {
  if (-not (Test-Starting)) {
    Write-Host "正在啟動儀表板伺服器（首次約需 1 分鐘），請勿關閉工作列上的「UIO儀表板伺服器」視窗…"
    Start-Process -FilePath "cmd.exe" -ArgumentList "/k", "title UIO儀表板伺服器（請勿關閉） && npm run dev" -WorkingDirectory $root -WindowStyle Minimized
  } else {
    Write-Host "伺服器正在啟動中，請稍候…"
  }
  $deadline = (Get-Date).AddMinutes(5)
  while (-not (Test-Listening)) {
    if ((Get-Date) -gt $deadline) {
      Write-Host "伺服器啟動逾時，請打開工作列上的「UIO儀表板伺服器」視窗，把畫面截圖給 Claude。"
      Read-Host "按 Enter 關閉"
      exit 1
    }
    Start-Sleep -Seconds 2
  }
  # 讓第一次頁面編譯完成再開瀏覽器，避免看到空白頁。
  try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 120 $url | Out-Null } catch { }
}
# 直接走登入網址：未登入的瀏覽器也會自動登入後進入儀表板。
Start-Process "${url}signin-with-chatgpt?return_to=/"
