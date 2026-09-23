/** Single source of truth for the DEFAULT (factory) shortcut map.
 *  P2-3 (maint/dw wave 2026-09-23): the renderer's "restore defaults" button used to carry a
 *  hand-copied literal that drifted from the main process's factory table (config-store.js) by
 *  5 keys — reset+save silently enabled 1 OS-level global hotkey (ctrl+alt+t) and 4 in-app
 *  shortcuts the factory ships empty. Both sides now read this module; a parity test pins them.
 *  quickAddGlobal: the old default ctrl+shift+a collided with WeChat/QQ screenshot hotkeys in
 *  CN environments (registration always failed), moved to alt+shift+t on 2026-09-05 (T = Todo). */
export const DEFAULT_SHORTCUTS = {
  sync: 'ctrl+s', toggleMainWindow: '', quickAddGlobal: 'alt+shift+t', addEvent: 'ctrl+n', deleteEvent: 'ctrl+d',
  pinEvent: '', unpinEvent: '', toggleAllSubtasks: '', startPomodoro: '',
  switchToDaytodo: 'ctrl+1', switchToRecentTodos: 'ctrl+2', switchToSchedule: 'ctrl+3', switchToInbox: 'ctrl+4'
}
