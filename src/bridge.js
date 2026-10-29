// Native-client bridge: the Kanban Board app talks to `kb` over a Unix socket instead of launching
// one `obsidian eval` process per call. One JSON line per message:
//   app -> plugin  {"id":1,"code":"kb.active()"}
//   plugin -> app  {"id":1,"ok":"<String(value)>"} | {"id":1,"err":"<stack>"} | {"event":"changed"}
// "changed" follows note edits (debounced) so the app refreshes on change, not on a timer.
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Platform } = require('obsidian');

const SOCKET = path.join(os.homedir(), '.kanban-board.sock');
const CHANGE_MS = 1000;

function startBridge(plugin) {
  if (!Platform.isDesktopApp) return;
  const clients = new Set();
  const server = net.createServer(sock => {
    clients.add(sock);
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('data', chunk => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line) answer(sock, line);
      }
    });
    sock.on('close', () => clients.delete(sock));
    sock.on('error', () => clients.delete(sock));
  });
  // A socket file left by a crashed Obsidian refuses listen() with EADDRINUSE.
  try { fs.unlinkSync(SOCKET); } catch { /* none left */ }
  server.listen(SOCKET, () => fs.chmodSync(SOCKET, 0o600));
  server.on('error', e => console.error('bdb bridge:', e));

  let timer = null;
  const changed = () => {
    clearTimeout(timer);
    timer = setTimeout(() => { for (const c of clients) c.write('{"event":"changed"}\n'); }, CHANGE_MS);
  };
  plugin.registerEvent(plugin.app.metadataCache.on('changed', changed));
  plugin.registerEvent(plugin.app.vault.on('delete', changed));
  plugin.registerEvent(plugin.app.vault.on('rename', changed));
  plugin.register(() => {
    clearTimeout(timer);
    for (const c of clients) c.destroy();
    server.close();
  });
}

// Indirect eval runs `code` in global scope (`app`, `kb`), the same scope `obsidian eval` uses.
async function answer(sock, line) {
  let id = null;
  try {
    const req = JSON.parse(line);
    id = req.id;
    const v = await (0, eval)(req.code);
    reply(sock, { id, ok: v == null ? '' : String(v) });
  } catch (e) {
    reply(sock, { id, err: String((e && e.stack) || e) });
  }
}

function reply(sock, msg) {
  if (!sock.destroyed) sock.write(JSON.stringify(msg) + '\n');
}

module.exports = { startBridge, SOCKET };
