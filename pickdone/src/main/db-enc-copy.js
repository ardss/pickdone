/* Encrypted-launch migration helper: copy a table from the plaintext DB into the enc DB BY NAME.
 * Root fix (2026-09-19, maint/d4): `INSERT INTO enc.t SELECT * FROM main.t` copies BY POSITION.
 * Legacy DBs got important/urgent/reminders/predecessors appended via ALTER TABLE in positions
 * that differ from the current SCHEMA string order — a positional copy silently shifted those
 * values into the wrong columns on the user's first encrypted launch (per-column corruption of
 * every pre-v2 row). Shared column list from both sides; order no longer matters.
 *
 * W15 fix (2026-10-25): the copy used to be all-or-nothing per table — a table absent from the
 * enc schema (legacy DBs can carry tables outside the current SCHEMA string) threw here, failed
 * migratePlainToEncrypted at the same spot on EVERY launch, and the user permanently fell back
 * to plaintext (the at-rest encryption contract silently dead). Unknown tables are no longer a
 * reason to give up: the enc side creates the same-name table from the MAIN table's own DDL
 * (DDL under an ATTACH alias is plain SQLite), then copies all columns by name. A table that
 * exists on both sides but shares zero columns can only be skipped with a loud warn — the
 * migration must NEVER wedge on a leftover table again. */
module.exports = function encCopyTable (db, table) {
  const qt = '"' + String(table).replace(/"/g, '""') + '"'
  // Column names via LIMIT-0 statements' .columns() (schema-qualified PRAGMA table_info isn't
  // accepted by this driver build's parser)
  let encCols = new Set()
  try {
    encCols = new Set(db.prepare('SELECT * FROM enc.' + qt + ' LIMIT 0').columns().map(c => c.name))
  } catch (e) {
    // Table unknown to the enc schema: clone the main table's DDL into the enc namespace,
    // then fall through to the shared-column copy (now every main column is shared).
    const ddlRow = db.prepare("SELECT sql FROM main.sqlite_master WHERE type = 'table' AND name = ?").get(table)
    if (!ddlRow || !ddlRow.sql) {
      console.warn('[db-enc-copy] migration: table "' + table + '" has no DDL on the main side — skipped')
      return
    }
    try {
      db.exec(ddlRow.sql.replace(/^CREATE TABLE /i, 'CREATE TABLE IF NOT EXISTS enc.'))
    } catch (ddlErr) {
      console.warn('[db-enc-copy] migration: could not create enc-side table "' + table + '" — copied from scratch skipped:', ddlErr && ddlErr.message)
      return
    }
    encCols = new Set(db.prepare('SELECT * FROM enc.' + qt + ' LIMIT 0').columns().map(c => c.name))
  }
  const mainCols = db.prepare('SELECT * FROM main.' + qt + ' LIMIT 0').columns().map(c => c.name)
  const shared = mainCols.filter(c => encCols.has(c)).map(c => '"' + c.replace(/"/g, '""') + '"')
  // W15: an enc table with zero columns in common can only be SKIPPED, loudly — throwing here
  // wedged the whole migration on every launch (same permanent-plaintext failure class).
  if (!shared.length) {
    console.warn('[db-enc-copy] migration: table "' + table + '" has no columns shared with the enc schema — rows NOT copied')
    return
  }
  db.exec('INSERT INTO enc.' + qt + ' (' + shared.join(', ') + ') SELECT ' + shared.join(', ') + ' FROM main.' + qt)
}
