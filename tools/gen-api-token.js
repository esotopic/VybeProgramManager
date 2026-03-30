// Generate a long-lived API token for programmatic access
// Usage: node tools/gen-api-token.js [displayName] [label]
// Example: node tools/gen-api-token.js claude "Cowork API access"

const sql = require('mssql');
const crypto = require('crypto');
const config = require('./dbconfig.json');
const name = process.argv[2] || 'claude';
const label = process.argv[3] || 'API token';

(async () => {
  const pool = await sql.connect(config);
  const token = 'vybe_' + crypto.randomBytes(32).toString('hex');
  await pool.request()
    .input('token', sql.NVarChar, token)
    .input('name', sql.NVarChar, name)
    .input('label', sql.NVarChar, label)
    .query("INSERT INTO Vybe_ApiTokens (Token, DisplayName, Label) VALUES (@token, @name, @label)");
  console.log(`API TOKEN: ${token}`);
  console.log(`User: ${name} | Label: ${label} | No expiry`);
  await pool.close();
})();
