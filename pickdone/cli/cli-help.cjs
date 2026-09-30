#!/usr/bin/env node
/**
 * HELP text for cli/pickdone.js — extracted unchanged (size ratchet: pure move).
 */
const HELP = `PickDone CLI — unified task management for humans and AI agents

Usage: node cli/pickdone.js <command> [args] [options]

Read commands:
  overview                        today/overdue/no-date/recycle summary
  list   [range|--all]            list tasks (default: today)
        range: today (default) tomorrow week (this ISO week) next7d (rolling 7 days) overdue future
        filters: --done --undone --no-date --category <name|id> --keyword <word>
        --quad q1|q2|q3|q4               four-quadrant filter (q1 important+urgent, q2 important, q3 urgent, q4 neither)
        --on <date>                      what's scheduled on one specific day, with times (scheduling view)
        --view <name|id>                 apply a saved view's conditions first (as in the App: undone tasks only); inline filters narrow it further
        --lunar                          append the lunar date annotation (· 七月廿九) to each displayed date
  search <keyword>                search by content/description
  get    <taskId|keyword>         show full fields of one task
  categories                      list categories (folders first-class, children indented)
  category add <name> [--color hex] [--parent <folder>] [--folder]   create a category or folder (names stay unique)
  category rename <name|id> <newName>                     rename a category
  category move <name|id> --parent <folder|root>          move a category under a folder or back to root (folder→folder rejected: the App renders folders as roots only)
  category rm <name|id> [--yes]   soft-delete a category (--dry-run to preview; tasks kept, recoverable in App)
  tag    [list]                   list tags (derived from #tag in titles/descriptions)
  tag rename <old> <new>          rewrite #old → #new across all tasks
  tag rm <name>                   strip a tag from all tasks
  projects [--status active|paused|done|cancelled]        list projects (progress/focus minutes/overdue/next 7 days)
  project <name|id> [--on|--off] [--deadline date|none] [--status active|paused|done|cancelled|none]  details / set project / set deadline / set lifecycle status (none clears)
  view list                       saved smart lists (same filters table the App's filter views use)
  view add <name> [--category <name|id>] [--priority 0-3] [--overdue] [--nodate]
                                  create a saved view (conds = category/priority/date only — the shared contract; use list --view + inline filters for more)
  view rm <name|id>               delete a saved view
  milestone <project> [list|add <title> <date>|rm <n>|link <n> <task>|unlink <n> <task>]   project milestones (date: YYYY-MM-DD/MM-DD/today/+14d)
  stats  [--from YYYY-MM-DD --to YYYY-MM-DD]  daily done/focus stats (default: last 7 days)
  recycle                         list recycle bin
  plan   [list] [date]            show schedule chips for a day (default: today)
  plan set <taskId|keyword> <HH:mm> [--date D] [--replace]   put a task on the day timeline at HH:mm
  plan rm <taskId|keyword> [--at HH:mm] [--date D]           remove a chip (--at targets one chip; default clears the task's chips that day)
  settings [list|get <key>]       list all known settings with current values
  settings set <key> <value>      change a setting (e.g. backupDir "D:\\backups", colorMode dark, dailyTomatoTarget 10; running App applies within ~2s; protected keys like lock password are rejected)
  log    [--n 20] [--action x]    external write audit trail (every AI change is traceable)

Write commands:
  batch done <id> [<id>...]                       complete many (ids only; subtask cascade / repeat renewal apply)
  batch date <id>... --to <date>                  reschedule many (today/tomorrow/+Nd/YYYY-MM-DD[ HH:mm], same parser as edit)
  batch category <id>... --to <name|id>           recategorize many
  batch tag <id>... (--add <tag> | --rm <tag>)    add/remove a #tag on many tasks (same rewrite path as tag rename)
          common: --dry-run (print the per-task plan, writes nothing); --json (data: {op, matched, changed, failures})
          batch takes exact taskIds only — unknown ids land in failures[] and never abort the remaining tasks
  add    <content> [--desc text] [--date today|tomorrow|+3d|YYYY-MM-DD[ HH:mm]] [--created-at "YYYY-MM-DD HH:mm"]
         [--after <taskId|keyword>] [--reminder same as date] [--category name] [--difficulty 0-3] [--estimate 0-20]
         [--deadline date|none] [--important 0|1] [--urgent 0|1] [--priority 0-3]
  done   <taskId|keyword>         complete a task (--no-sub-cascade to skip subtasks; --at "YYYY-MM-DD HH:mm" backdates completedAt)
  undo   <taskId|keyword>         undo completion
  edit   <taskId|keyword> [--content text] [--desc text] [--date value|none] [--reminder value|none] [--remind-offset "10,30"|none] [--remind-extra "D HH:mm,..."|none] [--category name] [--important 0|1] [--urgent 0|1] [--priority 0-3] [--difficulty 0-3] [--deadline date|none] [--estimate 0-20]
         --date none|clear: clear the date — task moves back to the todo box (main reminder drops with the date and that day's schedule chips are removed, same as the App; no-op with changed:0 if already undated)
         --remind-offset: minutes BEFORE the main reminder (needs --reminder set); --remind-extra: extra absolute datetimes
  sort   <taskId|keyword> top|up|down|bottom|before <task2>|after <task2>   manual order (scoped to the task's own day; edit --date first to co-locate)
  deps  <task> list|add|rm [predTask]   explicit dependency edges (FS semantics: task is ready when all predecessors are done)
  ready [--project <name|id>]            undone tasks with all predecessors complete — "what can I do next"
  import <file.csv> [--format auto|ticktick|dida365|todoist] [--dry-run]
         [--category <name>] [--no-lists]      migrate from another app (list names become categories by default)
  delete <taskId|keyword>         move to recycle bin
  restore <taskId|keyword>        restore from recycle bin
  purge  [--dry-run] --yes        empty recycle bin (irreversible; --dry-run to preview)
  subtask <add|check|uncheck|rm|move> <task> [n|text]   subtask management (move: subtask move <task> <n> up|down|top|bottom|to <m>)
  attachment add <task> <file...>   attach files to a task (50MB max, ext whitelist; images vs files auto-sorted)
  attachment list <task>            list a task's attachments
  attachment rm <task> img|file <n> remove the n-th attachment (n from attachment list)
  repeat on <task> [--type daily|weekly|monthly|yearly] [--interval N] [--weekdays 1,3,5] [--monthday D] [--count N] [--skip-weekends] [--skip-holidays]
  repeat off <task> [--all]        leave repeat group (--all also removes future instances); repeat rule <task> to inspect
  tomato status                          tomato status (running?/seconds left/attached task/today count)
  events import --file <events.json>   rebuild a schedule from a structured event JSON array (idempotent; each event = task + backdated done + linked focus record)
  tomato list [--date today|yesterday|YYYY-MM-DD] [<task|keyword>] [--n 30]   query focus records (read-only, works without the App)
  tomato start [--task <taskId|keyword>] [--minutes N]   start focus (can attach a task; errors if App not running)
  tomato stop [--reason text] [--no-record]             stop/give up (records by focused minutes by default, --no-record skips)
  tomato attach <taskId|keyword|--none>    attach/detach tomato task (does not interrupt a running focus)
  tomato backfill <taskId|keyword|--free> [--date today|YYYY-MM-DD] [--minutes 25] [--at HH:mm]
                                  retro-log a focus session to a task/date (manual record, counts into actual pomodoros; works without the App — direct ledger row write)
  tomato record fix <tomatoId|prefix> [--minutes N] [--date D --at HH:mm] [--rest N] [--succeed yes|no] [--task <kw|--free>]
                                  fix an existing focus record (wrong duration/time/task; works without the App)
  tomato record rm <tomatoId|prefix>   delete an erroneous focus record (irrecoverable; tomato list to browse ids; works without the App)
  sync status                    LAN sync status (enabled/listening, peers with online state/pending count/last round, pending pair requests)
  sync pair --host <ip> [--port N] [--timeout S]   initiate two-way pairing with a peer (prints our 6-digit code too; waits for the peer to accept)
  sync pair-respond [--code NNNNNN] [--reject]     accept a pending pair request; with no pending request, pair via the peer's 6-digit code
  sync unpair --device <id>      unpair a peer (rotates the shared secret — every remaining peer must re-pair)
  open   [--dev]                  launch App (brings existing window to front if already running)
  doctor                          environment self-check (data dir/driver/rw scale)
  clean  [--all] [--dry-run] [--yes]   clean regenerable test/dev residue: %TEMP% isolation dirs, tests/.artifacts, .dev-data (--dry-run to preview, --yes to execute; --all also includes the legacy pickdone-backups repo-tree leak; never touches real user data)
  restore-backup [path]           list auto snapshots (userData/backups + legacy pickdone-backups) or validate one and show how to restore (read-only, never touches the DB)

Global options:
  --json   structured output (recommended for AI; write responses include a next suggestions field)
  --limit N  list/search result cap (default 200, max 500, protects context)
Version & updates:
  version                         show CLI/App version (--version / -v also work; --json for structured output)
  update                          check GitHub for a newer release (installing stays in the App's updater)
Skills (AI agent integration):
  skill install                   install the PickDone SKILL.md into the local skill dirs
                                  (~/.zcode, ~/.claude and ~/.cursor skill dirs), so coding
                                  agents discover how to drive this CLI. Re-run after App updates.
  -h       help

Environment:
  TODO_DB_DIR         data directory override, contains todos.db directly. REQUIRED for write
                      commands (add/edit/done/delete/restore/subtask/repeat/events/deps/batch/import/
                      category/tag/view/plan/settings/milestone/attachment/tomato-writes/sync-incl-status/open/purge/sort):
                      without it (or --yes-i-know) they refuse to touch the real user DB
                      (%APPDATA%/pickdone). Read commands (version/list/doctor/restore-backup list) run unlocked.
  TODO_USER_DATA_DIR  main-process isolation var (userData root); used by the CLI when TODO_DB_DIR is unset
  TODO_BACKUP_DIR     backup snapshot directory override (default: <userData>/backups)`

module.exports = HELP
