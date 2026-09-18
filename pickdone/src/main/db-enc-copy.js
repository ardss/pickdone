/* Encrypted-launch migration helper: copy a table from the plaintext DB into the enc DB BY NAME.
 * Root fix (2026-09-19, maint/d4): `INSERT INTO enc.t SELECT * FROM main.t` copies BY POSITION.
 * Legacy DBs got important/urgent/reminders/predecessors appended via ALTER TABLE in positions
 * that differ from the current SCHEMA string order — a positional copy silently shifted those
 * values into the wrong columns on the user's first encrypted launch (per-column corruption of
 * every pre-v2 row). Shared column list from both sides; order no longer matters. */
module.exports = function encCopyTable (db, table) {
  const qt = '"' + String(table).replace(/"/g, '""') + '"'
  // Column names via LIMIT-0 statements' .columns() (schema-qualified PRAGMA table_info isn't
  // accepted by this driver build's parser)
  const mainCols = db.prepare('SELECT * FROM main.' + qt + ' LIMIT 0').columns().map(c => c.name)
  const encCols = new Set(db.prepare('SELECT * FROM enc.' + qt + ' LIMIT 0').columns().map(c => c.name))
  const shared = mainCols.filter(c => encCols.has(c)).map(c => '"' + c.replace(/"/g, '""') + '"')
  if (!shared.length) throw new Error('migration: table "' + table + '" has no columns shared with the current schema')
  db.exec('INSERT INTO enc.' + qt + ' (' + shared.join(', ') + ') SELECT ' + shared.join(', ') + ' FROM main.' + qt)
}
