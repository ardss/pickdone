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
  <!-- [R12] overflow indicator: tags past the 10-row cap used to be silently invisible — the panel
       rendered exactly 10 rows with no hint that more exist. The +N row hands the intent to the
       parent (SideNav opens the manage-tags modal, which lists every tag). Label reuses the
       existing SideNav shard key (shard contract: side-nav keys stay in statsG.SideNav). -->
  <div v-if="tags.length > 10" class="sn-cat-item sn-tags-more" role="button" tabindex="0"
       :title="$t('statsG.SideNav.manageTagTitle')" :aria-label="$t('statsG.SideNav.manageTagTitle') + ' (+' + (tags.length - 10) + ')'"
       @click="$emit('more')" @keydown.enter.prevent="$emit('more')">
    <span class="sn-tags-more-label">+{{ tags.length - 10 }}</span>
  </div>
</template>

<script lang="ts">
import { defineComponent } from 'vue'
import { navKeyOfRoute } from '../../views/registry.js'

export default defineComponent({
  name: 'SnTagPanel',
  emits: ['more'],
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
