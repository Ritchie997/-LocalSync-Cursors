import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { WebSocketServer } from 'ws';
import * as Y from 'yjs';
import { setupWSConnection } from 'y-websocket/bin/utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');

// Token authentication (disabled for local use)
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

// Room management with persistence
const docs = new Map();

function getDoc(docName) {
  if (!docs.has(docName)) {
    const doc = new Y.Doc();
    
    // Load persisted state
    const docFile = path.join(DATA_DIR, `${docName}.yjs`);
    
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    
    if (fs.existsSync(docFile)) {
      try {
        const state = fs.readFileSync(docFile);
        Y.applyUpdate(doc, state);
        console.log(`[Doc] Loaded state for ${docName}`);
      } catch (err) {
        console.error(`[Doc] Error loading state for ${docName}:`, err);
      }
    }
    
    // Save state on changes
    let updateTimeout = null;
    doc.on('update', (update) => {
      if (updateTimeout) clearTimeout(updateTimeout);
      updateTimeout = setTimeout(() => {
        const state = Y.encodeStateAsUpdate(doc);
        fs.writeFileSync(docFile, state);
      }, 100);
    });
    
    docs.set(docName, doc);
    console.log(`[Doc] Created document: ${docName}`);
  }
  
  return docs.get(docName);
}

// Create HTTP server
const httpServer = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', docs: docs.size }));
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

// Create WebSocket server
const wss = new WebSocketServer({ 
  noServer: true,
  maxPayload: 100 * 1024 * 1024 // 100MB max
});

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;
  
  console.log(`[Auth] Connection accepted (no auth required)`);

  // Extract doc name from URL
  // Plugin format: /?token=XYZ/docname or /room/docname
  let docName = '';
  const fullPath = req.url;
  
  // Try to extract doc name after token
  const matchAfterToken = fullPath.match(/[?&]token=[^&]*\/(.+?)(?:\?.*)?$/);
  
  if (matchAfterToken) {
    docName = matchAfterToken[1];
    console.log(`[Debug] Extracted doc name from URL: ${docName}`);
  } else {
    // Try standard path
    const parts = pathname.split('/').filter(p => p);
    if (parts.length > 0) {
      docName = parts[parts.length - 1];
    } else {
      docName = `doc-${Date.now()}`;
    }
  }

  // Clean up docName
  docName = docName.split('?')[0].split('&')[0];
  
  if (!docName) {
    docName = `doc-${Date.now()}`;
  }

  const doc = getDoc(docName);
  
  console.log(`[Client] Connected to document: ${docName}`);
  
  // Setup Yjs WebSocket connection using the standard utility
  setupWSConnection(ws, req, { docName, gc: true });
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
  console.log(`🔑 Token: ${TOKEN} (authentication disabled)`);
  console.log(`📝 Token saved to: ${TOKEN_FILE}`);
  console.log(`\nConnect with: ws://${HOST}:${PORT}/any-path?token=${TOKEN}`);
  console.log(`Health check: http://${HOST}:${PORT}/health`);
  console.log(`========================================\n`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[Server] Shutting down...');
  
  // Save all document states
  for (const [docName, doc] of docs.entries()) {
    const docFile = path.join(DATA_DIR, `${docName}.yjs`);
    const state = Y.encodeStateAsUpdate(doc);
    fs.writeFileSync(docFile, state);
    console.log(`[Server] Saved state for ${docName}`);
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
