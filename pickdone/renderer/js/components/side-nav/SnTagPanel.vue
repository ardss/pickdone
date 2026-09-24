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
import { navKeyOfRoute } from '../../views/registry.js'

export default defineComponent({
  name: 'SnTagPanel',
  computed: {
    /* Wave-5 dedup: single source is getters['todo/tagCounts'] (was a verbatim copy of SideNav's) */
    tags () { return this.$store.getters['todo/tagCounts'] }
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
