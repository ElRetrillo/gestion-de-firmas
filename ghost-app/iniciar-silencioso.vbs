' ==============================================================================
' Lanzador Silencioso (Headless) del Agente Ghost App USB
' Ilustre Municipalidad de Coquimbo
' Ejecuta el agente 100% en segundo plano sin ventana de consola visible
' ==============================================================================

Set objFSO = CreateObject("Scripting.FileSystemObject")
strCurrentDir = objFSO.GetParentFolderName(WScript.ScriptFullName)

Set objShell = CreateObject("WScript.Shell")
' 0 = Oculto (Invisible para el usuario), False = No bloquear ejecucion
objShell.Run """" & strCurrentDir & "\iniciar-agente.bat""", 0, False
