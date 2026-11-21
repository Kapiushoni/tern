; Tern installer hooks (included by Tauri's NSIS script before the pages are declared).
;
; Two options on the Welcome page:
;  - Voice input: Tern downloads the speech model on its first start (a marker file tells it to;
;    the download runs in the app, with progress, and simply waits if there is no internet).
;  - "Open in Tern" in Explorer's folder menu.
; Updates run the installer in passive mode, which skips the Welcome page: then nothing here
; changes, so earlier choices stay as they were.

Var TernPageShown
Var TernVoiceBox
Var TernMenuBox
Var TernVoice
Var TernMenu

!define TERN_MENU_KEY "Software\Classes\Directory\shell\Tern"
!define TERN_MENU_BG_KEY "Software\Classes\Directory\Background\shell\Tern"
!define TERN_MODELS "$LOCALAPPDATA\dev.tern.app\models"

; Picked up by the MUI_PAGE_WELCOME that follows in Tauri's script.
!define MUI_PAGE_CUSTOMFUNCTION_SHOW TernWelcomeShow
!define MUI_PAGE_CUSTOMFUNCTION_LEAVE TernWelcomeLeave

Function TernWelcomeShow
  StrCpy $TernPageShown 1
  ${NSD_CreateCheckbox} 120u 150u 195u 12u "Voice input: download the speech model (about 470 MB)"
  Pop $TernVoiceBox
  SetCtlColors $TernVoiceBox "" "FFFFFF"
  ${If} ${FileExists} "${TERN_MODELS}\ggml-small.bin"
    ${NSD_Check} $TernVoiceBox
    EnableWindow $TernVoiceBox 0
  ${EndIf}

  ${NSD_CreateCheckbox} 120u 165u 195u 12u 'Add "Open in Tern" to the folder menu in Explorer'
  Pop $TernMenuBox
  SetCtlColors $TernMenuBox "" "FFFFFF"
  ; Ticked by default on a first install; on a reinstall it shows the current state.
  ClearErrors
  ReadRegStr $0 HKCU "${TERN_MENU_KEY}" ""
  ${IfNot} ${Errors}
    ${NSD_Check} $TernMenuBox
  ${ElseIfNot} ${FileExists} "$INSTDIR\${MAINBINARYNAME}.exe"
    ${NSD_Check} $TernMenuBox
  ${EndIf}
FunctionEnd

Function TernWelcomeLeave
  ${NSD_GetState} $TernVoiceBox $TernVoice
  ${NSD_GetState} $TernMenuBox $TernMenu
FunctionEnd

!macro NSIS_HOOK_POSTINSTALL
  ${If} $TernPageShown == 1
    ${If} $TernMenu == ${BST_CHECKED}
      WriteRegStr HKCU "${TERN_MENU_KEY}" "" "Open in Tern"
      WriteRegStr HKCU "${TERN_MENU_KEY}" "Icon" "$INSTDIR\${MAINBINARYNAME}.exe"
      WriteRegStr HKCU "${TERN_MENU_KEY}\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%V"'
      WriteRegStr HKCU "${TERN_MENU_BG_KEY}" "" "Open in Tern"
      WriteRegStr HKCU "${TERN_MENU_BG_KEY}" "Icon" "$INSTDIR\${MAINBINARYNAME}.exe"
      WriteRegStr HKCU "${TERN_MENU_BG_KEY}\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%V"'
    ${Else}
      DeleteRegKey HKCU "${TERN_MENU_KEY}"
      DeleteRegKey HKCU "${TERN_MENU_BG_KEY}"
    ${EndIf}
    ${If} $TernVoice == ${BST_CHECKED}
    ${AndIfNot} ${FileExists} "${TERN_MODELS}\ggml-small.bin"
      CreateDirectory "${TERN_MODELS}"
      FileOpen $0 "${TERN_MODELS}\.download-small" w
      FileClose $0
    ${EndIf}
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; An update uninstalls the old version first: keep the menu entry then.
  ${If} $UpdateMode <> 1
    DeleteRegKey HKCU "${TERN_MENU_KEY}"
    DeleteRegKey HKCU "${TERN_MENU_BG_KEY}"
  ${EndIf}
!macroend
