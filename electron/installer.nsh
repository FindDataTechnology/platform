; ── Steward drain-before-swap (add-cell-lifecycle 2.3) ─────────────────────
;
; NSIS assisted-installer hooks. Updates replace files inside the per-user
; install dir; a running resident steward holds filenames open on Windows and
; would make the swap fail. Drain it first by pid — %APPDATA%\Platform\
; steward.pid is numbers-only (written by the steward on listen), so NSIS
; never has to parse JSON; taskkill /PID is precise, /IM would kill the
; user's other Node processes. /T takes the steward's supervised stack with it:
; the backends are children of the steward and hold the bundled node.exe — a
; pid-only kill leaves them orphaned, locking files mid-swap (update) or
; surviving the uninstall.

!macro customInit
  IfFileExists "$APPDATA\Platform\steward.pid" 0 done_steward
    FileOpen $0 "$APPDATA\Platform\steward.pid" r
    FileRead $0 $1
    FileClose $0
    IntCmp $1 0 done_steward
      DetailPrint "Draining resident steward (pid $1) before file swap…"
      nsExec::ExecToLog 'taskkill /PID $1 /T /F'
      Sleep 2500
  done_steward:
!macroend

!macro customUnInstall
  IfFileExists "$APPDATA\Platform\steward.pid" 0 done_unsteward
    FileOpen $0 "$APPDATA\Platform\steward.pid" r
    FileRead $0 $1
    FileClose $0
    IntCmp $1 0 done_unsteward
      DetailPrint "Stopping resident steward (pid $1)…"
      nsExec::ExecToLog 'taskkill /PID $1 /T /F'
  done_unsteward:
  ; Scheduled task deregistration is idempotent (/F tolerates absence).
  nsExec::ExecToLog 'schtasks /Delete /TN "PlatformSteward" /F'
!macroend
