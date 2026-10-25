; electron-builder include script (nsis.include in package.json).
;
; Install for the current user only. The app updates Claude Code and Codex in
; place under resources\bundled-tools and never runs elevated, so under
; Program Files every tool update fails with EPERM. %LOCALAPPDATA%\Programs is
; owned by the user. A machine-wide install is still possible with /allusers.

; Skip the "only me / all users" page and take "only me".
!macro customInstallMode
  !ifndef BUILD_UNINSTALLER
    StrCpy $isForceCurrentInstall "1"
  !endif
!macroend

; Silent runs never reach that page, and initMultiUser has already chosen
; per-machine if an older machine-wide install exists — switch back.
!macro customInit
  ${IfNot} ${isForAllUsers}
    StrCpy $hasPerMachineInstallation "0"
    !insertmacro setInstallModePerUser
  ${EndIf}
!macroend

; electron-builder only removes an old version installed in the same mode, so
; a machine-wide copy from an earlier installer would stay behind next to the
; new one. Offer to remove it. --updated keeps the user's settings and login.
!macro customInstall
  ReadRegStr $R0 HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
  ReadRegStr $R1 HKLM "${UNINSTALL_REGISTRY_KEY}" UninstallString
  ${If} $R0 != ""
  ${AndIf} $R1 != ""
  ${AndIf} $R0 != $INSTDIR
    ${If} ${Cmd} `MessageBox MB_YESNO|MB_ICONQUESTION "检测到旧版 4RouterAi 安装在「所有用户」目录：$\r$\n$R0$\r$\n$\r$\n新版已安装到当前用户目录，应用内更新 Claude Code 和 Codex 不再需要管理员权限。$\r$\n$\r$\n是否卸载旧版？需要管理员确认一次，设置和登录信息会保留。" /SD IDNO IDYES`
      ; Start it elevated ourselves: left to elevate on its own, the old
      ; uninstaller relaunches itself and exits at once, so there would be
      ; nothing to wait for. Run a renamed copy, like electron-builder's own
      ; uninstallOldVersion: under its own name its app-running check can
      ; match itself ("Uninstall 4RouterAi.exe") and abort.
      !insertmacro GetInQuotes $R2 "$R1"
      InitPluginsDir
      CopyFiles /SILENT "$R2" "$PLUGINSDIR\old-uninstaller.exe"
      ExecShellWait "runas" "$PLUGINSDIR\old-uninstaller.exe" "/allusers /S /KEEP_APP_DATA --updated _?=$R0"
      ; Judge by the registry: a declined UAC prompt is not an error code.
      ClearErrors
      ReadRegStr $R2 HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
      ${If} $R2 != ""
        MessageBox MB_OK|MB_ICONINFORMATION "旧版没有卸载，可以稍后在「设置 → 应用」里手动卸载（名称同为 4RouterAi，安装位置是 $R0）。" /SD IDOK
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend
