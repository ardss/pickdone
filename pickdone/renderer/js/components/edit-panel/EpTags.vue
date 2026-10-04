<template>
  <!-- Hash-tag row, extracted verbatim from EditPanel.vue (maint/dw-wave2 domain-2 split).
       Tags are a virtual derivation from #xxx in the title; the input buffer + IME guard live here,
       add/remove intents are emitted to the parent which rewrites the title through its save pipeline. -->
  <div class="ep-row ep-tags-row">
    <span class="ep-field-label ep-field-ico" :title="$t('statsJ.EditPanel.tagsPlaceholder')"><b class="ep-hash">#</b></span>
    <span v-for="t in tags" :key="t" class="ep-tag-chip">
      #{{ t }}
      <span class="ep-tag-x close-x" role="button" tabindex="0" :title="$t('statsJ.EditPanel.removePrefix') + t" :aria-label="$t('statsJ.EditPanel.removeTag', { t: t })"
            @click.stop="$emit('remove', t)" @keydown="onRemoveKey(t, $event)"></span>
    </span>
    <!-- [R15] Enter-only commit: @blur used to fire addTag on click-away, silently rewriting the
         task title mid-drag / mid-IME. The IME guard lives in onTagEnter (keydown sees the 229 flag). -->
    <input class="ep-tag-input" v-model="tagInput" :placeholder="$t('statsJ.EditPanel.addTagHint')" :aria-label="$t('statsJ.EditPanel.addTag')"
           @keydown.enter.prevent="onTagEnter"/>
  </div>
</template>

<script lang="ts">
import type { PropType } from 'vue'
import { roleButtonActivate } from '../../utils/roleButtonKey.js' // [A9] Space+Enter button activation
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
    /* [D17-DOM4] ARIA button pattern on the tag-remove chip: Space joins Enter (was Enter-only) */
    onRemoveKey (t, e) {
      roleButtonActivate(() => { this.$emit('remove', t) }, { stop: true }).call(this, e)
    },
    // IME guard: the Enter that commits a composition (keyCode 229) must not add a half-typed tag
    onTagEnter (e) {
      if (e.isComposing || e.keyCode === 229) return
      this.addTag()
    },
    addTag () {
      const name = (this.tagInput || '').trim().replace(/^#+/, '')
      this.tagInput = ''
      if (!name) return
      // [D15-A9] a duplicate tag used to die as a silent no-op AFTER the input was cleared — the
      // user's entry just vanished. Say why nothing was added instead.
      if (this.tags.includes(name)) {
        try { this.$message.warning(this.$t('statsJ.EditPanel.tagExists', { name })) } catch { /* toast is best-effort */ }
        return
      }
      this.$emit('add', name)
    }
  }
}
</script>
