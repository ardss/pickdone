<template>
  <!-- Extracted verbatim from SideNav.vue (2026-09-12 split, zero behavior change): the expandable
       tag list section body; tags are derived live from todoList #tags + ui/userTags placeholders -->
  <!-- Multi-root fragment on purpose: the rows stay direct children of the .sn-section.sn-tags
       container in the parent, byte-identical DOM to the pre-split markup -->
  <div v-for="t in tags.slice(0,10)" :key="t.name" class="sn-cat-item" role="link" tabindex="0"
       :class="{active:$route.params&&$route.params.id===t.name}"
       @click="go('todo-list-tag',{id:t.name})"
       @keydown.enter.prevent="go('todo-list-tag',{id:t.name})">
    <span class="sn-dot none"></span><span>{{t.name}}</span><em class="sn-badge">{{t.count}}</em>
  </div>
</template>

<script lang="ts">
import { defineComponent } from 'vue'
import { extractTags } from '../../utils/search.js'
import { navKeyOfRoute } from '../../views/registry.js'

export default defineComponent({
  name: 'SnTagPanel',
  computed: {
    /* Same derivation as the SideNav copy (kept there for createTag's duplicate check) */
    tags () {
      const set = new Map()
      for (const t of [...this.$store.state.todo.todoList]) {
        for (const tag of extractTags(t.taskContent, t.taskDescribe)) {
          set.set(tag, (set.get(tag) || 0) + 1)
        }
      }
      // Empty tags created via "New Tag" also enter the list (count 0), otherwise they disappear right after creation
      for (const name of this.$store.state.ui.userTags) {
        if (!set.has(name)) set.set(name, 0)
      }
      return [...set.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count)
    }
  },
  methods: {
    /* Same navigation contract as SideNav.go(): push the route, then sync the nav key for the highlight */
    go (name: string, params?: any) {
      this.$router.push({ name, params }).catch(() => {})
      this.$store.commit('ui/setNav', navKeyOfRoute(name) || ('category:' + (params && params.id)))
    }
  }
})
</script>
