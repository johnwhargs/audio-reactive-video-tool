const { app, BrowserWindow, ipcMain, dialog, protocol, shell } = require('electron');
const path = require('path');
const http = require('http');

let win;
let callbackServer = null;

// Custom protocol to serve local files securely
protocol.registerSchemesAsPrivileged([{
  scheme: 'local',
  privileges: { bypassCSP: true, stream: true, supportFetchAPI: true }
}]);

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    title: 'vidubber',
    backgroundColor: '#111',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    }
  });

  win.loadFile('static/index.html');

  // Open DevTools in dev mode
  if (process.argv.includes('--dev')) {
    win.webContents.openDevTools();
  }
}

app.whenReady().then(() => {
  // Register local:// protocol to stream files from disk
  protocol.handle('local', (request) => {
    const filePath = decodeURIComponent(request.url.replace('local://', ''));
    return require('net').fetch('file://' + filePath);
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ─── IPC: File Dialogs ─────────────────────────────────────────────────────

ipcMain.handle('open-videos', async () => {
  const result = await dialog.showOpenDialog(win, {
    title: 'Add video clips',
    filters: [{ name: 'Video', extensions: ['mp4', 'webm', 'mov', 'avi', 'mkv'] }],
    properties: ['openFile', 'multiSelections']
  });
  if (result.canceled) return [];
  return result.filePaths.map(fp => ({
    path: fp,
    name: path.basename(fp),
    url: 'local://' + encodeURIComponent(fp)
  }));
});

ipcMain.handle('open-audio', async () => {
  const result = await dialog.showOpenDialog(win, {
    title: 'Add audio files',
    filters: [{ name: 'Audio', extensions: ['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a'] }],
    properties: ['openFile', 'multiSelections']
  });
  if (result.canceled) return [];
  return result.filePaths.map(fp => ({
    path: fp,
    name: path.basename(fp),
    url: 'local://' + encodeURIComponent(fp)
  }));
});

ipcMain.handle('open-images', async () => {
  const result = await dialog.showOpenDialog(win, {
    title: 'Add images',
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }],
    properties: ['openFile', 'multiSelections']
  });
  if (result.canceled) return [];
  return result.filePaths.map(fp => ({
    path: fp,
    name: path.basename(fp),
    url: 'local://' + encodeURIComponent(fp)
  }));
});

// ─── Spotify OAuth loopback server ─────────────────────────────────────────
// Tiny HTTP server on :8888 catches OAuth redirect and forwards code to renderer

ipcMain.handle('start-spotify-auth', () => {
  if (callbackServer) return;
  callbackServer = http.createServer((req, res) => {
    if (req.url.startsWith('/callback')) {
      const html = `<!DOCTYPE html><html><body><script>
        window.opener = null;
        const params = window.location.search;
        // Post message to Electron app via redirect
        document.title = 'spotify-callback' + params;
        document.body.textContent = 'Auth complete — you can close this tab.';
      </script></body></html>`;
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
      // Forward params to renderer
      const url = new URL('http://localhost:8888' + req.url);
      const code = url.searchParams.get('code');
      if (code && win) {
        win.webContents.executeJavaScript(
          `window.dispatchEvent(new CustomEvent('spotify-callback', { detail: { code: '${code}' } }))`
        );
      }
      // Shut down after successful callback
      setTimeout(() => {
        if (callbackServer) { callbackServer.close(); callbackServer = null; }
      }, 1000);
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  callbackServer.listen(8888, '127.0.0.1');
});

ipcMain.handle('open-external', (_, url) => {
  shell.openExternal(url);
});
