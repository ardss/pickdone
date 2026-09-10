; Installer/uninstaller pre-flight: kill any resident app instance before touching files.
; Close-to-tray means the process survives window close; a running app exe locks the old
; install dir and the new installer fails to uninstall it with NSIS error code :2.
;
; NO /T flag here, and that is load-bearing: the in-app updater spawns this installer as
; a CHILD process of the running app (detached spawn severs the console, not the parent
; link), so a tree-kill on "PickDone.exe" walks down into the installer itself and we
; silently abort our own update (0.3.0 in-app "restart to update" no-op, 2026-09-10).
; Plain /IM /F matches every image named PickDone.exe — the main process and the Chromium
; child processes are the same executable — while the installer's own image name
; (PickDone-Setup-*.exe) never matches and nothing tree-walks into it.
; Two names are killed on purpose: PickDone.exe is the current product name (>= 0.2.2);
; 拾事.exe covers installs from <= 0.2.1, which shipped with a Chinese productName and
; therefore lived in %LOCALAPPDATA%\Programs\拾事 — the customInstall migration removes
; that orphaned directory after a successful install (user data in %APPDATA%\pickdone
; is never touched; it was ASCII-safe all along).
!macro customInit
  nsExec::Exec 'taskkill /IM "PickDone.exe" /F'
  nsExec::Exec 'taskkill /IM "拾事.exe" /F'
  Sleep 800
!macroend
!macro customUnInit
  nsExec::Exec 'taskkill /IM "PickDone.exe" /F'
  nsExec::Exec 'taskkill /IM "拾事.exe" /F'
  Sleep 800
!macroend
!macro customInstall
  ; 一次性迁移(≤0.2.1 中文 productName 遗留):旧程序目录清掉,防双入口+孤儿目录
  IfFileExists "$LOCALAPPDATA\Programs\拾事\*.*" 0 +2
    RMDir /r "$LOCALAPPDATA\Programs\拾事"
!macroend
