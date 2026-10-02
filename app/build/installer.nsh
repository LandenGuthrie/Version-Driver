; Runs when Version Driver is uninstalled (not during an in-place update).
!macro customUnInstall
  ; the versiondriver:// link handler the app registers at runtime, and the update download cache
  DeleteRegKey HKCU "Software\Classes\versiondriver"
  RMDir /r "$LOCALAPPDATA\@vdapp-updater"

  ${ifNot} ${isUpdated}
    ; Settings, Google sign-in and repository encryption keys live in the app data folder. Keep them by
    ; default so a reinstall picks up where you left off; remove them only if the user says so.
    ; Silent installs can pass /DELETEDATA to remove them without a prompt.
    ${GetParameters} $R0
    ${GetOptions} $R0 "/DELETEDATA" $R1
    ${If} ${Errors}
      MessageBox MB_YESNO|MB_ICONQUESTION "Also remove your Version Driver settings, Google sign-in and encryption keys from this computer?$\r$\n$\r$\nChoose No to keep them for a future reinstall. Version history that Version Driver stored can't be opened again without the keys. Your project files are never touched." /SD IDNO IDNO keepAppData
    ${EndIf}
    RMDir /r "$APPDATA\${PRODUCT_FILENAME}"
    keepAppData:
  ${endIf}
!macroend
