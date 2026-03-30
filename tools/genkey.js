// Generate a login key for a user
// Usage: node tools/genkey.js [displayName] [minutes]
// Example: node tools/genkey.js angel 10

const sql = require('mssql');
const config = require('./dbconfig.json');
const name = process.argv[2] || 'angel';
const minutes = parseInt(process.argv[3]) || 10;

(async () => {
  const pool = await sql.connect(config);
  const key = 'VYBE-' + require('crypto').randomBytes(4).toString('hex').toUpperCase();
  await pool.request()
    .input('key', sql.NVarChar, key)
    .input('name', sql.NVarChar, name)
    .input('min', sql.Int, minutes)
    .query("INSERT INTO Vybe_LoginKeys (LoginKey, DisplayName, ExpiresAt) VALUES (@key, @name, DATEADD(MINUTE, @min, GETUTCDATE()))");
  console.log(`LOGIN KEY: ${key}`);
  console.log(`User: ${name} | Expires in ${minutes} min`);
  await pool.close();
})();
