const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 8080;

// ── Database config ──
const DB_CONFIG = {
  server: process.env.DB_SERVER || '***REMOVED***',
  database: process.env.DB_NAME || '1000Problems',
  user: process.env.DB_USER || '***REMOVED***',
  password: process.env.DB_PASSWORD || '***REMOVED***',
  port: 1433,
  options: { encrypt: true, trustServerCertificate: false }
};

let sql;
let dbPool = null;

// ── In-memory caches (loaded from DB at startup) ──
let epics = [];
let areas = [];
let bugs = [];
let tasks = [];
let testcases = [];
let auditLog = [];

// ══════════════════════════════════════
// ── DATABASE INIT ──
// ══════════════════════════════════════

async function initDB() {
  try {
    sql = require('mssql');
    dbPool = await sql.connect({
      server: DB_CONFIG.server,
      database: DB_CONFIG.database,
      user: DB_CONFIG.user,
      password: DB_CONFIG.password,
      port: DB_CONFIG.port,
      options: DB_CONFIG.options,
      pool: { max: 5, min: 0, idleTimeoutMillis: 30000 },
      requestTimeout: 15000
    });
    console.log('Connected to Azure SQL');
    await ensureTables();
    return true;
  } catch (e) {
    console.log('DB not available, running in memory mode:', e.message);
    return false;
  }
}

async function ensureTables() {
  const query = `
    IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'Vybe_LoginKeys')
    BEGIN
      CREATE TABLE Vybe_LoginKeys (
        Id INT IDENTITY(1,1) PRIMARY KEY,
        LoginKey NVARCHAR(20) NOT NULL,
        DisplayName NVARCHAR(100) DEFAULT 'angel',
        CreatedAt DATETIME2 DEFAULT GETUTCDATE(),
        ExpiresAt DATETIME2 NOT NULL,
        Used BIT DEFAULT 0
      );
    END

    IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'Vybe_Sessions')
    BEGIN
      CREATE TABLE Vybe_Sessions (
        Id INT IDENTITY(1,1) PRIMARY KEY,
        SessionToken NVARCHAR(128) NOT NULL UNIQUE,
        DisplayName NVARCHAR(100) NOT NULL,
        CreatedDate DATETIME2 DEFAULT GETUTCDATE(),
        ExpiresDate DATETIME2 NOT NULL
      );
      CREATE INDEX IX_Vybe_Sessions_Token ON Vybe_Sessions(SessionToken);
    END

    IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'Vybe_Epics')
    BEGIN
      CREATE TABLE Vybe_Epics (
        Id UNIQUEIDENTIFIER DEFAULT NEWID() PRIMARY KEY,
        Name NVARCHAR(255) NOT NULL,
        Description NVARCHAR(MAX),
        Status NVARCHAR(50) DEFAULT 'active',
        CreatedBy NVARCHAR(100),
        CreatedAt DATETIME2 DEFAULT SYSUTCDATETIME()
      );
    END

    IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'Vybe_Areas')
    BEGIN
      CREATE TABLE Vybe_Areas (
        Id UNIQUEIDENTIFIER DEFAULT NEWID() PRIMARY KEY,
        EpicId UNIQUEIDENTIFIER NOT NULL,
        Name NVARCHAR(255) NOT NULL,
        Description NVARCHAR(MAX),
        Priority NVARCHAR(10) DEFAULT 'P2',
        Status NVARCHAR(50) DEFAULT 'draft',
        CreatedAt DATETIME2 DEFAULT SYSUTCDATETIME(),
        FOREIGN KEY (EpicId) REFERENCES Vybe_Epics(Id)
      );
    END

    IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'Vybe_Bugs')
    BEGIN
      CREATE TABLE Vybe_Bugs (
        Id UNIQUEIDENTIFIER DEFAULT NEWID() PRIMARY KEY,
        AreaId UNIQUEIDENTIFIER NOT NULL,
        Title NVARCHAR(255) NOT NULL,
        Spec NVARCHAR(MAX),
        Priority NVARCHAR(10) DEFAULT 'P2',
        Status NVARCHAR(50) DEFAULT 'draft',
        Resolution NVARCHAR(MAX),
        AssignedTo NVARCHAR(100),
        ClaimId UNIQUEIDENTIFIER,
        CreatedAt DATETIME2 DEFAULT SYSUTCDATETIME(),
        ClosedAt DATETIME2,
        FOREIGN KEY (AreaId) REFERENCES Vybe_Areas(Id)
      );
    END

    IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'Vybe_Tasks')
    BEGIN
      CREATE TABLE Vybe_Tasks (
        Id UNIQUEIDENTIFIER DEFAULT NEWID() PRIMARY KEY,
        AreaId UNIQUEIDENTIFIER NOT NULL,
        Title NVARCHAR(255) NOT NULL,
        Spec NVARCHAR(MAX),
        Priority NVARCHAR(10) DEFAULT 'P2',
        Status NVARCHAR(50) DEFAULT 'draft',
        Resolution NVARCHAR(MAX),
        AssignedTo NVARCHAR(100),
        ClaimId UNIQUEIDENTIFIER,
        CreatedAt DATETIME2 DEFAULT SYSUTCDATETIME(),
        ClosedAt DATETIME2,
        FOREIGN KEY (AreaId) REFERENCES Vybe_Areas(Id)
      );
    END

    IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'Vybe_TestCases')
    BEGIN
      CREATE TABLE Vybe_TestCases (
        Id UNIQUEIDENTIFIER DEFAULT NEWID() PRIMARY KEY,
        AreaId UNIQUEIDENTIFIER NOT NULL,
        Title NVARCHAR(255) NOT NULL,
        Spec NVARCHAR(MAX),
        Priority NVARCHAR(10) DEFAULT 'P2',
        Status NVARCHAR(50) DEFAULT 'draft',
        LastRunAt DATETIME2,
        LastResult NVARCHAR(MAX),
        CreatedAt DATETIME2 DEFAULT SYSUTCDATETIME(),
        FOREIGN KEY (AreaId) REFERENCES Vybe_Areas(Id)
      );
    END

    IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'Vybe_AuditLog')
    BEGIN
      CREATE TABLE Vybe_AuditLog (
        Id INT IDENTITY(1,1) PRIMARY KEY,
        EntityType NVARCHAR(50) NOT NULL,
        EntityId NVARCHAR(100) NOT NULL,
        Action NVARCHAR(100) NOT NULL,
        Actor NVARCHAR(100),
        PreviousValue NVARCHAR(MAX),
        NewValue NVARCHAR(MAX),
        CreatedAt DATETIME2 DEFAULT SYSUTCDATETIME()
      );
      CREATE INDEX IX_Vybe_AuditLog_Entity ON Vybe_AuditLog(EntityType, EntityId);
    END
  `;
  try {
    await dbPool.request().query(query);
    console.log('Vybe tables ready');
  } catch (e) {
    console.error('Table creation error:', e.message);
  }
}

