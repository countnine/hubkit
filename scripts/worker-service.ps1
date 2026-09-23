# 워커를 창 없이 상주시킨다. **관리자 권한이 필요 없다.**
#
# hubkit 의 공용 스크립트다. 소비 프로젝트는 얇은 래퍼에서 이것을 부른다:
#
#   $hubkit = Join-Path $PSScriptRoot '..\node_modules\hubkit\scripts\worker-service.ps1'
#   & $hubkit -ProjectRoot (Split-Path -Parent $PSScriptRoot) -Name npay @args
#
#   npm run worker:bg        시작 (창이 뜨지 않고, 터미널을 닫아도 살아 있다)
#   npm run worker:status    상태와 최근 로그
#   npm run worker:stop      중지
#   ... -Install             로그온할 때 저절로 시작 (-Uninstall 로 해제)
#
# 워커를 어떻게 찾는가 ──────────────────────────────────────────────────
# **PID 파일만 본다.** 명령줄 문자열로 찾지 않는다.
#
# 예전에는 `CommandLine -like '*src/index.ts worker*'` 로 찾았는데, 이 PC 에는 같은
# 모양으로 도는 워커가 셋(autoapply·PreviewAuto·npayEvent)이라 한 프로젝트의 `-Stop`
# 한 번이 **다른 프로젝트의 워커 세 개를 같이 죽였다.** 절대 경로를 박아 막아 봤지만
# 그것은 메커니즘이 아니라 문자열 관습이라, 런처가 한 줄만 바뀌면 다시 무장된다.
#
# 이제 워커 프로세스가 시작할 때 data\worker.pid 에 자기 신원을 적는다
# (hubkit/process 의 acquire). 상주 스크립트로 띄웠든 터미널에서 `npm run worker` 를
# 했든 같다 — 터미널 워커가 여기 안 잡히던 구멍도 그래서 닫혔다.
#
# 죽이기 전에 네 가지를 확인한다. 하나라도 어긋나면 **건드리지 않는다.**
#   1) 기록의 root 가 이 프로젝트인가
#   2) 그 PID 가 살아 있는가
#   3) 그 PID 의 **시작 시각이 기록과 같은가** — PID 는 재사용된다
#   4) 명령줄에 이 프로젝트 경로가 있는가 (이중 확인)
#
# 왜 서비스도 작업 스케줄러도 아닌가 ────────────────────────────────────
# 워커는 크롬을 연다. 윈도우 서비스는 세션 0 에서 돌아 **데스크톱이 없고**, 거기서는
# 크롬이 뜨지 못한다. 작업 스케줄러는 그 문제가 없지만 **등록에 관리자 권한이 필요**해
# (0x80070005) "나중에 해야지" 가 된다. 그래서 관리자 없이 되는 두 가지만 쓴다:
# wscript //B 로 창 없이 띄우고, 로그온 자동 시작은 시작 프로그램 폴더에 둔다.

[CmdletBinding()]
param(
  # 소비 프로젝트의 루트. 래퍼가 넘긴다.
  [Parameter(Mandatory = $true)][string]$ProjectRoot,
  # 시작 프로그램 항목 이름의 접두사 (예: 'npay' → npay-worker-<tag>.vbs).
  [Parameter(Mandatory = $true)][string]$Name,
  # 워커를 띄우는 명령. 기본은 세 프로젝트가 공유하는 모양이다.
  [string]$Entry = 'src\index.ts',
  [string[]]$NodeArgs = @('--disable-warning=ExperimentalWarning', '--experimental-transform-types'),
  [switch]$Install,     # 로그온 자동 시작 등록 (+ 바로 시작)
  [switch]$Uninstall,
  [switch]$Start,
  [switch]$Stop,
  [switch]$Restart,
  [switch]$Status,
  # 워커가 끝난 뒤 다시 띄우기까지 기다리는 시간. 설정이 틀려 즉시 죽는 경우에
  # 초당 수십 번 재시도하지 않게 하는 값이다.
  [int]$RetrySeconds = 30
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = (Resolve-Path $ProjectRoot).Path.TrimEnd([char]92)
$DataDir  = Join-Path $ProjectRoot 'data'
$PidFile  = Join-Path $DataDir 'worker.pid'
$KeeperPidFile = Join-Path $DataDir 'worker-keeper.pid'
$LogFile  = Join-Path $DataDir 'worker.log'
$StopFlag = Join-Path $DataDir 'worker.stop'
# 생성물은 **소비 프로젝트** 안에 둔다. node_modules 는 재설치로 날아간다.
$Runner   = Join-Path $ProjectRoot 'scripts\worker.cmd'
$Vbs      = Join-Path $ProjectRoot 'scripts\worker.vbs'
$WScript  = Join-Path (Join-Path $env:SystemRoot 'System32') 'wscript.exe'

# 시작 시각 비교 허용 오차. node 의 process.uptime() 기준 계산과 윈도우가 보고하는
# 프로세스 생성 시각은 런타임이 뜨는 만큼 차이가 난다.
$StartToleranceSeconds = 15

# 시작 프로그램 항목 이름에 이 루트만의 꼬리표를 붙인다.
#
# git 워크트리가 본체를 덮어쓰는 사고를 막는다 — `_wt\autoapply-mask-token` 과
# `autoapply` 가 지금 **같은 파일 이름**을 쓰고 있어서, 워크트리에서 -Install 하면
# 로그온 자동 시작이 조용히 워크트리를 가리키고 거기서 -Uninstall 하면 본체 것이 지워진다.
$sha = [System.Security.Cryptography.SHA256]::Create()
$RootTag = ([System.BitConverter]::ToString(
    $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($ProjectRoot.ToLower()))
  ) -replace '-', '').Substring(0, 8).ToLower()
