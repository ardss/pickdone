/**
 * W21 split (2026-10-30): EpReminders emit handlers pulled out of EditPanel.vue.
 * The task snapshot (this.e), the past-reminder toast and the save pipeline stay in the host;
 * only the three commit/clear/offsets bodies move here (verbatim, `vm`-taking — same convention
 * as edit-panel/repeat.js). The task-watcher close-verify timer stays in the host
 * (store-sync-echo-round anchors the taskAbsentIn guard on EditPanel.vue itself).
 */
import { dayjs } from '../../utils/core.js'

/* ===== Reminders: EpReminders emits; the task snapshot + persistence stay in the host ===== */
export function onRemindersCommit (vm, mainTs, extras) {
  if (!vm.e) return
  const mainChanged = mainTs !== vm.e.remindTs
  vm.e.remindTs = mainTs
  vm.e.reminderExtra = extras
  if (mainChanged && mainTs < Date.now()) vm.$message.warning(vm.$t('statsJ.EditPanel.reminderPastTip'))
  if (!vm.e.dateTs) vm.e.dateTs = dayjs(mainTs).startOf('day').valueOf()
  vm.queueSave({ reminderTime: vm.e.remindTs, reminderExtra: vm.e.reminderExtra, todoTime: vm.e.dateTs })
}

export function onRemindersClear (vm) {
  if (!vm.e) return
  vm.e.remindTs = 0
  vm.e.reminderExtra = []
  vm.e.reminderOffsets = [] // offsets are anchored to the main reminder; clearing the main reminder must clear them too, otherwise stale offsets silently revive when reminders are re-set
  vm.queueSave({ reminderTime: 0, reminderExtra: [], reminderOffsets: [] })
}

export function onRemindersOffsets (vm, sorted) {
  if (!vm.e) return
  vm.e.reminderOffsets = sorted
  vm.queueSave({ reminderOffsets: sorted })
}
