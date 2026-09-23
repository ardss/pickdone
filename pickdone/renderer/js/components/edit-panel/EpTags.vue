<template>
  <!-- Hash-tag row, extracted verbatim from EditPanel.vue (maint/dw-wave2 domain-2 split).
       Tags are a virtual derivation from #xxx in the title; the input buffer + IME guard live here,
       add/remove intents are emitted to the parent which rewrites the title through its save pipeline. -->
  <div class="ep-row ep-tags-row">
    <span class="ep-field-label ep-field-ico" :title="$t('statsJ.EditPanel.tagsPlaceholder')"><b class="ep-hash">#</b></span>
    <span v-for="t in tags" :key="t" class="ep-tag-chip">
      #{{ t }}
      <span class="ep-tag-x close-x" role="button" tabindex="0" :title="$t('statsJ.EditPanel.removePrefix') + t" :aria-label="$t('statsJ.EditPanel.removeTag', { t: t })"
            @click.stop="$emit('remove', t)" @keydown.enter.prevent.stop="$emit('remove', t)"></span>
    </span>
    <input class="ep-tag-input" v-model="tagInput" :placeholder="$t('statsJ.EditPanel.addTagHint')" :aria-label="$t('statsJ.EditPanel.addTag')"
           @keydown.enter.prevent="onTagEnter" @blur="addTag"/>
  </div>
</template>

<script lang="ts">
import type { PropType } from 'vue'
/** Hash-tag chips + add-input row; the parent owns the title rewrite (addTag/removeTag). */
export default {
  name: 'EpTags',
  props: {
    /** derived tag names (parent computed taskTags via extractTags(e.title)) */
    tags: { type: Array as PropType<string[]>, default: () => [] }
  },
  emits: ['add', 'remove'],
  data () {
    return {
      tagInput: ''
    }
  },
  methods: {
    // IME guard: the Enter that commits a composition (keyCode 229) must not add a half-typed tag
    onTagEnter (e) {
      if (e.isComposing || e.keyCode === 229) return
      this.addTag()
    },
    addTag () {
      const name = (this.tagInput || '').trim().replace(/^#+/, '')
      this.tagInput = ''
      if (!name || this.tags.includes(name)) return
      this.$emit('add', name)
    }
  }
}
</script>
