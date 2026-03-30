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
let stories = [];
let bugs = [];
let tasks = [];
let testcases = [];

// ══════════════════════════════════════
// ── DATABASE INIT ──
// ══════════════════════════════════════

async function initDB(retries = 3) {
  sql = require('mssql');
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      console.log(`DB connection attempt ${attempt}/${retries}...`);
      dbPool = await sql.connect({
        server: DB_CONFIG.server,
        database: DB_CONFIG.database,
        user: DB_CONFIG.user,
        password: DB_CONFIG.password,
        port: DB_CONFIG.port,
        options: DB_CONFIG.options,
        pool: { max: 5, min: 0, idleTimeoutMillis: 30000 },
        requestTimeout: 30000,
        connectionTimeout: 60000
      });
      console.log('Connected to Azure SQL');
      await ensureTables();
      await migrateSchema();
      return true;
    } catch (e) {
      console.log(`DB attempt ${attempt} failed: ${e.message}`);
      if (attempt < retries) {
        console.log('Waiting 15s before retry (DB may be waking from auto-pause)...');
        await new Promise(r => setTimeout(r, 15000));
        // Close any partial pool before retrying
        try { await sql.close(); } catch (_) {}
      }
    }
  }
  console.log('All DB attempts failed, running in memory mode');
  return false;
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

    IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'Vybe_UserStories')
    BEGIN
      CREATE TABLE Vybe_UserStories (
        Id UNIQUEIDENTIFIER DEFAULT NEWID() PRIMARY KEY,
        EpicId UNIQUEIDENTIFIER NOT NULL,
        Title NVARCHAR(255) NOT NULL,
        Description NVARCHAR(MAX),
        AcceptanceCriteria NVARCHAR(MAX),
        Priority NVARCHAR(10) DEFAULT 'P2',
        Status NVARCHAR(50) DEFAULT 'open',
        CreatedBy NVARCHAR(100),
        CreatedAt DATETIME2 DEFAULT SYSUTCDATETIME(),
        FOREIGN KEY (EpicId) REFERENCES Vybe_Epics(Id)
      );
    END

    IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'Vybe_Bugs')
    BEGIN
      CREATE TABLE Vybe_Bugs (
        Id UNIQUEIDENTIFIER DEFAULT NEWID() PRIMARY KEY,
        UserStoryId UNIQUEIDENTIFIER NOT NULL,
        Title NVARCHAR(255) NOT NULL,
        Spec NVARCHAR(MAX),
        Priority NVARCHAR(10) DEFAULT 'P2',
        Status NVARCHAR(50) DEFAULT 'draft',
        Resolution NVARCHAR(MAX),
        AssignedTo NVARCHAR(100),
        ClaimId UNIQUEIDENTIFIER,
        CreatedAt DATETIME2 DEFAULT SYSUTCDATETIME(),
        ClosedAt DATETIME2,
        FOREIGN KEY (UserStoryId) REFERENCES Vybe_UserStories(Id)
      );
    END

    IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'Vybe_Tasks')
    BEGIN
      CREATE TABLE Vybe_Tasks (
        Id UNIQUEIDENTIFIER DEFAULT NEWID() PRIMARY KEY,
        UserStoryId UNIQUEIDENTIFIER NOT NULL,
        Title NVARCHAR(255) NOT NULL,
        Spec NVARCHAR(MAX),
        Priority NVARCHAR(10) DEFAULT 'P2',
        Status NVARCHAR(50) DEFAULT 'draft',
        Resolution NVARCHAR(MAX),
        AssignedTo NVARCHAR(100),
        ClaimId UNIQUEIDENTIFIER,
        CreatedAt DATETIME2 DEFAULT SYSUTCDATETIME(),
        ClosedAt DATETIME2,
        FOREIGN KEY (UserStoryId) REFERENCES Vybe_UserStories(Id)
      );
    END

    IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'Vybe_TestCases')
    BEGIN
      CREATE TABLE Vybe_TestCases (
        Id UNIQUEIDENTIFIER DEFAULT NEWID() PRIMARY KEY,
        UserStoryId UNIQUEIDENTIFIER NOT NULL,
        Title NVARCHAR(255) NOT NULL,
        Spec NVARCHAR(MAX),
        Priority NVARCHAR(10) DEFAULT 'P2',
        Status NVARCHAR(50) DEFAULT 'draft',
        LastRunAt DATETIME2,
        LastResult NVARCHAR(MAX),
        CreatedAt DATETIME2 DEFAULT SYSUTCDATETIME(),
        FOREIGN KEY (UserStoryId) REFERENCES Vybe_UserStories(Id)
      );
    END

    IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'Vybe_ApiTokens')
    BEGIN
      CREATE TABLE Vybe_ApiTokens (
        Id INT IDENTITY(1,1) PRIMARY KEY,
        Token NVARCHAR(128) NOT NULL UNIQUE,
        DisplayName NVARCHAR(100) NOT NULL,
        Label NVARCHAR(255),
        CreatedAt DATETIME2 DEFAULT GETUTCDATE(),
        ExpiresAt DATETIME2,
        Active BIT DEFAULT 1
      );
      CREATE INDEX IX_Vybe_ApiTokens_Token ON Vybe_ApiTokens(Token);
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

