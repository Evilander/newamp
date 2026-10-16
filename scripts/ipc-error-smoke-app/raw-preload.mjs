import { contextBridge, ipcRenderer } from 'electron';

// Plain ipcRenderer.invoke, to show what Electron does to a handler's error
// when nothing cleans it up.
contextBridge.exposeInMainWorld('rawIpc', {
  invoke: (channel) => ipcRenderer.invoke(channel),
});
