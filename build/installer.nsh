!macro NEWAMP_REFRESH_ASSOCIATION ROOT EXT FILECLASS DESCRIPTION COMMANDTEXT
  WriteRegStr ${ROOT} "Software\Classes\.${EXT}" "" "${FILECLASS}"
  DeleteRegValue ${ROOT} "Software\Classes\.${EXT}\OpenWithProgids" "Newamp.AudioFile"
  DeleteRegValue ${ROOT} "Software\Classes\.${EXT}\OpenWithProgids" "Newamp.PlaylistFile"
  WriteRegNone ${ROOT} "Software\Classes\.${EXT}\OpenWithProgids" "${FILECLASS}"
  WriteRegStr ${ROOT} "Software\Classes\${FILECLASS}" "" `${DESCRIPTION}`
  WriteRegStr ${ROOT} "Software\Classes\${FILECLASS}\DefaultIcon" "" `$appExe,0`
  WriteRegStr ${ROOT} "Software\Classes\${FILECLASS}\shell" "" "open"
  WriteRegStr ${ROOT} "Software\Classes\${FILECLASS}\shell\open" "" `${COMMANDTEXT}`
  WriteRegStr ${ROOT} "Software\Classes\${FILECLASS}\shell\open\command" "" `$appExe $\"%1$\"`
!macroend

!macro NEWAMP_REFRESH_AUDIO_ASSOCIATION EXT
  !insertmacro NEWAMP_REFRESH_ASSOCIATION SHELL_CONTEXT "${EXT}" "NewAmp.AudioFile" "NewAmp audio file" "Open with NewAmp"
  !insertmacro NEWAMP_REFRESH_ASSOCIATION HKEY_CURRENT_USER "${EXT}" "NewAmp.AudioFile" "NewAmp audio file" "Open with NewAmp"
!macroend

!macro NEWAMP_REFRESH_PLAYLIST_ASSOCIATION EXT
  !insertmacro NEWAMP_REFRESH_ASSOCIATION SHELL_CONTEXT "${EXT}" "NewAmp.PlaylistFile" "NewAmp playlist or CUE sheet" "Open with NewAmp"
  !insertmacro NEWAMP_REFRESH_ASSOCIATION HKEY_CURRENT_USER "${EXT}" "NewAmp.PlaylistFile" "NewAmp playlist or CUE sheet" "Open with NewAmp"
!macroend

!macro customInstall
  !insertmacro NEWAMP_REFRESH_AUDIO_ASSOCIATION "mp3"
  !insertmacro NEWAMP_REFRESH_AUDIO_ASSOCIATION "flac"
  !insertmacro NEWAMP_REFRESH_AUDIO_ASSOCIATION "ogg"
  !insertmacro NEWAMP_REFRESH_AUDIO_ASSOCIATION "oga"
  !insertmacro NEWAMP_REFRESH_AUDIO_ASSOCIATION "opus"
  !insertmacro NEWAMP_REFRESH_AUDIO_ASSOCIATION "wav"
  !insertmacro NEWAMP_REFRESH_AUDIO_ASSOCIATION "m4a"
  !insertmacro NEWAMP_REFRESH_AUDIO_ASSOCIATION "aac"
  !insertmacro NEWAMP_REFRESH_AUDIO_ASSOCIATION "wma"
  !insertmacro NEWAMP_REFRESH_AUDIO_ASSOCIATION "aiff"
  !insertmacro NEWAMP_REFRESH_AUDIO_ASSOCIATION "aif"
  !insertmacro NEWAMP_REFRESH_AUDIO_ASSOCIATION "ape"
  !insertmacro NEWAMP_REFRESH_AUDIO_ASSOCIATION "wv"
  !insertmacro NEWAMP_REFRESH_AUDIO_ASSOCIATION "mpc"
  !insertmacro NEWAMP_REFRESH_AUDIO_ASSOCIATION "tta"
  !insertmacro NEWAMP_REFRESH_AUDIO_ASSOCIATION "mka"
  !insertmacro NEWAMP_REFRESH_AUDIO_ASSOCIATION "ac3"
  !insertmacro NEWAMP_REFRESH_AUDIO_ASSOCIATION "dts"
  !insertmacro NEWAMP_REFRESH_AUDIO_ASSOCIATION "dsf"
  !insertmacro NEWAMP_REFRESH_PLAYLIST_ASSOCIATION "m3u"
  !insertmacro NEWAMP_REFRESH_PLAYLIST_ASSOCIATION "m3u8"
  !insertmacro NEWAMP_REFRESH_PLAYLIST_ASSOCIATION "pls"
  !insertmacro NEWAMP_REFRESH_PLAYLIST_ASSOCIATION "cue"
  !insertmacro UPDATEFILEASSOC
!macroend
