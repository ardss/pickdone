<template>

  <div class="modal-container" @click.self="close">
    <div class="modal-tablecloth" @click.self="close">
      <div class="modal" role="dialog" aria-modal="true" :aria-label="$t('statsD.RepeatDeleteModal.confirmAria')" style="width:440px;max-height:100%" @keydown.esc="close">
        <div class="modal__header"><span>{{ $t('statsD.RepeatDeleteModal.title') }}</span><button type="button" class="modal__close close-x" :aria-label="$t('statsD.RepeatDeleteModal.close')" @click="close"></button></div>
        <div class="modal__body">
          <div class="rd-body" v-if="base">
            <p>{{ $t('statsD.RepeatDeleteModal.groupInfo', { c: base.taskContent }) }}</p>
            <p class="hint">{{ $t('statsD.RepeatDeleteModal.chooseScope') }}</p>
            <el-radio-group v-model="mode" class="rd-vertical">
              <el-radio value="this">{{ $t('statsD.RepeatDeleteModal.onlyThis') }}</el-radio>
              <el-radio value="from">{{ $t('statsD.RepeatDeleteModal.thisAndAfter') }}</el-radio>
              <el-radio value="all">{{ $t('statsD.RepeatDeleteModal.allEvents') }}</el-radio>
            </el-radio-group>
          </div>
          <div v-else class="rd-body"><p>{{ $t('statsD.RepeatDeleteModal.notFound') }}</p></div>
        </div>
        <div class="modal__footer">
          <el-button size="small" @click="close">{{ $t('statsD.RepeatDeleteModal.cancel') }}</el-button>
          <el-button size="small" type="danger" @click="confirm">{{ $t('statsD.RepeatDeleteModal.delete') }}</el-button>
        </div>
      </div>
    </div>
  </div>
</template>

<script lang="ts">
/** Recurring task delete confirmation -- three scopes (this event only / this event and after / entire group) */
import dialogA11y from '../utils/dialogA11y.js'
import { cleanupOrphanRepeatRule } from '../utils/repeat.js'

export default {
  name: 'RepeatDeleteModal',
  mixins: [dialogA11y],
  data () { return { mode: 'this' } },
  computed: {
    base () {
      const id = this.$store.state.ui.showRepeatDeleteConfirm
      return this.$store.state.todo.todoList.find(t => t.taskId === id) ||
             this.$store.state.todo.recycleList.find(t => t.taskId === id) || null
    }
  },
  methods: {
    async confirm () {
      const b = this.base
      if (!b) return this.close()
      let group
      try { group = await window.todoAPI.dbCall('queryTodos', { deleted: 0, repeatId: b.repeatId }) } catch (e) { console.error('[repeat] query failed:', e); return }
      const ids = []
      if (this.mode === 'all') {
        group.forEach(t => ids.push(t.taskId))
      } else if (this.mode === 'from') {
        group.forEach(t => { if (t.dayStart >= b.dayStart) ids.push(t.taskId) })
      } else {
        await this.$store.dispatch('todo/updateTodoFields', { taskId: b.taskId, patch: { repeatId: null, status: 'update' } })
        await this.cleanupOrphanRule(b.repeatId) // "this event only" must also check for orphan rules (after deleting the last instance in a group, the rule once lingered forever)
        return this.close()
      }
      // F-C1: batch delete — ONE snapshot push (one undo restores the whole group), ONE computeViews,
      // ONE putMany write (the per-row loop used to push a whole-table snapshot per instance)
      await this.$store.dispatch('todo/deleteTodosMany', ids.map(id => ({ taskId: id })))
      // Batch delete shares the single-item semantics: 5s undo toast; the single pre-batch snapshot guarantees one undo restores the whole group
      if (this.$message && window.Vue) {
        const undo = () => this.$store.dispatch('todo/undo').then(() => this.$message.closeAll())
        this.$message({
          type: 'success', duration: 5000,
          message: this.$createElement('span', [
            this.$t('statsJ.Confirm.deleted') + '　',
            this.$createElement('a', { style: { color: 'var(--brand)', cursor: 'pointer' }, onClick: undo }, this.$t('statsJ.Confirm.undo'))
          ])
        })
      }
      // Clean up the orphan rule (meta + localStorage) when no active instances remain in the group, preventing unbounded accumulation
      await this.cleanupOrphanRule(b.repeatId)
      this.close()
    },
    /** Clean up the repeat rule when no active instances remain in the group (meta + localStorage), preventing unbounded accumulation.
     *  U-2: implementation extracted to utils/repeat.js so the bare-string deleteMeta contract is unit-testable. */
    async cleanupOrphanRule (rid) {
      return cleanupOrphanRepeatRule(rid)
    },
    close () { this.$store.commit('ui/askRepeatDelete', null) }
  },

}
</script>
