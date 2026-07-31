/* Runs schema.sql against MySQL. Usage: npm run migrate */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

async function main() {
  const dbName = process.env.DB_NAME || 'paint_visualizer';
  let sql = fs.readFileSync(path.join(__dirname, '../sql/schema.sql'), 'utf8');
  sql = sql.replace(/paint_visualizer/g, dbName);
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    multipleStatements: true,
  });

  console.log('Applying schema.sql ...');
  await connection.query(sql);
  console.log('Done.');
  await connection.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
