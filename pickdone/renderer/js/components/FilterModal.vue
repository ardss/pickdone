<template>

  <div class="modal-container" @click.self="close">
    <div class="modal-tablecloth" @click.self="close">
      <div class="modal" role="dialog" aria-modal="true" :aria-label="$t('statsJ.FilterModal.aria')" style="width:420px" @keydown.esc="close">
        <div class="modal__header"><span>{{ filter ? $t('statsJ.FilterModal.editTitle') : $t('statsJ.FilterModal.newTitle') }}</span><button type="button" class="modal__close close-x" :aria-label="$t('statsD.RepeatModal.close')" @click="close"></button></div>
        <div class="modal__body">
          <div class="rm-row">
            <span class="rl">{{ $t('statsJ.FilterModal.name') }}</span>
            <el-input v-model="name" size="small" style="width:240px" :placeholder="$t('statsJ.FilterModal.namePh')" maxlength="30" @keyup.enter="save"/>
          </div>
          <div class="rm-row">
            <span class="rl">{{ $t('statsJ.FilterModal.cat') }}</span>
            <el-select v-model="catId" size="small" style="width:240px">
              <el-option :label="$t('statsJ.FilterModal.anyCat')" :value="-1"/>
              <el-option v-for="c in cats" :key="c.categoryId" :label="c.categoryName" :value="c.categoryId"/>
            </el-select>
          </div>
          <div class="rm-row">
            <span class="rl">{{ $t('statsJ.FilterModal.prio') }}</span>
            <el-select v-model="priority" size="small" style="width:240px">
              <el-option :label="$t('statsJ.FilterModal.anyPrio')" :value="-1"/>
              <el-option :label="$t('statsJ.FilterView.prioNone')" :value="0"/>
              <el-option label="★" :value="1"/>
              <el-option label="★★" :value="2"/>
            </el-select>
          </div>
          <div class="rm-row">
            <span class="rl">{{ $t('statsJ.FilterModal.date') }}</span>
            <el-select v-model="dateMode" size="small" style="width:240px">
              <el-option v-for="m in dateModes" :key="m.v" :label="m.l" :value="m.v"/>
            </el-select>
          </div>
        </div>
        <div class="modal__footer">
          <el-button size="small" @click="close">{{ $t('statsD.RepeatModal.cancel') }}</el-button>
          <el-button size="small" type="primary" @click="save">{{ $t('statsJ.FilterModal.save') }}</el-button>
        </div>
      </div>
    </div>
  </div>
</template>

<script lang="ts">
/** Filter create/edit modal -- name + conditions (category/priority/date range); saving goes through filters/save */
import dialogA11y from '../utils/dialogA11y.js'

export default {
  name: 'FilterModal',
  mixins: [dialogA11y],
  props: { filter: { type: Object, default: null } },
  data () {
    const c = (this.filter && this.filter.conds) || {}
    return {
      name: (this.filter && this.filter.name) || '',
      catId: c.catId != null ? c.catId : -1,
      priority: c.priority != null ? c.priority : -1,
      dateMode: c.dateMode || 'all'
    }
  },
  computed: {
    cats () { return this.$store.state.category.list.filter(c => !c.delete) },
    dateModes () {
      return ['all', 'today', 'week', 'overdue', 'none'].map(m => ({ v: m, l: this.$t('statsJ.FilterView.dm_' + m) }))
    }
  },
  methods: {
    async save () {
      const name = String(this.name || '').trim()
      if (!name) { this.$message.warning(this.$t('statsJ.FilterModal.nameRequired')); return }
      const id = await this.$store.dispatch('filters/save', {
        id: this.filter && this.filter.id,
        name,
        conds: { catId: this.catId, priority: this.priority, dateMode: this.dateMode },
        sort: (this.filter && this.filter.sort) || 0
      })
      this.$message.success(this.$t('statsJ.FilterModal.saved'))
      this.$emit('saved', id)
    },
    close () { this.$emit('close') }
  },

}
</script>