$sha.Dispose()
$StartupDir  = [Environment]::GetFolderPath('Startup')
$StartupLink = Join-Path $StartupDir "$Name-worker-$RootTag.vbs"
# 꼬리표가 없던 시절의 이름. 내용이 이 루트를 가리킬 때만 정리한다.
$LegacyStartupLink = Join-Path $StartupDir "$Name-worker.vbs"

function Read-Identity([string]$File) {
  if (-not (Test-Path $File)) { return $null }
  try { return Get-Content $File -Raw -Encoding UTF8 | ConvertFrom-Json } catch { return $null }
}

# 기록된 프로세스가 **지금도 그 프로세스인지** 확인한다. 아니면 $null.
function Resolve-Recorded([string]$File) {
  $id = Read-Identity $File
  if (-not $id) { return $null }

  # 1) 이 프로젝트의 기록인가
  if ($id.root -and ($id.root.TrimEnd('\') -ine $ProjectRoot.TrimEnd('\'))) { return $null }

  # 2) 살아 있는가
  $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$($id.pid)" -ErrorAction SilentlyContinue
  if (-not $proc) { return $null }

  # 3) 같은 프로세스인가 — PID 는 재사용된다. 이 검사가 이 파일의 존재 이유다.
  if ($id.startedAt) {
    $recorded = [DateTime]::Parse($id.startedAt).ToUniversalTime()
    $actual = $proc.CreationDate.ToUniversalTime()
    if ([Math]::Abs(($actual - $recorded).TotalSeconds) -gt $StartToleranceSeconds) { return $null }
  }

  # 4) 워커는 언제나 node 다. 형태가 전혀 다르면 남의 프로세스다.
  #
  # 예전에는 여기서 "명령줄에 이 프로젝트 경로가 있는가" 를 봤다. 이중 확인처럼
  # 보였지만 **고치려던 바로 그 경우를 탈락시켰다** — 터미널의 `npm run worker` 는
  # 명령줄이 상대 경로(`src/index.ts worker`)라 프로젝트 경로가 없다. 그래서
  # 워커가 PID 파일을 정상으로 써 놓고도 status 에 '없음' 으로 나왔다.
  #
  # 1~3 이 이미 "이 파일을 쓴 바로 그 프로세스"를 증명한다. 그 파일은 이 프로젝트의
  # data\ 에서 도는 워커만 쓸 수 있고, PID 재사용은 3 이 막는다. 경로 검사는
  # 안전을 더하지 않으면서 거짓 음성만 만들었다.
  if ($proc.Name -ne 'node.exe' -and $proc.Name -ne 'wscript.exe') { return $null }

  return [PSCustomObject]@{ Id = $id; Process = $proc }
}

function Show-Status {
  $worker = Resolve-Recorded $PidFile
  $keeper = Resolve-Recorded $KeeperPidFile

  if ($keeper) { Write-Host "감시 스크립트 : 실행 중 (PID $($keeper.Id.pid))" }
  else { Write-Host '감시 스크립트 : 없음 — 워커가 죽어도 다시 뜨지 않습니다' }

  if ($worker) {
    $up = [int]((Get-Date).ToUniversalTime() - $worker.Process.CreationDate.ToUniversalTime()).TotalMinutes
    Write-Host "워커 프로세스 : 실행 중 (PID $($worker.Id.pid), $up 분째)"
  } else {
    Write-Host '워커 프로세스 : 없음'
    # 스스로 끝냈으면 이유가 남는다. **없으면 밖에서 죽은 것이다** — 그 차이가 진단이다.
    $last = Read-Identity $PidFile
    if ($last) {
      if ($last.lastExit) {
        $at = [DateTime]::Parse($last.lastExit.at).ToLocalTime()
        Write-Host "마지막 종료   : $($at.ToString('HH:mm:ss')) · $($last.lastExit.reason) · $($last.lastExit.upSeconds)초 실행 후"
      } else {
        Write-Host "마지막 기록   : PID $($last.pid) — 종료 기록이 없습니다 (밖에서 죽었을 수 있습니다)"
      }
    }
  }

  if (Test-Path $StopFlag) { Write-Host '중지 표시     : 있음 (-Start 하면 지워집니다)' }
  if (Test-Path $StartupLink) { Write-Host "로그온 시 시작: 등록됨 ($(Split-Path $StartupLink -Leaf))" }
  else { Write-Host '로그온 시 시작: 안 됨 (-Install 로 등록)' }

  if (Test-Path $LogFile) {
    Write-Host "`n--- $LogFile (마지막 12줄) ---"
    # -Encoding UTF8 이 없으면 PowerShell 5.1 이 ANSI 로 읽어 한글이 깨진다.
    Get-Content $LogFile -Tail 12 -Encoding UTF8
  }
  Write-Host "`n허브 화면의 〈워커 PC〉 카드가 최종 판정입니다 — 폴링이 닿고 있는지는 거기서만 보입니다."
}

function Write-Launchers {
  New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
  # 로그가 무한정 자라지 않게 한 번 접는다.
  if ((Test-Path $LogFile) -and (Get-Item $LogFile).Length -gt 5MB) {
    Move-Item -Force $LogFile "$LogFile.1"
  }

  # node 는 절대 경로로 부른다. 시작 프로그램의 PATH 는 로그인 셸과 다를 수 있다.
  $node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
  if (-not $node) { throw 'node.exe 를 찾지 못했습니다. Node.js 가 설치돼 있는지 확인하세요.' }

  # npm 을 거치지 않고 node 를 직접 부른다 — 프로세스 계층이 한 단계 짧아진다.
  # package.json 의 worker 스크립트와 같은 명령이어야 한다.
  $entryPath = Join-Path $ProjectRoot $Entry
  $flags = $NodeArgs -join ' '
  @"
@echo off
cd /d "$ProjectRoot"
echo [%date% %time%] worker start >> "$LogFile"
"$node" $flags "$entryPath" worker >> "$LogFile" 2>&1
echo [%date% %time%] worker exit %errorlevel% >> "$LogFile"
"@ | Set-Content -Path $Runner -Encoding OEM

  # VBS 는 ANSI 로 읽힌다. 내용은 ASCII 로만 쓴다.
  if ($ProjectRoot -match '[^\x00-\x7F]') {
    Write-Warning "프로젝트 경로에 비ASCII 문자가 있어 창 숨김이 동작하지 않을 수 있습니다: $ProjectRoot"
  }

  # 0 = 창 없이, True = 끝날 때까지 기다린다. 끝났다는 것은 워커가 죽었다는 뜻이므로
  # 중지 표시가 없으면 다시 띄운다. 이것이 작업 스케줄러의 반복 트리거를 대신한다.
  @"
' Generated by scripts\worker-service.ps1. Do not edit by hand.
' Keeps the worker alive with no console window.
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
Do
  If fso.FileExists("$StopFlag") Then Exit Do
  sh.Run """$Runner""", 0, True
  If fso.FileExists("$StopFlag") Then Exit Do
  WScript.Sleep $($RetrySeconds * 1000)
Loop
"@ | Set-Content -Path $Vbs -Encoding ASCII
}

function Start-Worker {
  $worker = Resolve-Recorded $PidFile
  $keeper = Resolve-Recorded $KeeperPidFile
  if ($worker -or $keeper) {
    Write-Host '이미 돌고 있습니다.'
    if ($worker) { Write-Host "  워커 PID $($worker.Id.pid)" }
    if ($keeper) { Write-Host "  감시 PID $($keeper.Id.pid)" }
    Write-Host '다시 띄우려면: npm run worker:restart'
    return
  }

  Write-Launchers
  if (Test-Path $StopFlag) { Remove-Item -Force $StopFlag }

  # wscript 는 콘솔이 없어 이 터미널을 닫아도 죽지 않는다.
  $proc = Start-Process -FilePath $WScript -ArgumentList '//B', '//Nologo', "`"$Vbs`"" `
    -WorkingDirectory $ProjectRoot -WindowStyle Hidden -PassThru

  # 감시 스크립트의 신원도 워커와 같은 형식으로 적는다. 여기서만 알 수 있는 값이라
  # 노드가 아니라 이 스크립트가 쓴다.
  $keeperId = [ordered]@{
    pid       = $proc.Id
    startedAt = $proc.StartTime.ToUniversalTime().ToString('o')
    project   = $Name
    root      = $ProjectRoot
    machine   = $env:COMPUTERNAME.ToLower()
    role      = 'keeper'
  }
  $keeperId | ConvertTo-Json | Set-Content -Path $KeeperPidFile -Encoding UTF8

  Start-Sleep -Seconds 4
  if (Resolve-Recorded $KeeperPidFile) {
    Write-Host '시작했습니다. 창은 뜨지 않고, 이 터미널을 닫아도 계속 돕니다.'
    Write-Host '허브 화면의 〈워커 PC〉 카드에서 연결을 확인하세요.'
  } else {
    Write-Host '시작하지 못했습니다. 로그를 확인하세요:'
    Write-Host "  $LogFile"
  }
}

function Stop-Worker {
  # 표시부터 만든다. 먼저 죽이면 감시 스크립트가 30초 뒤 되살린다.
  New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
  Set-Content -Path $StopFlag -Value 'stop' -Encoding ASCII

  $killed = 0
  foreach ($file in @($KeeperPidFile, $PidFile)) {
    $target = Resolve-Recorded $file
    if (-not $target) {
      $recorded = Read-Identity $file
      if ($recorded) {
        Write-Host "  건너뜀: PID $($recorded.pid) 는 이 프로젝트의 살아 있는 프로세스가 아닙니다"
      }
      continue
    }
    Write-Host "  종료: PID $($target.Id.pid) ($($target.Process.Name))"
    Stop-Process -Id $target.Id.pid -Force -ErrorAction SilentlyContinue
    $killed += 1
  }
  if ($killed -eq 0) { Write-Host '돌고 있는 워커가 없습니다.' } else { Write-Host '중지했습니다.' }
}

function Install-Startup {
  Write-Launchers
  # 시작 프로그램의 한 줄이 프로젝트의 worker.vbs 를 부른다. 내용을 복사하지 않는
  # 이유: 재시도 간격 같은 것을 고쳤을 때 두 곳이 갈라지면 안 된다.
  @"
' Generated by scripts\worker-service.ps1 -Install. Do not edit by hand.
' root: $ProjectRoot
CreateObject("WScript.Shell").Run """$Vbs""", 0, False
"@ | Set-Content -Path $StartupLink -Encoding ASCII

  # 꼬리표 없던 시절의 항목이 이 루트를 가리키면 정리한다. 다른 루트를 가리키면
  # 남의 것이므로 둔다.
  if ((Test-Path $LegacyStartupLink) -and
      ((Get-Content $LegacyStartupLink -Raw) -like "*$ProjectRoot*")) {
    Remove-Item -Force $LegacyStartupLink
    Write-Host "예전 이름의 항목을 정리했습니다: $(Split-Path $LegacyStartupLink -Leaf)"
  }
  Write-Host "로그온할 때 저절로 시작합니다: $StartupLink"
}

function Uninstall-Startup {
  foreach ($link in @($StartupLink, $LegacyStartupLink)) {
    if (-not (Test-Path $link)) { continue }
    # **이 루트를 가리키는 것만** 지운다. 워크트리나 다른 복사본의 항목을 지우면 안 된다.
    if ((Get-Content $link -Raw) -like "*$ProjectRoot*") {
      Remove-Item -Force $link
      Write-Host "제거: $(Split-Path $link -Leaf)"
    } else {
      Write-Host "건너뜀: $(Split-Path $link -Leaf) 은 다른 폴더를 가리킵니다"
    }
  }
}

if ($Uninstall) {
  Stop-Worker
  Uninstall-Startup
  foreach ($f in @($Runner, $Vbs)) { if (Test-Path $f) { Remove-Item -Force $f } }
  Write-Host '자동 시작을 해제하고 생성된 파일을 지웠습니다.'
  return
}
if ($Install) { Install-Startup; Start-Worker; return }
if ($Restart) { Stop-Worker; Start-Sleep -Seconds 2; Start-Worker; return }
if ($Stop) { Stop-Worker; return }
if ($Start) { Start-Worker; return }

Show-Status
