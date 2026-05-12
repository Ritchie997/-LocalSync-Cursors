import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { WebSocketServer } from 'ws';
const WebSocket = WebSocketServer;
import * as Y from 'yjs';
import { messageYjsSyncStep1, messageYjsSyncStep2, messageYjsUpdate, writeSyncStep1, readSyncMessage } from 'y-protocols/sync.js';
import { Awareness, encodeAwarenessUpdate, applyAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness.js';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');

// Token authentication
let TOKEN = '';
const TOKEN_FILE = path.join(DATA_DIR, 'token.txt');

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function ensureToken() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  
  if (fs.existsSync(TOKEN_FILE)) {
    TOKEN = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    console.log(`[Auth] Loaded existing token`);
  } else {
    TOKEN = generateToken();
    fs.writeFileSync(TOKEN_FILE, TOKEN, 'utf8');
    console.log(`[Auth] Generated new token: ${TOKEN}`);
  }
}

// Allowed origins (optional)
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS 
  ? process.env.ALLOWED_ORIGINS.split(',') 
  : ['*'];

function validateOrigin(origin) {
  if (ALLOWED_ORIGINS.includes('*')) return true;
  return ALLOWED_ORIGINS.includes(origin);
}

function validateToken(token) {
  return token === TOKEN;
}

// Room management
const rooms = new Map();

function getRoom(roomName, docName) {
  const roomId = `${roomName}/${docName}`;
  
  if (!rooms.has(roomId)) {
    const doc = new Y.Doc();
    const awareness = new Awareness(doc);
    
    // Load persisted state
    const roomDir = path.join(DATA_DIR, roomName);
    const docFile = path.join(roomDir, `${docName}.yjs`);
    
    if (!fs.existsSync(roomDir)) {
      fs.mkdirSync(roomDir, { recursive: true });
    }
    
    if (fs.existsSync(docFile)) {
      try {
        const state = fs.readFileSync(docFile);
        Y.applyUpdate(doc, state);
        console.log(`[Room] Loaded state for ${roomId}`);
      } catch (err) {
        console.error(`[Room] Error loading state for ${roomId}:`, err);
      }
    }
    
    // Save state periodically and on changes
    let updateTimeout = null;
    doc.on('update', (update) => {
      if (updateTimeout) clearTimeout(updateTimeout);
      updateTimeout = setTimeout(() => {
        const state = Y.encodeStateAsUpdate(doc);
        fs.writeFileSync(docFile, state);
      }, 100);
    });
    
    // Handle awareness updates
    awareness.setLocalStateField('user', {
      name: 'Server',
      color: '#999999'
    });
    
    rooms.set(roomId, { doc, awareness, clients: new Set() });
    console.log(`[Room] Created room: ${roomId}`);
  }
  
  return rooms.get(roomId);
}

function removeClientFromRoom(room, client) {
  room.clients.delete(client);
  
  // Remove client's awareness state using the exported function
  const clientIds = Array.from(room.awareness.getStates().keys());
  for (const clientId of clientIds) {
    const state = room.awareness.getStates().get(clientId);
    if (state && state.user && state.user.clientId === client.id) {
      removeAwarenessStates(room.awareness, [clientId], 'disconnect');
    }
  }
  
  // Clean up empty rooms after a delay
  if (room.clients.size === 0) {
    setTimeout(() => {
      if (room.clients.size === 0) {
        // Keep room in memory for quick reconnect
        console.log(`[Room] Room ${Object.keys(rooms).find(key => rooms.get(key) === room)} is empty`);
      }
    }, 30000);
  }
}

// Create HTTP server for health checks
const httpServer = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', rooms: rooms.size }));
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

