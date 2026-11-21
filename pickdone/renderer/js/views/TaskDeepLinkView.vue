<template>
  <div class="task-deeplink-view">
    <p v-if="missing" class="task-deeplink-empty">{{ $t('statsA.TaskDeepLink.notFound') }}</p>
  </div>
</template>
<script lang="ts">
/** S6 deep link landing: #/todo-list/task/:id — one hash route shared by the desktop and
 *  web builds (the VS Code extension builds this exact URL). Opens the task's edit panel
 *  through the SAME ui/openEdit mutation a list-row click uses — no parallel data path.
 *  The row is read via the SAME read op the list views use (queryTodos, deleted:0) instead
 *  of a store list slice: an inbox/unscheduled capture must deep-link as well as a today
 *  task, and the route can be hit before any view has populated a slice. */
export default {
  name: 'TaskDeepLinkView',
  data () { return { missing: false } },
  mounted () { this.open() },
  methods: {
    async open () {
      const id = String(this.$route.params.id || '')
      for (let i = 0; i < 10 && !this.missing; i++) {
        let rows = []
        try { rows = await window.todoAPI.dbCall('queryTodos', { deleted: 0 }) || [] } catch { rows = [] }
        const t = rows.find(x => x.taskId === id)
        if (t) {
          this.$store.commit('ui/openEdit', t)
          this.$router.replace('/todo-list/today')
          return
        }
        await new Promise(r => setTimeout(r, 500))
      }
      this.missing = true
    }
  }
}
</script>
