<template>

  <div class="view-page search-page">
    <div class="title">
      <div class="title__prepend">
        <!-- reference: MainNavSearch-isomorphic keyword input -->
        <div class="main-nav-search">
          <div class="main-nav-search__icon"></div>
          <input ref="inp" v-model="q" spellcheck="false" autocomplete="off" :aria-label="$t('statsC.Search.searchAria')"
                 class="main-nav-search__input" type="text" :placeholder="$t('statsC.Search.searchPlaceholder')"/>
          <div v-if="q.trim()!==''" class="main-nav-search__clear close-x close-x--sm" role="button" tabindex="0" :aria-label="$t('statsC.Search.clearAria')" @click="q=''" @keydown.enter.prevent="q=''"></div>
        </div>
        <!-- filters (correspond to the project baseline's three dropdown-selects) -->
        <el-select size="small" class="search-filter-el" style="width:110px"
                   :model-value="settings.searchDateRange" :placeholder="$t('statsC.Search.dateRangeLabel')"
                   @change="v=>patch('searchDateRange',v||'')">
          <el-option v-for="o in dateRangeOptions" :key="o.value||'all-date'" :label="o.label" :value="o.value"/>
        </el-select>
        <el-select size="small" class="search-filter-el" style="width:120px"
                   :model-value="settings.searchCategory" :placeholder="$t('statsC.Search.allCats')"
                   @change="v=>patch('searchCategory',String(v||''))">
          <el-option v-for="o in cats" :key="o.value||'all-cat'" :label="o.label" :value="o.value"/>
        </el-select>
        <el-select size="small" class="search-filter-el" style="width:100px"
                   :model-value="settings.searchComplete" :placeholder="$t('statsC.Search.statusLabel')"
                   @change="v=>patch('searchComplete',v||'')">
          <el-option v-for="o in completeOptions" :key="o.value||'all-done'" :label="o.label" :value="o.value"/>
        </el-select>
        <el-button type="text" size="small" @click="resetFilter">{{ $t('statsC.Search.resetFilter') }}</el-button>
      </div>
      <span class="result-count">{{ $t('statsC.Search.resultCount', { n: matched.length }) }}</span>
    </div>

    <div class="result-list" :class="{empty:!results.length&&!q}">
      <transition-group name="listfade" tag="div">
        <todo-item v-for="t in results" :key="t.taskId" :todo="t" :query="q" show-date-badge/>
      </transition-group>

      <!-- Render cap is 200 for DOM cost; the count chip above shows the total, this row makes the truncation explicit -->
      <div v-if="matched.length > results.length" class="search-truncated" role="note">
        {{ $t('statsE.SearchView.truncatedNotice', { shown: results.length, n: matched.length }) }}
      </div>

      <!-- reference: todo-list-empty structure -->
      <empty-state v-if="!results.length" inline><template #text>{{ q ? $t('statsC.Search.notFound', { q: esc(q) }) : $t('statsC.Search.empty') }}</template></empty-state>
    </div>
  </div>
</template>

<script lang="ts">
/**
 * Global search —— aligned with the project baseline search results page (todo-list-search):
 *   todo-page-layout top slot: div.title > div.title__prepend
 *     |- keyword input (isomorphic to the project baseline sidebar MainNavSearch: .main-nav-search/__icon/__input/__clear)
 *     |- filter dropdowns x3 (date range / all categories / completion status, written into settings.searchDateRange etc.)
 *     `- reset filters (el-button text mini)
 *   default slot: todo-list > transition-group(todo-swap) > todo-list-item(show-todo-date)
 *             empty -> todo-list-empty (.empty/.empty__icon/.empty__text)
 * Search logic keeps this implementation's matchTodo (pinyin/fuzzy) and sorts by todoTime descending per the project baseline.
 */
import { matchTodo, highlightHTML, escapeHtml } from '../utils/search.js'
import { dayjs } from '../utils/core.js'
import TodoItem from '../components/TodoItem.vue'
import EmptyState from '../components/EmptyState.vue'

// Option value is the persisted stable key (previously persisted Chinese words were used as enum values, which mismatched every logic branch under an English UI — audit S1 fix);
// label stores an i18n key resolved via $t at render time
const DATE_RANGE_OPTIONS = [
  { value: '', labelKey: 'statsC.Search.dateRangeLabel' },
  { value: 'last7', labelKey: 'statsC.Search.last7' },
  { value: 'last30', labelKey: 'statsC.Search.last30' },
  { value: 'halfYear', labelKey: 'statsC.Search.halfYear' },
  { value: 'year', labelKey: 'statsC.Search.year' }
]
const COMPLETE_OPTIONS = [
  { value: '', labelKey: 'statsC.Search.statusLabel' },
  { value: 'done', labelKey: 'statsC.Search.done' },
  { value: 'undone', labelKey: 'statsC.Search.undone' }
]
// One-time normalization map: legacy persisted values (Chinese words) → stable keys
const LEGACY_VALUE_MAP = {
  '最近7天': 'last7', '最近30天': 'last30', '最近半年': 'halfYear', '最近一年': 'year',
  '已完成': 'done', '未完成': 'undone'
}

export default {
  name: 'SearchView',
  components: { TodoItem, EmptyState },
  data () {
    return {}
  },
  created () {
    // Normalize legacy persisted Chinese values into stable keys (Chinese enums once mismatched every filter branch under an English UI)
    const st = this.settings
    const patch = {}
    for (const [key, legacy] of [['searchDateRange', st.searchDateRange], ['searchComplete', st.searchComplete]]) {
      if (legacy && LEGACY_VALUE_MAP[legacy]) patch[key] = LEGACY_VALUE_MAP[legacy]
    }
    if (Object.keys(patch).length) this.$store.commit('settings/updateSettings', patch)
  },
  computed: {
    dateRangeOptions () { return DATE_RANGE_OPTIONS.map(o => ({ ...o, label: this.$t(o.labelKey) })) },
    completeOptions () { return COMPLETE_OPTIONS.map(o => ({ ...o, label: this.$t(o.labelKey) })) },
    q: {
      get () { return this.$store.state.todo.search || '' },
      set (v) { this.$store.commit('todo/setSearch', v) }
    },
    settings () { return this.$store.state.settings },
    cats () {
      return [{ value: '', label: this.$t('statsC.Search.allCats') }]
        .concat(this.$store.state.category.list.filter(c => !c.delete)
          .map(c => ({ value: String(c.categoryId), label: c.categoryName })))
    },
    matched () {
      const pool = [...this.$store.state.todo.todoList]
      const st = this.settings
      const range = st.searchDateRange
      // Range semantics aligned with the reference searchResultList getter
      let fromTs = null; let toTs = null
      const today = +dayjs().startOf('day')
      switch (range) {
        case 'last7': fromTs = +dayjs(today).subtract(7, 'days').startOf('day'); toTs = +dayjs(today).endOf('day'); break
        case 'last30': fromTs = +dayjs(today).subtract(30, 'days').startOf('day'); toTs = +dayjs(today).endOf('day'); break
        case 'halfYear': fromTs = +dayjs(today).subtract(180, 'days').startOf('day'); toTs = +dayjs(today).endOf('day'); break
        case 'year': fromTs = +dayjs(today).subtract(365, 'days').startOf('day'); toTs = +dayjs(today).endOf('day'); break
        default: break
      }
      const list = pool.filter(t => {
        if (!matchTodo(t, this.q)) return false
        if (st.searchComplete === 'undone' && t.complete) return false
        if (st.searchComplete === 'done' && !t.complete) return false
        if (st.searchCategory && String(st.searchCategory) !== '' && String(t.categoryId) !== String(st.searchCategory)) return false
        if (fromTs !== null) {
          const ds = t.dayStart || t.todoTime || 0
          if (!ds || ds < fromTs || ds > toTs) return false
        }
        return true
      })
      if (this.q.trim()) list.sort((a, b) => b.todoTime - a.todoTime) // reference: sort((a,b)=>b.todoTime-a.todoTime)
      return list
    },
    // Render list is capped at 200 for DOM cost, but the count reflects the real total
    results () { return this.matched.slice(0, 200) },
  },
  mounted () { this.$refs.inp && this.$refs.inp.focus() },
  methods: {
    hl (t) { return highlightHTML(t, this.q) },
    esc (s) { return escapeHtml(s) },
    resetFilter () { // reference resetFilter: zero out the three options then re-search
      this.$store.commit('settings/updateSettings', { searchCategory: '', searchComplete: '', searchDateRange: '' })
    },
    patch (k, v) { this.$store.commit('settings/updateSettings', { [k]: v }) }
  },

}
</script>
<style>.result-count{color:var(--text-3);font-size: var(--fs-sm);line-height:28px;white-space:nowrap}
.search-truncated{color:var(--text-3);font-size: var(--fs-sm);line-height:32px;text-align:center;padding:6px 0}
</style>
