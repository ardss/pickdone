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
; 2026-09-11 P2: the nsExec exit code is no longer ignored. nsExec::Exec pushes exactly ONE
; value — the bare decimal exit code, or "error"/"timeout" if the process could not be run at
; all (see Contrib/nsExec/nsExec.txt; the two-value output+code push belongs to ExecToStack).
; taskkill codes: 0 = matching process terminated, 128 = no matching process (nothing running).
; Both pass. Anything else (1/5 access denied: elevated instance, AV file lock, ...) used to
; continue silently and the install then died downstream with NSIS error :2 or a half-updated
; tree ("clicking the installer does nothing"). The MessageBox deliberately has NO /SD so it is
; visible even in silent installs; Abort stops before any file is touched.
;
; 2026-09-11 "frozen progress bar" wave: on a HDD with real-time AV, the assisted installer
; sits motionless for minutes and reads as a hang (0.3.1 manual install, 2026-09-10 night).
; Root cause is presentation, not speed of code: installSection.nsh opens with
; `SetDetailsPrint none` and the details box is hidden by default, so the silent
; old-version uninstall + the extraction show a bar that barely moves and zero text.
; We cannot make user disks faster, but we can make the page visibly alive:
;   - ShowInstDetails show opens the details box for the whole install;
;   - customCheckAppRunning replaces the stock CHECK_APP_RUNNING (which would no-op anyway —
;     customInit already force-closed every instance) with the same bounded kill plus
;     `SetDetailsPrint both`, so electron-builder's own phase messages and every extracted
;     file name stream into the details box from the uninstall-old-version step onward;
;   - a LangString tells the user up front that the first silent phase can take minutes.
!macro KillRunningInstance IMAGE ID
  nsExec::Exec 'taskkill /IM "${IMAGE}" /F'
  Pop $R0
  StrCmp $R0 "0" kill_ok_${ID}
  StrCmp $R0 "128" kill_ok_${ID}
    MessageBox MB_OK|MB_ICONEXCLAMATION "PickDone 正在运行，但无法自动关闭（退出码 $R0）。请手动退出 PickDone 后重试。$\n$\nA running PickDone instance could not be closed automatically (exit code: $R0). Please exit PickDone manually and try again."
    Abort
  kill_ok_${ID}:
!macroend

; Detail-page phase labels. Numeric LANGIDs (1033 en-US / 2052 zh-CN) so the include does
; not depend on MUI defines being in scope at include time.
LangString nsUninstallingOld 1033 "Uninstalling the previous version... (can take 1-3 minutes on a mechanical drive)"
LangString nsUninstallingOld 2052 "正在卸载旧版本……机械硬盘上可能需要 1-3 分钟，请耐心等待"
LangString nsFinishingInstall 1033 "Finishing installation (cleaning up legacy files)..."
LangString nsFinishingInstall 2052 "正在收尾（清理遗留目录）……"

!macro customCheckAppRunning
  ; Replaces electron-builder's stock check on both assisted and silent paths: identical
  ; kill semantics (the pre-flight in customInit already closed everything, this is a
  ; re-verify against instances relaunched mid-wizard), plus progress output. Must stay
  ; bounded — no retry loops, failures surface via KillRunningInstance's MessageBox+Abort.
  !insertmacro KillRunningInstance "PickDone.exe" checkA
  !insertmacro KillRunningInstance "拾事.exe" checkB
  SetDetailsPrint both
  DetailPrint "$(nsUninstallingOld)"
!macroend

; Compile-time attribute — must live at global scope (NSIS rejects it inside a Function,
; proven by the local makensis pass on 2026-09-11); the include lands in the generated
; script's header, which is global. Applies to installer and uninstaller alike.
ShowInstDetails show

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
  DetailPrint "$(nsFinishingInstall)"
  ; 一次性迁移(≤0.2.1 中文 productName 遗留):旧程序目录清掉,防双入口+孤儿目录
  IfFileExists "$LOCALAPPDATA\Programs\拾事\*.*" 0 +2
    RMDir /r "$LOCALAPPDATA\Programs\拾事"
!macroend
