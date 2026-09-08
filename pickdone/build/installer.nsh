; Installer/uninstaller pre-flight: kill any resident app instance before touching files.
; Close-to-tray means the process survives window close; a running 拾事.exe locks the old
; install dir and the new installer fails to uninstall it with NSIS error code :2.
!macro customInit
  nsExec::Exec 'taskkill /IM "拾事.exe" /T /F'
  Sleep 800
!macroend
!macro customUnInit
  nsExec::Exec 'taskkill /IM "拾事.exe" /T /F'
  Sleep 800
!macroend