// Create WebSocket server
const wss = new WebSocketServer({ 
  noServer: true,
  maxPayload: 100 * 1024 * 1024 // 100MB max for attachments
});

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const token = url.searchParams.get('token');
  const pathname = url.pathname;
  
  // Validate origin
  const origin = req.headers.origin;
  if (origin && !validateOrigin(origin)) {
    console.log(`[Auth] Rejected connection from origin: ${origin}`);
    ws.close(4001, 'Origin not allowed');
    return;
  }
  
  // Token validation disabled for local use
  // if (!validateToken(token)) {
  //   console.log(`[Auth] Rejected connection with invalid token`);
  //   ws.close(4003, 'Invalid token');
  //   return
  // }
  console.log(`[Auth] Connection accepted (no auth required)`);

  // Handle case where plugin sends doc name after token in query string
  // Plugin format: /?token=XYZ/docname (incorrect but common)
  let docName = '';
  let roomName = 'default-room';

  // First check if the URL has the doc name appended after the token parameter
  // e.g., ws://localhost:4455/?token=ABC123/docname
  const fullPath = req.url;
  const matchAfterToken = fullPath.match(/[?&]token=[^&]*\/(.+?)(?:\?.*)?$/);
  
  if (matchAfterToken) {
    // Extract doc name from the weird URL format
    docName = matchAfterToken[1];
    console.log(`[Debug] Extracted doc name from URL: ${docName}`);
  } else {
    // Try to parse standard path: /room/doc
    const parts = pathname.split('/').filter(p => p);
    
    if (parts.length >= 2) {
      docName = parts.pop();
      roomName = parts.join('/');
    } else if (parts.length === 1) {
      docName = parts[0];
    } else {
      docName = `doc-${Date.now()}`;
    }
  }

  // Clean up docName from any trailing query params
  docName = docName.split('?')[0].split('&')[0];
  
  if (!docName) {
    docName = `doc-${Date.now()}`;
  }

  const room = getRoom(roomName, docName);
  
  const clientId = Math.floor(Math.random() * 1000000);
  ws.isAlive = true;
  ws.id = clientId;
  
  // Add client to room
  room.clients.add(ws);
  console.log(`[Client] Connected: ${clientId} to ${roomName}/${docName}`);
  
  // Initialize sync protocol
  const encoder = encoding.createEncoder();
  writeSyncStep1(encoder, room.doc);
  ws.send(encoding.toUint8Array(encoder));
  
  // Send current awareness states
  const awarenessStates = room.awareness.getStates();
  for (const [id, state] of awarenessStates.entries()) {
    const update = encodeAwarenessUpdate(room.awareness, [id]);
    ws.send(update);
  }
  
  // Handle incoming messages
  ws.on('message', (message) => {
    try {
      const data = new Uint8Array(message);
      const messageType = data[0];
      
      if (messageType === messageYjsSyncStep1 ||
          messageType === messageYjsSyncStep2 ||
          messageType === messageYjsUpdate) {
        const decoder = decoding.createDecoder(data);
        const encoder = encoding.createEncoder();
        readSyncMessage(decoder, encoder, room.doc, null);
        
        // Broadcast to other clients
        if (encoder.len > 0) {
          const msg = encoding.toUint8Array(encoder);
          for (const client of room.clients) {
            if (client !== ws && client.readyState === WebSocket.OPEN) {
              client.send(msg);
            }
          }
        }
      } else if (messageType === 10) { // awareness message type
        applyAwarenessUpdate(room.awareness, data, ws);
        
        // Broadcast awareness update to other clients
        for (const client of room.clients) {
          if (client !== ws && client.readyState === WebSocket.OPEN) {
            client.send(data);
          }
        }
      }
    } catch (err) {
      console.error(`[Error] Message handling error:`, err);
    }
  });
  
  ws.on('close', () => {
    console.log(`[Client] Disconnected: ${clientId} from ${roomName}/${docName}`);
    removeClientFromRoom(room, ws);
  });
  
  ws.on('error', (err) => {
    console.error(`[Error] WebSocket error for ${clientId}:`, err);
  });
  
  // Ping/pong for keepalive
  ws.on('pong', () => {
    ws.isAlive = true;
  });
});

// Health check interval
const interval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('close', () => {
  clearInterval(interval);
});

// Handle upgrade from HTTP to WebSocket
httpServer.on('upgrade', (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});

// Start server
const PORT = process.env.PORT || 4455;
const HOST = process.env.HOST || '0.0.0.0';

ensureToken();

httpServer.listen(PORT, HOST, () => {
  console.log(`\n========================================`);
  console.log(`🚀 Server running on ${HOST}:${PORT}`);
  console.log(`📁 Data directory: ${DATA_DIR}`);
  console.log(`🔑 Token: ${TOKEN}`);
  console.log(`📝 Token saved to: ${TOKEN_FILE}`);
  console.log(`🌐 Allowed origins: ${ALLOWED_ORIGINS.join(', ')}`);
  console.log(`\nConnect with: ws://${HOST}:${PORT}/room/doc?token=${TOKEN}`);
  console.log(`Health check: http://${HOST}:${PORT}/health`);
  console.log(`========================================\n`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[Server] Shutting down...');
  
  // Save all room states
  for (const [roomId, room] of rooms.entries()) {
    const [roomName, docName] = roomId.split('/');
    const docFile = path.join(DATA_DIR, roomName, `${docName}.yjs`);
    const state = Y.encodeStateAsUpdate(room.doc);
    fs.writeFileSync(docFile, state);
    console.log(`[Server] Saved state for ${roomId}`);
  }
  
  wss.close(() => {
    httpServer.close(() => {
      console.log('[Server] Shutdown complete');
      process.exit(0);
    });
  });
});

process.on('SIGINT', () => {
  process.emit('SIGTERM');
});
