; Remove the versiondriver:// link handler the app registers at runtime, so uninstalling leaves nothing behind.
!macro customUnInstall
  DeleteRegKey HKCU "Software\Classes\versiondriver"
!macroend
