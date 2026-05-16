const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  openVideos: () => ipcRenderer.invoke('open-videos'),
  openAudio: () => ipcRenderer.invoke('open-audio'),
  openImages: () => ipcRenderer.invoke('open-images'),
  startSpotifyAuth: () => ipcRenderer.invoke('start-spotify-auth'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  isElectron: true
});