// ── Load all data from DB into memory ──
async function loadFromDB() {
  if (!dbPool) return;
  try {
    const [e, a, b, t, tc] = await Promise.all([
      dbPool.request().query('SELECT * FROM Vybe_Epics ORDER BY CreatedAt DESC'),
      dbPool.request().query('SELECT * FROM Vybe_Areas ORDER BY CreatedAt DESC'),
      dbPool.request().query('SELECT * FROM Vybe_Bugs ORDER BY CreatedAt DESC'),
      dbPool.request().query('SELECT * FROM Vybe_Tasks ORDER BY CreatedAt DESC'),
      dbPool.request().query('SELECT * FROM Vybe_TestCases ORDER BY CreatedAt DESC'),
    ]);
    epics = e.recordset;
    areas = a.recordset;
    bugs = b.recordset;
    tasks = t.recordset;
    testcases = tc.recordset;
    console.log(`Loaded: ${epics.length} epics, ${areas.length} areas, ${bugs.length} bugs, ${tasks.length} tasks, ${testcases.length} testcases`);
  } catch (e) {
    console.error('Load error:', e.message);
  }
}

// ══════════════════════════════════════
// ── AUTH HELPERS (Claude-as-2FA) ──
// ══════════════════════════════════════
// No passwords. No registration. Claude generates a one-time key,
// inserts it into Vybe_LoginKeys with a 10-minute expiry.
// User types the key on the site → gets a 30-day session cookie.
// After 10 minutes the key is useless. No key = no login possible.

function generateSessionToken() {
  return crypto.randomBytes(48).toString('hex');
}

function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;
  cookieHeader.split(';').forEach(c => {
    const [key, ...val] = c.trim().split('=');
    if (key) cookies[key.trim()] = val.join('=').trim();
  });
  return cookies;
}

async function getUserFromSession(req) {
  if (!dbPool) return null;
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies['vybe_session'];
  if (!token) return null;
  try {
    const result = await dbPool.request()
      .input('token', sql.NVarChar, token)
      .query(`SELECT DisplayName FROM Vybe_Sessions
              WHERE SessionToken = @token AND ExpiresDate > GETUTCDATE()`);
    const row = result.recordset[0];
    if (!row) return null;
    return { DisplayName: row.DisplayName, Username: row.DisplayName };
  } catch (e) {
    console.error('Session lookup error:', e.message);
    return null;
  }
}

// ══════════════════════════════════════
// ── HELPERS ──
// ══════════════════════════════════════

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

function sendJSON(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(body);
}

const MIME_TYPES = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2'
};

// ── Audit log helper ──
async function logAudit(entityType, entityId, action, actor, previousValue, newValue) {
  if (dbPool) {
    try {
      await dbPool.request()
        .input('entityType', sql.NVarChar, entityType)
        .input('entityId', sql.NVarChar, String(entityId))
        .input('action', sql.NVarChar, action)
        .input('actor', sql.NVarChar, actor || 'system')
        .input('prev', sql.NVarChar, previousValue ? JSON.stringify(previousValue) : null)
        .input('newVal', sql.NVarChar, newValue ? JSON.stringify(newValue) : null)
        .query(`INSERT INTO Vybe_AuditLog (EntityType, EntityId, Action, Actor, PreviousValue, NewValue)
                VALUES (@entityType, @entityId, @action, @actor, @prev, @newVal)`);
    } catch (e) { console.error('Audit log error:', e.message); }
  }
}

