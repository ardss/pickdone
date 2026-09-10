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
;
; 2026-09-10 P2: the nsExec exit code is no longer ignored. nsExec::Exec pushes exactly ONE
; value — the bare decimal exit code, or "error"/"timeout" if the process could not be run at
; all (see Contrib/nsExec/nsExec.txt; the two-value output+code push belongs to ExecToStack).
; taskkill codes: 0 = matching process terminated, 128 = no matching process (nothing running).
; Both pass. Anything else (1/5 access denied: elevated instance, AV file lock, ...) used to
; continue silently and the install then died downstream with NSIS error :2 or a half-updated
; tree ("clicking the installer does nothing"). The MessageBox deliberately has NO /SD so it is
; visible even in silent installs; Abort stops before any file is touched.
!macro KillRunningInstance IMAGE ID
  nsExec::Exec 'taskkill /IM "${IMAGE}" /F'
  Pop $R0
  StrCmp $R0 "0" kill_ok_${ID}
  StrCmp $R0 "128" kill_ok_${ID}
    MessageBox MB_OK|MB_ICONEXCLAMATION "PickDone 正在运行，但无法自动关闭（退出码 $R0）。请手动退出 PickDone 后重试。$\n$\nA running PickDone instance could not be closed automatically (exit code: $R0). Please exit PickDone manually and try again."
    Abort
  kill_ok_${ID}:
!macroend
!macro customInit
  !insertmacro KillRunningInstance "PickDone.exe" initA
  !insertmacro KillRunningInstance "拾事.exe" initB
  Sleep 800
!macroend
!macro customUnInit
  !insertmacro KillRunningInstance "PickDone.exe" uninitA
  !insertmacro KillRunningInstance "拾事.exe" uninitB
  Sleep 800
!macroend
!macro customInstall
  ; 一次性迁移(≤0.2.1 中文 productName 遗留):旧程序目录清掉,防双入口+孤儿目录
  IfFileExists "$LOCALAPPDATA\Programs\拾事\*.*" 0 +2
    RMDir /r "$LOCALAPPDATA\Programs\拾事"
!macroend
