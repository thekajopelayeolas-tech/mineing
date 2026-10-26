// Online lobby client. Talks to server.js: it listens for lobby updates over
// Server-Sent Events, and sends create/join/leave/send requests with fetch.
// game.js calls window.online to start matches and to relay game messages.

const online = {
  playerId: null,
  lobbyId: null,
  opponentId: null,
  events: null,
  listeners: {},  // event name -> [callback]
};

function onOnline(type, callback) {
  (online.listeners[type] ||= []).push(callback);
}

function emitOnline(type, data) {
  for (const cb of online.listeners[type] || []) cb(data);
}

// Opens the event stream once. Lobby updates and match notices arrive here.
function connectOnline() {
  if (online.events) return;
  const source = new EventSource('/api/events');
  online.events = source;
  source.addEventListener('hello', (e) => {
    online.playerId = JSON.parse(e.data).playerId;
  });
  for (const type of ['lobbies', 'matched', 'opponentLeft', 'game']) {
    source.addEventListener(type, (e) => {
      const data = JSON.parse(e.data);
      if (type === 'matched') online.opponentId = data.opponentId;
      if (type === 'opponentLeft') online.opponentId = null;
      emitOnline(type, data);
    });
  }
  source.onerror = () => emitOnline('connection', { ok: false });
}

async function postOnline(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ playerId: online.playerId, ...body }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `request failed (${res.status})`);
  return data;
}

async function createLobby(name) {
  const data = await postOnline('/api/create', { name });
  online.lobbyId = data.lobbyId;
  return data;
}

async function joinLobby(lobbyId) {
  const data = await postOnline('/api/join', { lobbyId });
  online.lobbyId = data.lobbyId;
  return data;
}

async function leaveLobby() {
  online.lobbyId = null;
  online.opponentId = null;
  if (online.playerId) await postOnline('/api/leave', {}).catch(() => {});
}

// Sends one game message (type + data) to the opponent.
function sendToOpponent(type, data) {
  if (!online.lobbyId) return;
  postOnline('/api/send', { type, data }).catch(() => {});
}

window.online = {
  state: online,
  connect: connectOnline,
  on: onOnline,
  createLobby,
  joinLobby,
  leaveLobby,
  send: sendToOpponent,
};
