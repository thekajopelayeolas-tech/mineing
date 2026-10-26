// Static file server plus a tiny lobby relay for online matches.
// Uses only Node built-ins. Browsers get lobby updates over Server-Sent Events
// and send messages with POST requests.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = 8765;
const HOST = '127.0.0.1';
const ROOT = __dirname;
const MAX_PLAYERS = 2;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

// lobbies: id -> { id, name, players: [playerId] }
const lobbies = new Map();
// clients: playerId -> { res, lobbyId }
const clients = new Map();

function newId() {
  return crypto.randomBytes(6).toString('hex');
}

function lobbyList() {
  return [...lobbies.values()].map((l) => ({ id: l.id, name: l.name, players: l.players.length, max: MAX_PLAYERS }));
}

function sendEvent(playerId, type, data) {
  const c = clients.get(playerId);
  if (!c) return;
  c.res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
}

function broadcastLobbies() {
  for (const [id] of clients) sendEvent(id, 'lobbies', lobbyList());
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1e5) reject(new Error('body too large'));
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(err);
      }
    });
  });
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

// Removes a player from their lobby. Deletes the lobby when it's empty,
// and tells the remaining player their opponent left.
function leaveLobby(playerId) {
  const client = clients.get(playerId);
  if (!client || !client.lobbyId) return;
  const lobby = lobbies.get(client.lobbyId);
  client.lobbyId = null;
  if (!lobby) return;
  lobby.players = lobby.players.filter((p) => p !== playerId);
  if (lobby.players.length === 0) {
    lobbies.delete(lobby.id);
  } else {
    for (const p of lobby.players) sendEvent(p, 'opponentLeft', {});
  }
  broadcastLobbies();
}


async function handleApi(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/events') {
    const playerId = newId();
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    clients.set(playerId, { res, lobbyId: null });
    res.write(`event: hello\ndata: ${JSON.stringify({ playerId })}\n\n`);
    sendEvent(playerId, 'lobbies', lobbyList());
    // Keep the connection open through idle proxies.
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => {
      clearInterval(ping);
      leaveLobby(playerId);
      clients.delete(playerId);
    });
    return;
  }

  if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
  const body = await readBody(req);
  const playerId = String(body.playerId || '');
  if (!clients.has(playerId)) return sendJson(res, 400, { error: 'unknown player' });

  if (url.pathname === '/api/create') {
    leaveLobby(playerId);
    const id = newId();
    const name = String(body.name || 'Lobby').slice(0, 24);
    lobbies.set(id, { id, name, players: [playerId] });
    clients.get(playerId).lobbyId = id;
    broadcastLobbies();
    return sendJson(res, 200, { lobbyId: id });
  }

  if (url.pathname === '/api/join') {
    const lobby = lobbies.get(String(body.lobbyId || ''));
    if (!lobby) return sendJson(res, 404, { error: 'lobby not found' });
    if (lobby.players.length >= MAX_PLAYERS) return sendJson(res, 409, { error: 'lobby full' });
    leaveLobby(playerId);
    lobby.players.push(playerId);
    clients.get(playerId).lobbyId = lobby.id;
    const host = lobby.players[0];
    sendEvent(host, 'matched', { lobbyId: lobby.id, opponentId: playerId });
    sendEvent(playerId, 'matched', { lobbyId: lobby.id, opponentId: host });
    broadcastLobbies();
    return sendJson(res, 200, { lobbyId: lobby.id });
  }

  if (url.pathname === '/api/leave') {
    leaveLobby(playerId);
    return sendJson(res, 200, { ok: true });
  }

  if (url.pathname === '/api/send') {
    // Relays a game message (type + data) to the opponent in the same lobby.
    const client = clients.get(playerId);
    const lobby = client.lobbyId ? lobbies.get(client.lobbyId) : null;
    if (!lobby) return sendJson(res, 409, { error: 'not in a lobby' });
    for (const p of lobby.players) {
      if (p !== playerId) sendEvent(p, 'game', { type: String(body.type || ''), data: body.data ?? null });
    }
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 404, { error: 'not found' });
}
function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(ROOT, rel));
  // Block requests that escape the project folder.
  if (!file.startsWith(ROOT + path.sep)) {
    res.writeHead(403);
    return res.end('forbidden');
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('File not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url).catch((err) => {
      if (!res.headersSent) sendJson(res, 400, { error: err.message });
    });
  } else {
    serveStatic(req, res, url);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Serving on http://${HOST}:${PORT}/index.html`);
});


