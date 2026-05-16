const { app, BrowserWindow, ipcMain, dialog, protocol, shell, desktopCapturer, session } = require('electron');
const path = require('path');
const http = require('http');
const fs = require('fs');

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

  // Allow getDisplayMedia for system audio capture
  win.webContents.session.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'] });
      if (sources.length > 0) {
        callback({ video: sources[0], audio: 'loopback' });
      } else {
        callback({});
      }
    } catch (err) {
      console.warn('[electron] desktopCapturer failed:', err.message);
      callback({});
    }
  });

  // Auto-grant mic permission
  win.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
    const allowed = ['media', 'audioCapture', 'display-capture', 'mediaKeySystem'];
    callback(allowed.includes(permission));
  });

  win.loadFile('static/index.html');

  // Open DevTools in dev mode
  if (process.argv.includes('--dev')) {
    win.webContents.openDevTools();
  }
}

app.whenReady().then(() => {
  // Register local:// protocol to stream files from disk
  // Uses ReadableStream so large video files don't load entirely into memory
  protocol.handle('local', (request) => {
    const filePath = decodeURIComponent(request.url.replace('local://', ''));
    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes = {
      '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
      '.avi': 'video/x-msvideo', '.mkv': 'video/x-matroska',
      '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
      '.flac': 'audio/flac', '.aac': 'audio/aac', '.m4a': 'audio/mp4',
      '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
      '.gif': 'image/gif', '.webp': 'image/webp',
    };
    const mime = mimeTypes[ext] || 'application/octet-stream';
    try {
      const stat = fs.statSync(filePath);
      const stream = fs.createReadStream(filePath);
      const readable = new ReadableStream({
        start(controller) {
          stream.on('data', chunk => controller.enqueue(chunk));
          stream.on('end', () => controller.close());
          stream.on('error', err => controller.error(err));
        },
        cancel() { stream.destroy(); }
      });
      return new Response(readable, {
        headers: {
          'Content-Type': mime,
          'Content-Length': stat.size.toString(),
          'Accept-Ranges': 'bytes',
        }
      });
    } catch (err) {
      return new Response('File not found: ' + filePath, { status: 404 });
    }
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
        // Sanitize code to prevent injection
        const safeCode = code.replace(/[^a-zA-Z0-9_-]/g, '');
        win.webContents.executeJavaScript(
          `window.dispatchEvent(new CustomEvent('spotify-callback', { detail: { code: '${safeCode}' } }))`
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
  callbackServer.listen(8888, '0.0.0.0');
});

ipcMain.handle('open-external', (_, url) => {
  shell.openExternal(url);
});

ipcMain.handle('get-desktop-sources', async () => {
  try {
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
    return sources.map(s => ({ id: s.id, name: s.name }));
  } catch (err) {
    console.warn('[electron] getSources failed:', err.message);
    return [];
  }
});