// ══════════════════════════════════════
// ── REQUEST HANDLER ──
// ══════════════════════════════════════

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    });
    return res.end();
  }

  // ══════════════════════════════════════
  // ── AUTH ROUTES ──
  // ══════════════════════════════════════

  // POST /api/login — Redeem a one-time key (generated by Claude)
  if (pathname === '/api/login' && req.method === 'POST') {
    const { key } = await parseBody(req);
    if (!key) return sendJSON(res, 400, { error: 'Key required' });

    if (dbPool) {
      try {
        // Find a valid, unused, non-expired key
        const result = await dbPool.request()
          .input('key', sql.NVarChar, key.trim())
          .query(`SELECT * FROM Vybe_LoginKeys
                  WHERE LoginKey = @key AND Used = 0 AND ExpiresAt > GETUTCDATE()`);
        const loginKey = result.recordset[0];
        if (!loginKey) {
          return sendJSON(res, 401, { error: 'Invalid or expired key' });
        }

        // Mark key as used immediately
        await dbPool.request()
          .input('id', sql.Int, loginKey.Id)
          .query('UPDATE Vybe_LoginKeys SET Used = 1 WHERE Id = @id');

        // Create a 30-day session
        const token = generateSessionToken();
        const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
        await dbPool.request()
          .input('token', sql.NVarChar, token)
          .input('name', sql.NVarChar, loginKey.DisplayName || 'angel')
          .input('expires', sql.DateTime2, expires)
          .query('INSERT INTO Vybe_Sessions (SessionToken, DisplayName, ExpiresDate) VALUES (@token, @name, @expires)');

        await logAudit('Session', 'login', 'key-login', loginKey.DisplayName, null, { keyId: loginKey.Id });

        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Set-Cookie': `vybe_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30*24*60*60}`
        });
        return res.end(JSON.stringify({ ok: true, user: { displayName: loginKey.DisplayName } }));
      } catch (e) {
        console.error('Login error:', e.message);
        return sendJSON(res, 500, { error: 'Login failed' });
      }
    }
    return sendJSON(res, 500, { error: 'Database required' });
  }

  if (pathname === '/api/me' && req.method === 'GET') {
    const user = await getUserFromSession(req);
    if (!user) return sendJSON(res, 401, { error: 'Not logged in' });
    return sendJSON(res, 200, { user });
  }

  if (pathname === '/api/logout' && req.method === 'POST') {
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies['vybe_session'];
    if (token && dbPool) {
      await dbPool.request().input('token', sql.NVarChar, token)
        .query('DELETE FROM Vybe_Sessions WHERE SessionToken = @token');
    }
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Set-Cookie': 'vybe_session=; Path=/; HttpOnly; Max-Age=0'
    });
    return res.end(JSON.stringify({ ok: true }));
  }

  // ══════════════════════════════════════
  // ── EPICS ──
  // ══════════════════════════════════════

  if (pathname === '/api/epics' && req.method === 'GET') {
    return sendJSON(res, 200, { epics });
  }

  if (pathname === '/api/epics' && req.method === 'POST') {
    const user = await getUserFromSession(req);
    if (!user) return sendJSON(res, 401, { error: 'Not logged in' });
    const { name, description } = await parseBody(req);
    if (!name) return sendJSON(res, 400, { error: 'Name required' });

    if (dbPool) {
      try {
        const result = await dbPool.request()
          .input('name', sql.NVarChar, name)
          .input('desc', sql.NVarChar, description || '')
          .input('createdBy', sql.NVarChar, user.Username)
          .query(`INSERT INTO Vybe_Epics (Name, Description, CreatedBy)
                  OUTPUT INSERTED.*
                  VALUES (@name, @desc, @createdBy)`);
        const epic = result.recordset[0];
        epics.unshift(epic);
        await logAudit('Epic', epic.Id, 'created', user.Username, null, { name });
        return sendJSON(res, 201, { epic });
      } catch (e) {
        return sendJSON(res, 500, { error: e.message });
      }
    }
    return sendJSON(res, 500, { error: 'Database required' });
  }

  if (pathname.startsWith('/api/epics/') && req.method === 'GET' && !pathname.includes('/areas')) {
    const id = pathname.split('/api/epics/')[1];
    const epic = epics.find(e => String(e.Id) === id);
    if (!epic) return sendJSON(res, 404, { error: 'Epic not found' });
    const epicAreas = areas.filter(a => String(a.EpicId) === id);
    return sendJSON(res, 200, { epic, areas: epicAreas });
  }

  if (pathname.startsWith('/api/epics/') && req.method === 'PUT' && !pathname.includes('/areas')) {
    const user = await getUserFromSession(req);
    if (!user) return sendJSON(res, 401, { error: 'Not logged in' });
    const id = pathname.split('/api/epics/')[1];
    const { name, description, status } = await parseBody(req);

    if (dbPool) {
      try {
        const prev = epics.find(e => String(e.Id) === id);
        const result = await dbPool.request()
          .input('id', sql.UniqueIdentifier, id)
          .input('name', sql.NVarChar, name || prev?.Name)
          .input('desc', sql.NVarChar, description !== undefined ? description : prev?.Description)
          .input('status', sql.NVarChar, status || prev?.Status)
          .query(`UPDATE Vybe_Epics SET Name=@name, Description=@desc, Status=@status
                  OUTPUT INSERTED.*
                  WHERE Id=@id`);
        const epic = result.recordset[0];
        if (!epic) return sendJSON(res, 404, { error: 'Not found' });
        const idx = epics.findIndex(e => String(e.Id) === id);
        if (idx >= 0) epics[idx] = epic;
        await logAudit('Epic', id, 'updated', user.Username, prev, epic);
        return sendJSON(res, 200, { epic });
      } catch (e) {
        return sendJSON(res, 500, { error: e.message });
      }
    }
    return sendJSON(res, 500, { error: 'Database required' });
  }

  // ══════════════════════════════════════
  // ── AREAS ──
  // ══════════════════════════════════════

  // GET /api/epics/:epicId/areas
  if (pathname.match(/^\/api\/epics\/[^/]+\/areas$/) && req.method === 'GET') {
    const epicId = pathname.split('/')[3];
    const epicAreas = areas.filter(a => String(a.EpicId) === epicId);
    return sendJSON(res, 200, { areas: epicAreas });
  }

  // POST /api/epics/:epicId/areas
  if (pathname.match(/^\/api\/epics\/[^/]+\/areas$/) && req.method === 'POST') {
    const user = await getUserFromSession(req);
    if (!user) return sendJSON(res, 401, { error: 'Not logged in' });
    const epicId = pathname.split('/')[3];
    const { name, description, priority } = await parseBody(req);
    if (!name) return sendJSON(res, 400, { error: 'Name required' });

    if (dbPool) {
      try {
        const result = await dbPool.request()
          .input('epicId', sql.UniqueIdentifier, epicId)
          .input('name', sql.NVarChar, name)
          .input('desc', sql.NVarChar, description || '')
          .input('priority', sql.NVarChar, priority || 'P2')
          .query(`INSERT INTO Vybe_Areas (EpicId, Name, Description, Priority)
                  OUTPUT INSERTED.*
                  VALUES (@epicId, @name, @desc, @priority)`);
        const area = result.recordset[0];
        areas.unshift(area);
        await logAudit('Area', area.Id, 'created', user.Username, null, { name, epicId });
        return sendJSON(res, 201, { area });
      } catch (e) {
        return sendJSON(res, 500, { error: e.message });
      }
    }
    return sendJSON(res, 500, { error: 'Database required' });
  }

  // GET /api/areas/:id
  if (pathname.match(/^\/api\/areas\/[^/]+$/) && req.method === 'GET') {
    const id = pathname.split('/api/areas/')[1];
    const area = areas.find(a => String(a.Id) === id);
    if (!area) return sendJSON(res, 404, { error: 'Area not found' });
    const areaBugs = bugs.filter(b => String(b.AreaId) === id);
    const areaTasks = tasks.filter(t => String(t.AreaId) === id);
    const areaTests = testcases.filter(tc => String(tc.AreaId) === id);
    return sendJSON(res, 200, { area, bugs: areaBugs, tasks: areaTasks, testcases: areaTests });
  }

  // PUT /api/areas/:id
  if (pathname.match(/^\/api\/areas\/[^/]+$/) && req.method === 'PUT') {
    const user = await getUserFromSession(req);
    if (!user) return sendJSON(res, 401, { error: 'Not logged in' });
    const id = pathname.split('/api/areas/')[1];
    const body = await parseBody(req);
    const prev = areas.find(a => String(a.Id) === id);
    if (!prev) return sendJSON(res, 404, { error: 'Not found' });

    if (dbPool) {
      try {
        const result = await dbPool.request()
          .input('id', sql.UniqueIdentifier, id)
          .input('name', sql.NVarChar, body.name || prev.Name)
          .input('desc', sql.NVarChar, body.description !== undefined ? body.description : prev.Description)
          .input('priority', sql.NVarChar, body.priority || prev.Priority)
          .input('status', sql.NVarChar, body.status || prev.Status)
          .query(`UPDATE Vybe_Areas SET Name=@name, Description=@desc, Priority=@priority, Status=@status
                  OUTPUT INSERTED.*
                  WHERE Id=@id`);
        const area = result.recordset[0];
        const idx = areas.findIndex(a => String(a.Id) === id);
        if (idx >= 0) areas[idx] = area;
        await logAudit('Area', id, 'updated', user.Username, prev, area);
        return sendJSON(res, 200, { area });
      } catch (e) {
        return sendJSON(res, 500, { error: e.message });
      }
    }
    return sendJSON(res, 500, { error: 'Database required' });
  }

  // ══════════════════════════════════════
  // ── WORK ITEMS (Bugs, Tasks, TestCases) ──
  // ══════════════════════════════════════

  // Generic work item creator
  async function createWorkItem(table, areaId, body, user) {
    const { title, spec, priority } = body;
    if (!title) return { status: 400, data: { error: 'Title required' } };
    try {
      const result = await dbPool.request()
        .input('areaId', sql.UniqueIdentifier, areaId)
        .input('title', sql.NVarChar, title)
        .input('spec', sql.NVarChar, spec || '')
        .input('priority', sql.NVarChar, priority || 'P2')
        .query(`INSERT INTO ${table} (AreaId, Title, Spec, Priority)
                OUTPUT INSERTED.*
                VALUES (@areaId, @title, @spec, @priority)`);
      const item = result.recordset[0];
      const type = table.replace('Vybe_', '');
      await logAudit(type, item.Id, 'created', user.Username, null, { title, areaId });
      return { status: 201, data: { item } };
    } catch (e) {
      return { status: 500, data: { error: e.message } };
    }
  }

  // ── BUGS ──

  // GET /api/areas/:areaId/bugs
  if (pathname.match(/^\/api\/areas\/[^/]+\/bugs$/) && req.method === 'GET') {
    const areaId = pathname.split('/')[3];
    return sendJSON(res, 200, { bugs: bugs.filter(b => String(b.AreaId) === areaId) });
  }

  // POST /api/areas/:areaId/bugs
  if (pathname.match(/^\/api\/areas\/[^/]+\/bugs$/) && req.method === 'POST') {
    const user = await getUserFromSession(req);
    if (!user) return sendJSON(res, 401, { error: 'Not logged in' });
    if (!dbPool) return sendJSON(res, 500, { error: 'Database required' });
    const areaId = pathname.split('/')[3];
    const body = await parseBody(req);
    const result = await createWorkItem('Vybe_Bugs', areaId, body, user);
    if (result.status === 201) bugs.unshift(result.data.item);
    return sendJSON(res, result.status, result.data);
  }

  // GET /api/bugs/:id
  if (pathname.match(/^\/api\/bugs\/[^/]+$/) && req.method === 'GET') {
    const id = pathname.split('/api/bugs/')[1];
    const bug = bugs.find(b => String(b.Id) === id);
    if (!bug) return sendJSON(res, 404, { error: 'Bug not found' });
    return sendJSON(res, 200, { item: bug });
  }

  // PUT /api/bugs/:id
  if (pathname.match(/^\/api\/bugs\/[^/]+$/) && req.method === 'PUT') {
    const user = await getUserFromSession(req);
    if (!user) return sendJSON(res, 401, { error: 'Not logged in' });
    if (!dbPool) return sendJSON(res, 500, { error: 'Database required' });
    const id = pathname.split('/api/bugs/')[1];
    const body = await parseBody(req);
    const prev = bugs.find(b => String(b.Id) === id);
    if (!prev) return sendJSON(res, 404, { error: 'Not found' });

    try {
      const result = await dbPool.request()
        .input('id', sql.UniqueIdentifier, id)
        .input('title', sql.NVarChar, body.title || prev.Title)
        .input('spec', sql.NVarChar, body.spec !== undefined ? body.spec : prev.Spec)
        .input('priority', sql.NVarChar, body.priority || prev.Priority)
        .input('status', sql.NVarChar, body.status || prev.Status)
        .input('resolution', sql.NVarChar, body.resolution !== undefined ? body.resolution : prev.Resolution)
        .input('assignedTo', sql.NVarChar, body.assignedTo !== undefined ? body.assignedTo : prev.AssignedTo)
        .input('closedAt', sql.DateTime2, body.status === 'closed' ? new Date() : prev.ClosedAt)
        .query(`UPDATE Vybe_Bugs SET Title=@title, Spec=@spec, Priority=@priority, Status=@status,
                Resolution=@resolution, AssignedTo=@assignedTo, ClosedAt=@closedAt
                OUTPUT INSERTED.*
                WHERE Id=@id`);
      const item = result.recordset[0];
      const idx = bugs.findIndex(b => String(b.Id) === id);
      if (idx >= 0) bugs[idx] = item;
      await logAudit('Bug', id, 'updated', user.Username, { status: prev.Status }, { status: item.Status });
      return sendJSON(res, 200, { item });
    } catch (e) {
      return sendJSON(res, 500, { error: e.message });
    }
  }

  // ── TASKS ──

  if (pathname.match(/^\/api\/areas\/[^/]+\/tasks$/) && req.method === 'GET') {
    const areaId = pathname.split('/')[3];
    return sendJSON(res, 200, { tasks: tasks.filter(t => String(t.AreaId) === areaId) });
  }

  if (pathname.match(/^\/api\/areas\/[^/]+\/tasks$/) && req.method === 'POST') {
    const user = await getUserFromSession(req);
    if (!user) return sendJSON(res, 401, { error: 'Not logged in' });
    if (!dbPool) return sendJSON(res, 500, { error: 'Database required' });
    const areaId = pathname.split('/')[3];
    const body = await parseBody(req);
    const result = await createWorkItem('Vybe_Tasks', areaId, body, user);
    if (result.status === 201) tasks.unshift(result.data.item);
    return sendJSON(res, result.status, result.data);
  }

  if (pathname.match(/^\/api\/tasks\/[^/]+$/) && req.method === 'GET') {
    const id = pathname.split('/api/tasks/')[1];
    const task = tasks.find(t => String(t.Id) === id);
    if (!task) return sendJSON(res, 404, { error: 'Task not found' });
    return sendJSON(res, 200, { item: task });
  }

  if (pathname.match(/^\/api\/tasks\/[^/]+$/) && req.method === 'PUT') {
    const user = await getUserFromSession(req);
    if (!user) return sendJSON(res, 401, { error: 'Not logged in' });
    if (!dbPool) return sendJSON(res, 500, { error: 'Database required' });
    const id = pathname.split('/api/tasks/')[1];
    const body = await parseBody(req);
    const prev = tasks.find(t => String(t.Id) === id);
    if (!prev) return sendJSON(res, 404, { error: 'Not found' });

    try {
      const result = await dbPool.request()
        .input('id', sql.UniqueIdentifier, id)
        .input('title', sql.NVarChar, body.title || prev.Title)
        .input('spec', sql.NVarChar, body.spec !== undefined ? body.spec : prev.Spec)
        .input('priority', sql.NVarChar, body.priority || prev.Priority)
        .input('status', sql.NVarChar, body.status || prev.Status)
        .input('resolution', sql.NVarChar, body.resolution !== undefined ? body.resolution : prev.Resolution)
        .input('assignedTo', sql.NVarChar, body.assignedTo !== undefined ? body.assignedTo : prev.AssignedTo)
        .input('closedAt', sql.DateTime2, body.status === 'closed' ? new Date() : prev.ClosedAt)
        .query(`UPDATE Vybe_Tasks SET Title=@title, Spec=@spec, Priority=@priority, Status=@status,
                Resolution=@resolution, AssignedTo=@assignedTo, ClosedAt=@closedAt
                OUTPUT INSERTED.*
                WHERE Id=@id`);
      const item = result.recordset[0];
      const idx = tasks.findIndex(t => String(t.Id) === id);
      if (idx >= 0) tasks[idx] = item;
      await logAudit('Task', id, 'updated', user.Username, { status: prev.Status }, { status: item.Status });
      return sendJSON(res, 200, { item });
    } catch (e) {
      return sendJSON(res, 500, { error: e.message });
    }
  }

  // ── TEST CASES ──

  if (pathname.match(/^\/api\/areas\/[^/]+\/testcases$/) && req.method === 'GET') {
    const areaId = pathname.split('/')[3];
    return sendJSON(res, 200, { testcases: testcases.filter(tc => String(tc.AreaId) === areaId) });
  }

  if (pathname.match(/^\/api\/areas\/[^/]+\/testcases$/) && req.method === 'POST') {
    const user = await getUserFromSession(req);
    if (!user) return sendJSON(res, 401, { error: 'Not logged in' });
    if (!dbPool) return sendJSON(res, 500, { error: 'Database required' });
    const areaId = pathname.split('/')[3];
    const body = await parseBody(req);
    if (!body.title) return sendJSON(res, 400, { error: 'Title required' });
    try {
      const result = await dbPool.request()
        .input('areaId', sql.UniqueIdentifier, areaId)
        .input('title', sql.NVarChar, body.title)
        .input('spec', sql.NVarChar, body.spec || '')
        .input('priority', sql.NVarChar, body.priority || 'P2')
        .query(`INSERT INTO Vybe_TestCases (AreaId, Title, Spec, Priority)
                OUTPUT INSERTED.*
                VALUES (@areaId, @title, @spec, @priority)`);
      const item = result.recordset[0];
      testcases.unshift(item);
      await logAudit('TestCase', item.Id, 'created', user.Username, null, { title: body.title });
      return sendJSON(res, 201, { item });
    } catch (e) {
      return sendJSON(res, 500, { error: e.message });
    }
  }

  if (pathname.match(/^\/api\/testcases\/[^/]+$/) && req.method === 'GET') {
    const id = pathname.split('/api/testcases/')[1];
    const tc = testcases.find(t => String(t.Id) === id);
    if (!tc) return sendJSON(res, 404, { error: 'TestCase not found' });
    return sendJSON(res, 200, { item: tc });
  }

  if (pathname.match(/^\/api\/testcases\/[^/]+$/) && req.method === 'PUT') {
    const user = await getUserFromSession(req);
    if (!user) return sendJSON(res, 401, { error: 'Not logged in' });
    if (!dbPool) return sendJSON(res, 500, { error: 'Database required' });
    const id = pathname.split('/api/testcases/')[1];
    const body = await parseBody(req);
    const prev = testcases.find(t => String(t.Id) === id);
    if (!prev) return sendJSON(res, 404, { error: 'Not found' });

    try {
      const result = await dbPool.request()
        .input('id', sql.UniqueIdentifier, id)
        .input('title', sql.NVarChar, body.title || prev.Title)
        .input('spec', sql.NVarChar, body.spec !== undefined ? body.spec : prev.Spec)
        .input('priority', sql.NVarChar, body.priority || prev.Priority)
        .input('status', sql.NVarChar, body.status || prev.Status)
        .input('lastResult', sql.NVarChar, body.lastResult !== undefined ? body.lastResult : prev.LastResult)
        .input('lastRunAt', sql.DateTime2, body.status === 'pass' || body.status === 'fail' ? new Date() : prev.LastRunAt)
        .query(`UPDATE Vybe_TestCases SET Title=@title, Spec=@spec, Priority=@priority, Status=@status,
                LastResult=@lastResult, LastRunAt=@lastRunAt
                OUTPUT INSERTED.*
                WHERE Id=@id`);
      const item = result.recordset[0];
      const idx = testcases.findIndex(t => String(t.Id) === id);
      if (idx >= 0) testcases[idx] = item;
      await logAudit('TestCase', id, 'updated', user.Username, { status: prev.Status }, { status: item.Status });
      return sendJSON(res, 200, { item });
    } catch (e) {
      return sendJSON(res, 500, { error: e.message });
    }
  }

  // ══════════════════════════════════════
  // ── BOARD (all items for an epic) ──
  // ══════════════════════════════════════

  if (pathname === '/api/board' && req.method === 'GET') {
    const epicId = url.searchParams.get('epicId');
    let boardAreas = epicId ? areas.filter(a => String(a.EpicId) === epicId) : areas;
    const areaIds = new Set(boardAreas.map(a => String(a.Id)));

    const boardBugs = bugs.filter(b => areaIds.has(String(b.AreaId)));
    const boardTasks = tasks.filter(t => areaIds.has(String(t.AreaId)));
    const boardTests = testcases.filter(tc => areaIds.has(String(tc.AreaId)));

    // Combine into unified items list
    const items = [
      ...boardBugs.map(b => ({ ...b, _type: 'bug' })),
      ...boardTasks.map(t => ({ ...t, _type: 'task' })),
      ...boardTests.map(tc => ({ ...tc, _type: 'testcase' })),
    ];

    return sendJSON(res, 200, { items, areas: boardAreas, epics });
  }

  // ══════════════════════════════════════
  // ── TRIAGE ──
  // ══════════════════════════════════════

  if (pathname.match(/^\/api\/triage\/[^/]+$/) && req.method === 'POST') {
    const user = await getUserFromSession(req);
    if (!user) return sendJSON(res, 401, { error: 'Not logged in' });
    if (!dbPool) return sendJSON(res, 500, { error: 'Database required' });
    const id = pathname.split('/api/triage/')[1];
    const { type } = await parseBody(req); // 'bug', 'task', 'testcase'
    const table = type === 'bug' ? 'Vybe_Bugs' : type === 'task' ? 'Vybe_Tasks' : 'Vybe_TestCases';

    try {
      const result = await dbPool.request()
        .input('id', sql.UniqueIdentifier, id)
        .query(`UPDATE ${table} SET Status='triaged' OUTPUT INSERTED.* WHERE Id=@id AND Status='draft'`);
      const item = result.recordset[0];
      if (!item) return sendJSON(res, 400, { error: 'Item not in draft status' });

      // Update cache
      const cache = type === 'bug' ? bugs : type === 'task' ? tasks : testcases;
      const idx = cache.findIndex(i => String(i.Id) === id);
      if (idx >= 0) cache[idx] = item;

      await logAudit(type, id, 'triaged', user.Username, { status: 'draft' }, { status: 'triaged' });
      return sendJSON(res, 200, { item });
    } catch (e) {
      return sendJSON(res, 500, { error: e.message });
    }
  }

  // Batch triage
  if (pathname === '/api/triage/batch' && req.method === 'POST') {
    const user = await getUserFromSession(req);
    if (!user) return sendJSON(res, 401, { error: 'Not logged in' });
    if (!dbPool) return sendJSON(res, 500, { error: 'Database required' });
    const { items: itemList } = await parseBody(req); // [{id, type}]
    if (!itemList || !Array.isArray(itemList)) return sendJSON(res, 400, { error: 'items array required' });

    const results = [];
    for (const { id, type } of itemList) {
      const table = type === 'bug' ? 'Vybe_Bugs' : type === 'task' ? 'Vybe_Tasks' : 'Vybe_TestCases';
      try {
        const result = await dbPool.request()
          .input('id', sql.UniqueIdentifier, id)
          .query(`UPDATE ${table} SET Status='triaged' OUTPUT INSERTED.* WHERE Id=@id AND Status='draft'`);
        if (result.recordset[0]) {
          const cache = type === 'bug' ? bugs : type === 'task' ? tasks : testcases;
          const idx = cache.findIndex(i => String(i.Id) === id);
          if (idx >= 0) cache[idx] = result.recordset[0];
          results.push({ id, ok: true });
          await logAudit(type, id, 'triaged', user.Username, null, null);
        } else {
          results.push({ id, ok: false, error: 'Not in draft' });
        }
      } catch (e) {
        results.push({ id, ok: false, error: e.message });
      }
    }
    return sendJSON(res, 200, { results });
  }

  // ══════════════════════════════════════
  // ── QUEUE (for Claude agents) ──
  // ══════════════════════════════════════

  if (pathname === '/api/queue/next' && req.method === 'POST') {
    if (!dbPool) return sendJSON(res, 500, { error: 'Database required' });
    const epicId = url.searchParams.get('epicId');
    const claimId = crypto.randomUUID();

    // Try bugs first (highest priority area, then highest priority bug)
    const epicFilter = epicId ? `AND a.EpicId = @epicId` : '';
    const tables = [
      { name: 'Vybe_Bugs', type: 'bug', cache: bugs },
      { name: 'Vybe_Tasks', type: 'task', cache: tasks },
      { name: 'Vybe_TestCases', type: 'testcase', cache: testcases }
    ];

    for (const { name, type, cache } of tables) {
      try {
        const req2 = dbPool.request()
          .input('claimId', sql.UniqueIdentifier, claimId);
        if (epicId) req2.input('epicId', sql.UniqueIdentifier, epicId);

        // Claim the top-priority triaged item
        await req2.query(`
          UPDATE TOP(1) t SET t.Status = 'ai-in-progress', t.ClaimId = @claimId, t.AssignedTo = 'claude'
          FROM ${name} t
          JOIN Vybe_Areas a ON t.AreaId = a.Id
          WHERE t.Status = 'triaged' ${epicFilter}
          AND t.Id = (
            SELECT TOP(1) t2.Id FROM ${name} t2
            JOIN Vybe_Areas a2 ON t2.AreaId = a2.Id
            WHERE t2.Status = 'triaged' ${epicFilter ? 'AND a2.EpicId = @epicId' : ''}
            ORDER BY
              CASE a2.Priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 WHEN 'P3' THEN 3 ELSE 9 END,
              CASE t2.Priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 WHEN 'P3' THEN 3 ELSE 9 END,
              t2.CreatedAt ASC
          )
        `);

        // Fetch claimed item
        const claimed = await dbPool.request()
          .input('claimId', sql.UniqueIdentifier, claimId)
          .query(`SELECT t.*, a.Name as AreaName, a.EpicId, e.Name as EpicName
                  FROM ${name} t
                  JOIN Vybe_Areas a ON t.AreaId = a.Id
                  JOIN Vybe_Epics e ON a.EpicId = e.Id
                  WHERE t.ClaimId = @claimId`);

        if (claimed.recordset.length > 0) {
          const item = { ...claimed.recordset[0], _type: type };
          // Update cache
          const idx = cache.findIndex(i => String(i.Id) === String(item.Id));
          if (idx >= 0) cache[idx] = { ...cache[idx], Status: 'ai-in-progress', ClaimId: claimId, AssignedTo: 'claude' };
          await logAudit(type, item.Id, 'claimed', 'claude', { status: 'triaged' }, { status: 'ai-in-progress', claimId });
          return sendJSON(res, 200, { item });
        }
      } catch (e) {
        console.error(`Queue claim error (${name}):`, e.message);
      }
    }

    // Nothing in queue
    res.writeHead(204);
    return res.end();
  }

  // POST /api/queue/complete/:id
  if (pathname.match(/^\/api\/queue\/complete\/[^/]+$/) && req.method === 'POST') {
    if (!dbPool) return sendJSON(res, 500, { error: 'Database required' });
    const id = pathname.split('/api/queue/complete/')[1];
    const { type, resolution } = await parseBody(req);
    const table = type === 'bug' ? 'Vybe_Bugs' : type === 'task' ? 'Vybe_Tasks' : 'Vybe_TestCases';

    try {
      let result;
      if (type === 'testcase') {
        result = await dbPool.request()
          .input('id', sql.UniqueIdentifier, id)
          .input('lastResult', sql.NVarChar, resolution || '')
          .query(`UPDATE ${table} SET Status='pass', LastResult=@lastResult, LastRunAt=SYSUTCDATETIME()
                  OUTPUT INSERTED.* WHERE Id=@id AND Status='triaged'`);
      } else {
        result = await dbPool.request()
          .input('id', sql.UniqueIdentifier, id)
          .input('resolution', sql.NVarChar, resolution || '')
          .query(`UPDATE ${table} SET Status='ai-done', Resolution=@resolution
                  OUTPUT INSERTED.* WHERE Id=@id AND Status='ai-in-progress'`);
      }
      const item = result.recordset[0];
      if (!item) return sendJSON(res, 400, { error: 'Item not in expected status' });
      const cache = type === 'bug' ? bugs : type === 'task' ? tasks : testcases;
      const idx = cache.findIndex(i => String(i.Id) === id);
      if (idx >= 0) cache[idx] = item;
      await logAudit(type, id, 'completed', 'claude', null, { resolution });
      return sendJSON(res, 200, { item });
    } catch (e) {
      return sendJSON(res, 500, { error: e.message });
    }
  }

  // POST /api/queue/block/:id
  if (pathname.match(/^\/api\/queue\/block\/[^/]+$/) && req.method === 'POST') {
    if (!dbPool) return sendJSON(res, 500, { error: 'Database required' });
    const id = pathname.split('/api/queue/block/')[1];
    const { type, resolution } = await parseBody(req);
    const table = type === 'bug' ? 'Vybe_Bugs' : type === 'task' ? 'Vybe_Tasks' : 'Vybe_TestCases';

    try {
      const result = await dbPool.request()
        .input('id', sql.UniqueIdentifier, id)
        .input('resolution', sql.NVarChar, resolution || '')
        .query(`UPDATE ${table} SET Status='blocked', Resolution=@resolution
                OUTPUT INSERTED.* WHERE Id=@id AND Status='ai-in-progress'`);
      const item = result.recordset[0];
      if (!item) return sendJSON(res, 400, { error: 'Item not in ai-in-progress' });
      const cache = type === 'bug' ? bugs : type === 'task' ? tasks : testcases;
      const idx = cache.findIndex(i => String(i.Id) === id);
      if (idx >= 0) cache[idx] = item;
      await logAudit(type, id, 'blocked', 'claude', null, { reason: resolution });
      return sendJSON(res, 200, { item });
    } catch (e) {
      return sendJSON(res, 500, { error: e.message });
    }
  }

  // ══════════════════════════════════════
  // ── AUDIT LOG ──
  // ══════════════════════════════════════

  if (pathname === '/api/audit' && req.method === 'GET') {
    if (!dbPool) return sendJSON(res, 200, { log: [] });
    const entityType = url.searchParams.get('type');
    const entityId = url.searchParams.get('id');
    const limit = parseInt(url.searchParams.get('limit')) || 50;

    try {
      let q = 'SELECT TOP(@limit) * FROM Vybe_AuditLog';
      const conditions = [];
      const req2 = dbPool.request().input('limit', sql.Int, limit);
      if (entityType) { conditions.push('EntityType = @type'); req2.input('type', sql.NVarChar, entityType); }
      if (entityId) { conditions.push('EntityId = @entityId'); req2.input('entityId', sql.NVarChar, entityId); }
      if (conditions.length) q += ' WHERE ' + conditions.join(' AND ');
      q += ' ORDER BY CreatedAt DESC';
      const result = await req2.query(q);
      return sendJSON(res, 200, { log: result.recordset });
    } catch (e) {
      return sendJSON(res, 500, { error: e.message });
    }
  }

  // ══════════════════════════════════════
  // ── STATIC FILE SERVING ──
  // ══════════════════════════════════════

  let filePath = pathname === '/' ? '/index.html' : pathname;
  filePath = path.join(__dirname, 'public', filePath);

  const ext = path.extname(filePath);
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      fs.readFile(path.join(__dirname, 'public', 'index.html'), (err2, data2) => {
        if (err2) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(data2);
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}

// ══════════════════════════════════════
// ── START ──
// ══════════════════════════════════════

const server = http.createServer(handleRequest);

initDB().then(async () => {
  await loadFromDB();
  server.listen(PORT, () => {
    console.log(`Vybe PM running on port ${PORT}`);
  });
});
