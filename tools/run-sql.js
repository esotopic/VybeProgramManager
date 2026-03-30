// Run arbitrary SQL against the Vybe database
// Usage: node tools/run-sql.js "SELECT TOP 5 * FROM Vybe_Epics"

const sql = require('mssql');
const config = require('./dbconfig.json');
const query = process.argv[2];

if (!query) { console.error('Usage: node tools/run-sql.js "SQL QUERY"'); process.exit(1); }

(async () => {
  const pool = await sql.connect(config);
  const result = await pool.request().query(query);
  if (result.recordset) console.log(JSON.stringify(result.recordset, null, 2));
  else console.log('Done. Rows affected:', result.rowsAffected);
  await pool.close();
})();