// ── Schema migration: add UserStoryId to existing tables that still use AreaId ──
async function migrateSchema() {
  try {
    const tables = ['Vybe_Tasks', 'Vybe_Bugs', 'Vybe_TestCases'];
    for (const tbl of tables) {
      // Drop any FK constraints referencing Vybe_Areas on this table
      const fkCheck = await dbPool.request().query(`
        SELECT fk.name AS fk_name
        FROM sys.foreign_keys fk
        JOIN sys.tables t ON fk.parent_object_id = t.object_id
        JOIN sys.tables rt ON fk.referenced_object_id = rt.object_id
        WHERE t.name = '${tbl}' AND rt.name = 'Vybe_Areas'
      `);
      for (const fk of fkCheck.recordset) {
        console.log('Dropping old FK constraint:', fk.fk_name, 'on', tbl);
        await dbPool.request().query(`ALTER TABLE ${tbl} DROP CONSTRAINT [${fk.fk_name}]`);
      }

      // Check if AreaId exists but UserStoryId doesn't
      const colCheck = await dbPool.request().query(`
        SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_NAME = '${tbl}' AND COLUMN_NAME IN ('AreaId','UserStoryId')
      `);
      const cols = colCheck.recordset.map(r => r.COLUMN_NAME);
      if (cols.includes('AreaId') && !cols.includes('UserStoryId')) {
        console.log(`Migrating ${tbl}: renaming AreaId -> UserStoryId`);
        await dbPool.request().query(`EXEC sp_rename '${tbl}.AreaId', 'UserStoryId', 'COLUMN'`);
      } else if (!cols.includes('UserStoryId') && !cols.includes('AreaId')) {
        console.log(`Migrating ${tbl}: adding UserStoryId column`);
        await dbPool.request().query(`ALTER TABLE ${tbl} ADD UserStoryId UNIQUEIDENTIFIER NULL`);
      }
    }
    console.log('Schema migration complete');
  } catch (e) {
    console.error('Migration error:', e.message);
  }
}

// ── Load all data from DB into memory ──
async function loadFromDB() {
  if (!dbPool) return;
  try {
    const [e, s, b, t, tc] = await Promise.all([
      dbPool.request().query('SELECT * FROM Vybe_Epics ORDER BY CreatedAt DESC'),
      dbPool.request().query('SELECT * FROM Vybe_UserStories ORDER BY CreatedAt DESC'),
      dbPool.request().query('SELECT * FROM Vybe_Bugs ORDER BY CreatedAt DESC'),
      dbPool.request().query('SELECT * FROM Vybe_Tasks ORDER BY CreatedAt DESC'),
      dbPool.request().query('SELECT * FROM Vybe_TestCases ORDER BY CreatedAt DESC'),
    ]);
    epics = e.recordset;
    stories = s.recordset;
    bugs = b.recordset;
    tasks = t.recordset;
    testcases = tc.recordset;
    console.log(`Loaded: ${epics.length} epics, ${stories.length} stories, ${bugs.length} bugs, ${tasks.length} tasks, ${testcases.length} testcases`);
  } catch (e) {
    console.error('Load error:', e.message);
  }
}

// ══════════════════════════════════════
// ── AUTH HELPERS ──
// ══════════════════════════════════════

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
  const authHeader = req.headers['authorization'] || '';
  if (authHeader.startsWith('Bearer ')) {
    const apiToken = authHeader.slice(7).trim();
    if (apiToken) {
      try {
        const result = await dbPool.request()
          .input('token', sql.NVarChar, apiToken)
          .query(`SELECT DisplayName FROM Vybe_ApiTokens WHERE Token = @token AND Active = 1 AND (ExpiresAt IS NULL OR ExpiresAt > GETUTCDATE())`);
        const row = result.recordset[0];
        if (row) return { DisplayName: row.DisplayName, Username: row.DisplayName, _api: true };
      } catch (e) { console.error('API token error:', e.message); }
    }
  }
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies['vybe_session'];
  if (!token) return null;
  try {
    const result = await dbPool.request()
      .input('token', sql.NVarChar, token)
      .query(`SELECT DisplayName FROM Vybe_Sessions WHERE SessionToken = @token AND ExpiresDate > GETUTCDATE()`);
    const row = result.recordset[0];
    if (!row) return null;
    return { DisplayName: row.DisplayName, Username: row.DisplayName };
  } catch (e) { return null; }
}

