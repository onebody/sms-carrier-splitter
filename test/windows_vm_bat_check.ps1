﻿param(
  [string]$Pkg = 'C:\pkg-test\运营商拆表',
  [string]$BatOut = 'C:\pkg-test\bat-stdout.txt'
)
[Console]::OutputEncoding=[System.Text.Encoding]::UTF8
# 收集「双击 启动.bat」之后的现场证据（bat 由另一个计划任务跑，避免 Edge 继承本脚本的 stdout 句柄把脚本卡住）
# 用法：powershell -File windows_vm_bat_check.ps1 -Pkg C:\pkg-test\运营商拆表 -BatOut C:\pkg-test\bat-stdout.txt
$stage=Join-Path $env:PUBLIC 'sms-carrier-splitter\index.html'
$prof=Join-Path $env:LOCALAPPDATA 'sms-carrier-splitter\profile'
$pkg=$Pkg
"stage_appeared=" + (Test-Path -LiteralPath $stage)
if (Test-Path -LiteralPath $stage) {
  $a=(Get-FileHash -LiteralPath $stage -Algorithm SHA256).Hash
  $b=(Get-FileHash -LiteralPath (Join-Path $pkg 'app\index.html') -Algorithm SHA256).Hash
  "stage_bytes=" + (Get-Item -LiteralPath $stage).Length
  "sha_match=" + ($a -eq $b)
}
if (Test-Path -LiteralPath $batOut) {
  "bat_stdout_bytes=" + (Get-Item -LiteralPath $batOut).Length
  Get-Content -LiteralPath $batOut | ForEach-Object { "BAT| " + $_ }
}
# 启动器给的是 --app="file:///…"（等号后紧跟引号），所以通配符不能假设 --app= 后面直接是 file
$e=@(Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like '*--app=*index.html*' })
"app_procs=" + $e.Count
foreach ($p in $e) { "CMD pid=" + $p.ProcessId + " :: " + $p.CommandLine.Substring(0,[Math]::Min(240,$p.CommandLine.Length)) }
$w=@(Get-Process msedge -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -ne '' })
"app_windows=" + $w.Count
foreach ($x in $w) { "TITLE pid=" + $x.Id + " :: " + $x.MainWindowTitle }
"profile_used=" + (Test-Path $prof)
"holding_for_host_capture_seconds=8"
Start-Sleep -Seconds 8
foreach ($p in $e) { taskkill /F /T /PID $p.ProcessId 2>&1 | Out-Null }
Start-Sleep -Seconds 2
"edge_left=" + (@(Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like '*sms-carrier-splitter*' }).Count)
"--- bat collect finished ---"
