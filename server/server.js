import http from 'http';
import { WebSocketServer } from 'ws';
import { setupWSConnection } from 'y-websocket/bin/utils.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as Y from 'yjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const PORT = process.env.PORT || 4455;
const HOST = '0.0.0.0';

// Создаем директорию для данных
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Хранилище документов: Map<docName, { doc: Y.Doc, persistenceFile: string }>
const docs = new Map();

/**
 * Получает или создает Y.Doc с поддержкой персистентности
 */
function getOrCreateDoc(docName) {
  if (!docs.has(docName)) {
    const doc = new Y.Doc({ gc: true });
    const persistenceFile = path.join(DATA_DIR, `${docName}.yjs`);

    // Загрузка сохраненного состояния
    if (fs.existsSync(persistenceFile)) {
      try {
        const state = fs.readFileSync(persistenceFile);
        Y.applyUpdate(doc, state);
        console.log(`[Doc] Loaded state for: ${docName}`);
      } catch (err) {
        console.error(`[Doc] Error loading state for ${docName}:`, err.message);
      }
    } else {
      console.log(`[Doc] Created new document: ${docName}`);
    }

    // Сохранение при изменениях (с дебаунсом)
    let saveTimeout = null;
    doc.on('update', (update) => {
      if (saveTimeout) clearTimeout(saveTimeout);
      saveTimeout = setTimeout(() => {
        try {
          const state = Y.encodeStateAsUpdate(doc);
          fs.writeFileSync(persistenceFile, state);
        } catch (err) {
          console.error(`[Doc] Error saving ${docName}:`, err.message);
        }
      }, 500); // 500ms дебаунс
    });

    docs.set(docName, { doc, persistenceFile });
  }

  return docs.get(docName).doc;
}

/**
 * Извлекает имя документа из URL запроса
 * Поддерживает форматы:
 * - /?token=XYZ/filename
 * - /room/filename
 * - /filename
 */
function extractDocNameFromUrl(urlString, host) {
  const url = new URL(urlString, `http://${host}`);
  let docName = 'default-room';

  // Попытка извлечь имя после токена (костыль для obsidian-live-sync)
  const tokenParam = url.searchParams.get('token');
  if (tokenParam && tokenParam.includes('/')) {
    const parts = tokenParam.split('/');
    if (parts.length > 1) {
      docName = parts[1];
      return docName;
    }
  }

  // Извлечение из пути
  const pathParts = url.pathname.split('/').filter(p => p);
  if (pathParts.length > 0) {
    // Если есть 'doc' в пути, берем следующий элемент
    const docIndex = pathParts.indexOf('doc');
    if (docIndex !== -1 && docIndex + 1 < pathParts.length) {
      docName = pathParts[docIndex + 1];
    } else {
      // Иначе берем последний элемент пути
      docName = pathParts[pathParts.length - 1];
    }
  }

  // Очистка от query параметров
  docName = docName.split('?')[0].split('&')[0];

  return docName || 'default-room';
}

// HTTP сервер для health-check
const httpServer = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', activeDocs: docs.size }));
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

// WebSocket сервер
const wss = new WebSocketServer({ 
  noServer: true,
  maxPayload: 100 * 1024 * 1024 // 100MB лимит
});

wss.on('connection', (ws, req) => {
  // Извлечение имени документа
  const docName = extractDocNameFromUrl(req.url, req.headers.host);
  
  console.log(`[Auth] Connection accepted (no auth)`);
  console.log(`[Debug] Document: ${docName}`);

  // Получение или создание документа
  const doc = getOrCreateDoc(docName);

  // Настройка соединения через официальную утилиту y-websocket
  // Это обеспечивает полную совместимость с клиентами Yjs
  setupWSConnection(ws, req, { 
    docName,
    gc: true 
  });

  console.log(`[Client] Connected to "${docName}"`);

  ws.on('close', () => {
    console.log(`[Client] Disconnected from "${docName}"`);
  });

  ws.on('error', (err) => {
    console.error(`[Error] WebSocket error on "${docName}":`, err.message);
  });
});

// Апгрейд HTTP -> WebSocket
httpServer.on('upgrade', (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});

// Запуск сервера
httpServer.listen(PORT, HOST, () => {
  console.log(`
========================================
🚀 Server running on ${HOST}:${PORT}
📁 Data directory: ${DATA_DIR}
🔑 Auth: DISABLED (Local only)
🌐 Allowed origins: *

Connect: ws://${HOST}:${PORT}/your-doc-name
Health: http://${HOST}:${PORT}/health
========================================
`);
});

//Graceful shutdown
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

function shutdown() {
  console.log('\n[Server] Shutting down...');
  
  // Сохранение всех документов
  let savedCount = 0;
  for (const [docName, { doc, persistenceFile }] of docs.entries()) {
    try {
      const state = Y.encodeStateAsUpdate(doc);
      fs.writeFileSync(persistenceFile, state);
      savedCount++;
    } catch (err) {
      console.error(`[Server] Error saving ${docName}:`, err.message);
    }
  }
  
  console.log(`[Server] Saved ${savedCount} documents`);
  
  wss.close(() => {
    httpServer.close(() => {
      console.log('[Server] Shutdown complete');
      process.exit(0);
    });
  });
}