// ══════════════════════════════════════
// ── HELPERS ──
// ══════════════════════════════════════

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve({}); } });
    req.on('error', reject);
  });
}

function sendJSON(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data));
}

const MIME_TYPES = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
};

async function logAudit(entityType, entityId, action, actor, prev, next) {
  if (!dbPool) return;
  try {
    await dbPool.request()
      .input('entityType', sql.NVarChar, entityType)
      .input('entityId', sql.NVarChar, String(entityId))
      .input('action', sql.NVarChar, action)
      .input('actor', sql.NVarChar, actor || 'system')
      .input('prev', sql.NVarChar, prev ? JSON.stringify(prev) : null)
      .input('newVal', sql.NVarChar, next ? JSON.stringify(next) : null)
      .query(`INSERT INTO Vybe_AuditLog (EntityType, EntityId, Action, Actor, PreviousValue, NewValue) VALUES (@entityType, @entityId, @action, @actor, @prev, @newVal)`);
  } catch (e) { console.error('Audit error:', e.message); }
}

// ══════════════════════════════════════
// ── REQUEST HANDLER ──
// ══════════════════════════════════════

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' });
    return res.end();
  }

  // ══════════════════════════════════════
  // ── AUTH ROUTES ──
  // ══════════════════════════════════════

  if (pathname === '/api/login' && req.method === 'POST') {
    const { key } = await parseBody(req);
    if (!key) return sendJSON(res, 400, { error: 'Key required' });
    const MASTER_KEY = '***REMOVED***';
    if (key.trim() === MASTER_KEY && dbPool) {
      try {
        const token = generateSessionToken();
        const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
        await dbPool.request().input('token', sql.NVarChar, token).input('name', sql.NVarChar, 'angel').input('expires', sql.DateTime2, expires)
          .query('INSERT INTO Vybe_Sessions (SessionToken, DisplayName, ExpiresDate) VALUES (@token, @name, @expires)');
        await logAudit('Session', 'login', 'master-key', 'angel', null, {});
        res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': `vybe_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30*24*60*60}` });
        return res.end(JSON.stringify({ ok: true, user: { displayName: 'angel' } }));
      } catch (e) { return sendJSON(res, 500, { error: 'Login failed' }); }
    }
    if (dbPool) {
      try {
        const result = await dbPool.request().input('key', sql.NVarChar, key.trim())
          .query(`SELECT * FROM Vybe_LoginKeys WHERE LoginKey = @key AND Used = 0 AND ExpiresAt > GETUTCDATE()`);
        const loginKey = result.recordset[0];
        if (!loginKey) return sendJSON(res, 401, { error: 'Invalid or expired key' });
        await dbPool.request().input('id', sql.Int, loginKey.Id).query('UPDATE Vybe_LoginKeys SET Used = 1 WHERE Id = @id');
        const token = generateSessionToken();
        const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
        await dbPool.request().input('token', sql.NVarChar, token).input('name', sql.NVarChar, loginKey.DisplayName || 'angel').input('expires', sql.DateTime2, expires)
          .query('INSERT INTO Vybe_Sessions (SessionToken, DisplayName, ExpiresDate) VALUES (@token, @name, @expires)');
        await logAudit('Session', 'login', 'key-login', loginKey.DisplayName, null, {});
        res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': `vybe_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30*24*60*60}` });
        return res.end(JSON.stringify({ ok: true, user: { displayName: loginKey.DisplayName } }));
      } catch (e) { return sendJSON(res, 500, { error: 'Login failed' }); }
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
    if (token && dbPool) await dbPool.request().input('token', sql.NVarChar, token).query('DELETE FROM Vybe_Sessions WHERE SessionToken = @token');
    res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'vybe_session=; Path=/; HttpOnly; Max-Age=0' });
    return res.end(JSON.stringify({ ok: true }));
  }

  // ══════════════════════════════════════
  // ── EPICS (Projects) ──
  // ══════════════════════════════════════

  if (pathname === '/api/epics' && req.method === 'GET') {
    return sendJSON(res, 200, { epics });
  }

  if (pathname === '/api/epics' && req.method === 'POST') {
    const user = await getUserFromSession(req);
    if (!user) return sendJSON(res, 401, { error: 'Not logged in' });
    const { name, description } = await parseBody(req);
    if (!name) return sendJSON(res, 400, { error: 'Name required' });
    if (!dbPool) return sendJSON(res, 500, { error: 'Database required' });
    try {
      const result = await dbPool.request().input('name', sql.NVarChar, name).input('desc', sql.NVarChar, description || '').input('createdBy', sql.NVarChar, user.Username)
        .query(`INSERT INTO Vybe_Epics (Name, Description, CreatedBy) OUTPUT INSERTED.* VALUES (@name, @desc, @createdBy)`);
      const epic = result.recordset[0];
      epics.unshift(epic);
      await logAudit('Epic', epic.Id, 'created', user.Username, null, { name });
      return sendJSON(res, 201, { epic });
    } catch (e) { return sendJSON(res, 500, { error: e.message }); }
  }

  // ══════════════════════════════════════
  // ── USER STORIES ──
  // ══════════════════════════════════════

  // GET /api/stories?epicId=X
  if (pathname === '/api/stories' && req.method === 'GET') {
    const epicId = url.searchParams.get('epicId');
    const filtered = epicId ? stories.filter(s => String(s.EpicId) === epicId) : stories;
    // Attach item counts
    const result = filtered.map(s => {
      const sid = String(s.Id);
      const storyBugs = bugs.filter(b => String(b.UserStoryId) === sid);
      const storyTasks = tasks.filter(t => String(t.UserStoryId) === sid);
      const storyTests = testcases.filter(tc => String(tc.UserStoryId) === sid);
      const allItems = [...storyBugs, ...storyTasks, ...storyTests];
      const doneCount = allItems.filter(i => i.Status === 'closed' || i.Status === 'ai-done' || i.Status === 'pass').length;
      return { ...s, _totalItems: allItems.length, _doneItems: doneCount };
    });
    return sendJSON(res, 200, { stories: result });
  }

  // POST /api/stories
  if (pathname === '/api/stories' && req.method === 'POST') {
    const user = await getUserFromSession(req);
    if (!user) return sendJSON(res, 401, { error: 'Not logged in' });
    const { epicId, title, description, acceptanceCriteria, priority } = await parseBody(req);
    if (!epicId || !title) return sendJSON(res, 400, { error: 'epicId and title required' });
    if (!dbPool) return sendJSON(res, 500, { error: 'Database required' });
    try {
      const result = await dbPool.request()
        .input('epicId', sql.UniqueIdentifier, epicId)
        .input('title', sql.NVarChar, title)
        .input('desc', sql.NVarChar, description || '')
        .input('ac', sql.NVarChar, acceptanceCriteria || '')
        .input('priority', sql.NVarChar, priority || 'P2')
        .input('createdBy', sql.NVarChar, user.Username)
        .query(`INSERT INTO Vybe_UserStories (EpicId, Title, Description, AcceptanceCriteria, Priority, CreatedBy) OUTPUT INSERTED.* VALUES (@epicId, @title, @desc, @ac, @priority, @createdBy)`);
      const story = result.recordset[0];
      stories.unshift(story);
      await logAudit('UserStory', story.Id, 'created', user.Username, null, { title, epicId });
      return sendJSON(res, 201, { story });
    } catch (e) { return sendJSON(res, 500, { error: e.message }); }
  }

  // GET /api/stories/:id
  if (pathname.match(/^\/api\/stories\/[^/]+$/) && req.method === 'GET') {
    const id = pathname.split('/api/stories/')[1];
    const story = stories.find(s => String(s.Id) === id);
    if (!story) return sendJSON(res, 404, { error: 'Story not found' });
    const sid = String(story.Id);
    const items = [
      ...bugs.filter(b => String(b.UserStoryId) === sid).map(b => ({ ...b, _type: 'bug' })),
      ...tasks.filter(t => String(t.UserStoryId) === sid).map(t => ({ ...t, _type: 'task' })),
      ...testcases.filter(tc => String(tc.UserStoryId) === sid).map(tc => ({ ...tc, _type: 'testcase' })),
    ];
    return sendJSON(res, 200, { story, items });
  }

  // PUT /api/stories/:id
  if (pathname.match(/^\/api\/stories\/[^/]+$/) && req.method === 'PUT') {
    const user = await getUserFromSession(req);
    if (!user) return sendJSON(res, 401, { error: 'Not logged in' });
    const id = pathname.split('/api/stories/')[1];
    const body = await parseBody(req);
    const prev = stories.find(s => String(s.Id) === id);
    if (!prev) return sendJSON(res, 404, { error: 'Not found' });
    if (!dbPool) return sendJSON(res, 500, { error: 'Database required' });
    try {
      const result = await dbPool.request()
        .input('id', sql.UniqueIdentifier, id)
        .input('title', sql.NVarChar, body.title || prev.Title)
        .input('desc', sql.NVarChar, body.description !== undefined ? body.description : prev.Description)
        .input('ac', sql.NVarChar, body.acceptanceCriteria !== undefined ? body.acceptanceCriteria : prev.AcceptanceCriteria)
        .input('priority', sql.NVarChar, body.priority || prev.Priority)
        .input('status', sql.NVarChar, body.status || prev.Status)
        .query(`UPDATE Vybe_UserStories SET Title=@title, Description=@desc, AcceptanceCriteria=@ac, Priority=@priority, Status=@status OUTPUT INSERTED.* WHERE Id=@id`);
      const story = result.recordset[0];
      const idx = stories.findIndex(s => String(s.Id) === id);
      if (idx >= 0) stories[idx] = story;
      await logAudit('UserStory', id, 'updated', user.Username, prev, story);
      return sendJSON(res, 200, { story });
    } catch (e) { return sendJSON(res, 500, { error: e.message }); }
  }

  // ══════════════════════════════════════
  // ── WORK ITEMS (Bugs, Tasks, TestCases) — now tied to UserStoryId ──
  // ══════════════════════════════════════

  // GET /api/items?epicId=X — all items across all stories for a project
  if (pathname === '/api/items' && req.method === 'GET') {
    const epicId = url.searchParams.get('epicId');
    if (!epicId) return sendJSON(res, 400, { error: 'epicId required' });
    const epicStories = stories.filter(s => String(s.EpicId) === epicId);
    const storyMap = {};
    epicStories.forEach(s => { storyMap[String(s.Id)] = s.Title; });
    const storyIds = new Set(epicStories.map(s => String(s.Id)));
    const items = [
      ...bugs.filter(b => storyIds.has(String(b.UserStoryId))).map(b => ({ ...b, _type: 'bug', _storyTitle: storyMap[String(b.UserStoryId)] || '' })),
      ...tasks.filter(t => storyIds.has(String(t.UserStoryId))).map(t => ({ ...t, _type: 'task', _storyTitle: storyMap[String(t.UserStoryId)] || '' })),
      ...testcases.filter(tc => storyIds.has(String(tc.UserStoryId))).map(tc => ({ ...tc, _type: 'testcase', _storyTitle: storyMap[String(tc.UserStoryId)] || '' })),
    ];
    return sendJSON(res, 200, { items });
  }

  // POST /api/items — universal item creator
  if (pathname === '/api/items' && req.method === 'POST') {
    const user = await getUserFromSession(req);
    if (!user) return sendJSON(res, 401, { error: 'Not logged in' });
    if (!dbPool) return sendJSON(res, 500, { error: 'Database required' });
    const { type, userStoryId, title, spec, priority } = await parseBody(req);
    if (!type || !userStoryId || !title) return sendJSON(res, 400, { error: 'type, userStoryId and title required' });
    const table = type === 'bug' ? 'Vybe_Bugs' : type === 'task' ? 'Vybe_Tasks' : type === 'testcase' ? 'Vybe_TestCases' : null;
    if (!table) return sendJSON(res, 400, { error: 'type must be bug, task, or testcase' });
    try {
      const result = await dbPool.request()
        .input('usId', sql.UniqueIdentifier, userStoryId)
        .input('title', sql.NVarChar, title)
        .input('spec', sql.NVarChar, spec || '')
        .input('priority', sql.NVarChar, priority || 'P2')
        .query(`INSERT INTO ${table} (UserStoryId, Title, Spec, Priority) OUTPUT INSERTED.* VALUES (@usId, @title, @spec, @priority)`);
      const item = result.recordset[0];
      const cache = type === 'bug' ? bugs : type === 'task' ? tasks : testcases;
      cache.unshift(item);
      await logAudit(type, item.Id, 'created', user.Username, null, { title, userStoryId });
      return sendJSON(res, 201, { item: { ...item, _type: type } });
    } catch (e) { return sendJSON(res, 500, { error: e.message }); }
  }

  // PUT /api/items/:id — universal item updater
  if (pathname.match(/^\/api\/items\/[^/]+$/) && req.method === 'PUT') {
    const user = await getUserFromSession(req);
    if (!user) return sendJSON(res, 401, { error: 'Not logged in' });
    if (!dbPool) return sendJSON(res, 500, { error: 'Database required' });
    const id = pathname.split('/api/items/')[1];
    const body = await parseBody(req);
    const type = body.type;
    if (!type) return sendJSON(res, 400, { error: 'type required' });
    const table = type === 'bug' ? 'Vybe_Bugs' : type === 'task' ? 'Vybe_Tasks' : 'Vybe_TestCases';
    const cache = type === 'bug' ? bugs : type === 'task' ? tasks : testcases;
    const prev = cache.find(i => String(i.Id) === id);
    if (!prev) return sendJSON(res, 404, { error: 'Not found' });
    try {
      let result;
      if (type === 'testcase') {
        result = await dbPool.request()
          .input('id', sql.UniqueIdentifier, id)
          .input('title', sql.NVarChar, body.title || prev.Title)
          .input('spec', sql.NVarChar, body.spec !== undefined ? body.spec : prev.Spec)
          .input('priority', sql.NVarChar, body.priority || prev.Priority)
          .input('status', sql.NVarChar, body.status || prev.Status)
          .input('lastResult', sql.NVarChar, body.lastResult !== undefined ? body.lastResult : prev.LastResult)
          .query(`UPDATE Vybe_TestCases SET Title=@title, Spec=@spec, Priority=@priority, Status=@status, LastResult=@lastResult OUTPUT INSERTED.* WHERE Id=@id`);
      } else {
        result = await dbPool.request()
          .input('id', sql.UniqueIdentifier, id)
          .input('title', sql.NVarChar, body.title || prev.Title)
          .input('spec', sql.NVarChar, body.spec !== undefined ? body.spec : prev.Spec)
          .input('priority', sql.NVarChar, body.priority || prev.Priority)
          .input('status', sql.NVarChar, body.status || prev.Status)
          .input('resolution', sql.NVarChar, body.resolution !== undefined ? body.resolution : prev.Resolution)
          .input('assignedTo', sql.NVarChar, body.assignedTo !== undefined ? body.assignedTo : prev.AssignedTo)
          .input('closedAt', sql.DateTime2, body.status === 'closed' ? new Date() : prev.ClosedAt)
          .query(`UPDATE ${table} SET Title=@title, Spec=@spec, Priority=@priority, Status=@status, Resolution=@resolution, AssignedTo=@assignedTo, ClosedAt=@closedAt OUTPUT INSERTED.* WHERE Id=@id`);
      }
      const item = result.recordset[0];
      const idx = cache.findIndex(i => String(i.Id) === id);
      if (idx >= 0) cache[idx] = item;
      await logAudit(type, id, 'updated', user.Username, { status: prev.Status }, { status: item.Status });
      return sendJSON(res, 200, { item: { ...item, _type: type } });
    } catch (e) { return sendJSON(res, 500, { error: e.message }); }
  }

  // ══════════════════════════════════════
  // ── BATCH INSERT ──
  // ══════════════════════════════════════

  if (pathname === '/api/batch' && req.method === 'POST') {
    const user = await getUserFromSession(req);
    if (!user) return sendJSON(res, 401, { error: 'Not logged in' });
    if (!dbPool) return sendJSON(res, 500, { error: 'Database required' });
    const { items: itemList } = await parseBody(req);
    if (!itemList || !Array.isArray(itemList)) return sendJSON(res, 400, { error: 'items array required' });
    const results = [];
    for (const item of itemList) {
      try {
        const t = item.type;
        if (t === 'epic') {
          const r = await dbPool.request().input('name', sql.NVarChar, item.name).input('desc', sql.NVarChar, item.description || '').input('createdBy', sql.NVarChar, user.Username)
            .query(`INSERT INTO Vybe_Epics (Name, Description, CreatedBy) OUTPUT INSERTED.* VALUES (@name, @desc, @createdBy)`);
          epics.unshift(r.recordset[0]);
          results.push({ ok: true, type: 'epic', id: r.recordset[0].Id, name: r.recordset[0].Name });
        } else if (t === 'userstory' || t === 'story') {
          const r = await dbPool.request()
            .input('epicId', sql.UniqueIdentifier, item.epicId)
            .input('title', sql.NVarChar, item.title)
            .input('desc', sql.NVarChar, item.description || '')
            .input('ac', sql.NVarChar, item.acceptanceCriteria || '')
            .input('priority', sql.NVarChar, item.priority || 'P2')
            .input('createdBy', sql.NVarChar, user.Username)
            .query(`INSERT INTO Vybe_UserStories (EpicId, Title, Description, AcceptanceCriteria, Priority, CreatedBy) OUTPUT INSERTED.* VALUES (@epicId, @title, @desc, @ac, @priority, @createdBy)`);
          stories.unshift(r.recordset[0]);
          results.push({ ok: true, type: 'userstory', id: r.recordset[0].Id, title: r.recordset[0].Title });
        } else if (t === 'bug' || t === 'task' || t === 'testcase') {
          const table = t === 'bug' ? 'Vybe_Bugs' : t === 'task' ? 'Vybe_Tasks' : 'Vybe_TestCases';
          const r = await dbPool.request()
            .input('usId', sql.UniqueIdentifier, item.userStoryId)
            .input('title', sql.NVarChar, item.title)
            .input('spec', sql.NVarChar, item.spec || '')
            .input('priority', sql.NVarChar, item.priority || 'P2')
            .query(`INSERT INTO ${table} (UserStoryId, Title, Spec, Priority) OUTPUT INSERTED.* VALUES (@usId, @title, @spec, @priority)`);
          const cache = t === 'bug' ? bugs : t === 'task' ? tasks : testcases;
          cache.unshift(r.recordset[0]);
          results.push({ ok: true, type: t, id: r.recordset[0].Id, title: r.recordset[0].Title });
        } else {
          results.push({ ok: false, error: `Unknown type: ${t}` });
        }
      } catch (e) { results.push({ ok: false, type: item.type, error: e.message }); }
    }
    await logAudit('Batch', 'bulk', 'batch-insert', user.Username, null, { count: results.filter(r => r.ok).length });
    return sendJSON(res, 200, { results });
  }

  // ══════════════════════════════════════
  // ── TRIAGE ──
  // ══════════════════════════════════════

  if (pathname.match(/^\/api\/triage\/[^/]+$/) && req.method === 'POST') {
    const user = await getUserFromSession(req);
    if (!user) return sendJSON(res, 401, { error: 'Not logged in' });
    if (!dbPool) return sendJSON(res, 500, { error: 'Database required' });
    const id = pathname.split('/api/triage/')[1];
    const { type } = await parseBody(req);
    const table = type === 'bug' ? 'Vybe_Bugs' : type === 'task' ? 'Vybe_Tasks' : 'Vybe_TestCases';
    try {
      const result = await dbPool.request().input('id', sql.UniqueIdentifier, id)
        .query(`UPDATE ${table} SET Status='triaged' OUTPUT INSERTED.* WHERE Id=@id AND Status='draft'`);
      const item = result.recordset[0];
      if (!item) return sendJSON(res, 400, { error: 'Not in draft' });
      const cache = type === 'bug' ? bugs : type === 'task' ? tasks : testcases;
      const idx = cache.findIndex(i => String(i.Id) === id);
      if (idx >= 0) cache[idx] = item;
      await logAudit(type, id, 'triaged', user.Username, null, null);
      return sendJSON(res, 200, { item });
    } catch (e) { return sendJSON(res, 500, { error: e.message }); }
  }

  if (pathname === '/api/triage/batch' && req.method === 'POST') {
    const user = await getUserFromSession(req);
    if (!user) return sendJSON(res, 401, { error: 'Not logged in' });
    if (!dbPool) return sendJSON(res, 500, { error: 'Database required' });
    const { items: itemList } = await parseBody(req);
    if (!itemList || !Array.isArray(itemList)) return sendJSON(res, 400, { error: 'items array required' });
    const results = [];
    for (const { id, type } of itemList) {
      const table = type === 'bug' ? 'Vybe_Bugs' : type === 'task' ? 'Vybe_Tasks' : 'Vybe_TestCases';
      try {
        const result = await dbPool.request().input('id', sql.UniqueIdentifier, id)
          .query(`UPDATE ${table} SET Status='triaged' OUTPUT INSERTED.* WHERE Id=@id AND Status='draft'`);
        if (result.recordset[0]) {
          const cache = type === 'bug' ? bugs : type === 'task' ? tasks : testcases;
          const idx = cache.findIndex(i => String(i.Id) === id);
          if (idx >= 0) cache[idx] = result.recordset[0];
          results.push({ id, ok: true });
        } else { results.push({ id, ok: false, error: 'Not in draft' }); }
      } catch (e) { results.push({ id, ok: false, error: e.message }); }
    }
    return sendJSON(res, 200, { results });
  }

  // ══════════════════════════════════════
  // ── QUEUE (for agents) ──
  // ══════════════════════════════════════

  if (pathname === '/api/queue/next' && req.method === 'POST') {
    const user = await getUserFromSession(req);
    if (!user) return sendJSON(res, 401, { error: 'Auth required' });
    if (!dbPool) return sendJSON(res, 500, { error: 'Database required' });
    const epicId = url.searchParams.get('epicId');
    const claimId = crypto.randomUUID();
    const epicFilter = epicId ? `AND us.EpicId = @epicId` : '';
    const tables = [
      { name: 'Vybe_Bugs', type: 'bug', cache: bugs },
      { name: 'Vybe_Tasks', type: 'task', cache: tasks },
      { name: 'Vybe_TestCases', type: 'testcase', cache: testcases }
    ];
    for (const { name, type, cache } of tables) {
      try {
        const req2 = dbPool.request().input('claimId', sql.UniqueIdentifier, claimId);
        if (epicId) req2.input('epicId', sql.UniqueIdentifier, epicId);
        await req2.query(`
          UPDATE TOP(1) t SET t.Status = 'ai-in-progress', t.ClaimId = @claimId, t.AssignedTo = 'claude'
          FROM ${name} t
          JOIN Vybe_UserStories us ON t.UserStoryId = us.Id
          WHERE t.Status = 'triaged' ${epicFilter}
          AND t.Id = (
            SELECT TOP(1) t2.Id FROM ${name} t2
            JOIN Vybe_UserStories us2 ON t2.UserStoryId = us2.Id
            WHERE t2.Status = 'triaged' ${epicFilter ? 'AND us2.EpicId = @epicId' : ''}
            ORDER BY
              CASE us2.Priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 WHEN 'P3' THEN 3 ELSE 9 END,
              CASE t2.Priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 WHEN 'P3' THEN 3 ELSE 9 END,
              t2.CreatedAt ASC
          )
        `);
        const claimed = await dbPool.request().input('claimId', sql.UniqueIdentifier, claimId)
          .query(`SELECT t.*, us.Title as StoryTitle, us.EpicId, e.Name as EpicName FROM ${name} t JOIN Vybe_UserStories us ON t.UserStoryId = us.Id JOIN Vybe_Epics e ON us.EpicId = e.Id WHERE t.ClaimId = @claimId`);
        if (claimed.recordset.length > 0) {
          const item = { ...claimed.recordset[0], _type: type };
          const idx = cache.findIndex(i => String(i.Id) === String(item.Id));
          if (idx >= 0) cache[idx] = { ...cache[idx], Status: 'ai-in-progress', ClaimId: claimId, AssignedTo: 'claude' };
          await logAudit(type, item.Id, 'claimed', 'claude', null, { claimId });
          return sendJSON(res, 200, { item });
        }
      } catch (e) { console.error(`Queue error (${name}):`, e.message); }
    }
    res.writeHead(204); return res.end();
  }

  if (pathname.match(/^\/api\/queue\/complete\/[^/]+$/) && req.method === 'POST') {
    const user = await getUserFromSession(req);
    if (!user) return sendJSON(res, 401, { error: 'Auth required' });
    if (!dbPool) return sendJSON(res, 500, { error: 'Database required' });
    const id = pathname.split('/api/queue/complete/')[1];
    const { type, resolution } = await parseBody(req);
    const table = type === 'bug' ? 'Vybe_Bugs' : type === 'task' ? 'Vybe_Tasks' : 'Vybe_TestCases';
    try {
      let result;
      if (type === 'testcase') {
        result = await dbPool.request().input('id', sql.UniqueIdentifier, id).input('lastResult', sql.NVarChar, resolution || '')
          .query(`UPDATE ${table} SET Status='pass', LastResult=@lastResult, LastRunAt=SYSUTCDATETIME() OUTPUT INSERTED.* WHERE Id=@id AND Status='ai-in-progress'`);
      } else {
        result = await dbPool.request().input('id', sql.UniqueIdentifier, id).input('resolution', sql.NVarChar, resolution || '')
          .query(`UPDATE ${table} SET Status='ai-done', Resolution=@resolution OUTPUT INSERTED.* WHERE Id=@id AND Status='ai-in-progress'`);
      }
      const item = result.recordset[0];
      if (!item) return sendJSON(res, 400, { error: 'Not in expected status' });
      const cache = type === 'bug' ? bugs : type === 'task' ? tasks : testcases;
      const idx = cache.findIndex(i => String(i.Id) === id);
      if (idx >= 0) cache[idx] = item;
      await logAudit(type, id, 'completed', 'claude', null, { resolution });
      return sendJSON(res, 200, { item });
    } catch (e) { return sendJSON(res, 500, { error: e.message }); }
  }

  if (pathname.match(/^\/api\/queue\/block\/[^/]+$/) && req.method === 'POST') {
    const user = await getUserFromSession(req);
    if (!user) return sendJSON(res, 401, { error: 'Auth required' });
    if (!dbPool) return sendJSON(res, 500, { error: 'Database required' });
    const id = pathname.split('/api/queue/block/')[1];
    const { type, resolution } = await parseBody(req);
    const table = type === 'bug' ? 'Vybe_Bugs' : type === 'task' ? 'Vybe_Tasks' : 'Vybe_TestCases';
    try {
      const result = await dbPool.request().input('id', sql.UniqueIdentifier, id).input('resolution', sql.NVarChar, resolution || '')
        .query(`UPDATE ${table} SET Status='blocked', Resolution=@resolution OUTPUT INSERTED.* WHERE Id=@id AND Status='ai-in-progress'`);
      const item = result.recordset[0];
      if (!item) return sendJSON(res, 400, { error: 'Not in ai-in-progress' });
      const cache = type === 'bug' ? bugs : type === 'task' ? tasks : testcases;
      const idx = cache.findIndex(i => String(i.Id) === id);
      if (idx >= 0) cache[idx] = item;
      return sendJSON(res, 200, { item });
    } catch (e) { return sendJSON(res, 500, { error: e.message }); }
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
    } catch (e) { return sendJSON(res, 500, { error: e.message }); }
  }

  // ══════════════════════════════════════
  // ── STATIC FILES ──
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
