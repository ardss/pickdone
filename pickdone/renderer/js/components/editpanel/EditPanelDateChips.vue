<template>
  <!-- W21 split (2026-10-30): date chips (today / tomorrow / pick / none) moved verbatim from
       EditPanel.vue. Persistence stays in the host: 'set' modes map to the host's applyDate via
       setDate; the hidden picker is owned HERE (its ref never crosses the boundary) and the picked
       timestamp rides the 'pick' event to the host's onPickDate -> applyDate. -->
  <div class="ep-date-chips">
    <span class="ep-date-chip" role="button" tabindex="0" :class="{on: dateChip===todayLabel}"
          @click="$emit('set', 'today')" @keydown="onChipKey('today', $event)"><app-icon name="sun" :size="12"/>{{ todayLabel }}</span>
    <span class="ep-date-chip" role="button" tabindex="0" :class="{on: dateChip===tomorrowLabel}"
          @click="$emit('set', 'tomorrow')" @keydown="onChipKey('tomorrow', $event)"><app-icon name="calendar" :size="12"/>{{ tomorrowLabel }}</span>
    <span class="ep-date-chip" role="button" tabindex="0" :class="{on: dateChip && dateChip!==todayLabel && dateChip!==tomorrowLabel}"
          @click="openPick" @keydown="onChipKey('pick', $event)"><app-icon name="calendar" :size="12"/>
      {{dateChip && dateChip!==todayLabel && dateChip!==tomorrowLabel ? dateChip : $t('statsJ.EditPanel.pickDate')}}<span v-if="dateChipTime" class="ep-date-chip__time">{{ dateChipTime }}</span> ▾</span>
    <span class="ep-date-chip" role="button" tabindex="0" :class="{on: !dateTs}"
          @click="$emit('set', 'none')" @keydown="onChipKey('none', $event)">{{ $t('statsJ.EditPanel.noDateOption') }}</span>
    <!-- The picker sits outside the chip, avoiding ARIA nesting of an input inside a button -->
    <el-date-picker ref="datePick" size="small" value-format="x" type="date"
                    style="width:0;height:0;border:0;padding:0;position:absolute;opacity:0" class="ep-date-pick"
                    :aria-label="$t('statsJ.EditPanel.pickDateAria')" popper-class="ep-date-popper"
                    :model-value="dateTs||null" @update:model-value="ts=>$emit('pick', ts||0)"/>
  </div>
</template>

<script lang="ts">
import { dayjs, FMT } from '../../utils/core.js'
import { dayShift } from '../../utils/todayBounds.js'
import { $elOf } from '../../utils/el.js'
import { roleButtonActivate } from '../../utils/roleButtonKey.js' // [W8] Space+Enter chip activation

export default {
  name: 'EpDateChips',
  props: {
    dateTs: { type: Number, default: 0 },
    today0: { type: Number, default: 0 }
  },
  emits: ['set', 'pick'],
  computed: {
    todayLabel () { return this.$t('statsJ.EditPanel.today') },
    tomorrowLabel () { return this.$t('statsJ.EditPanel.tomorrow') },
    dateChip () {
      if (!this.dateTs) return ''
      const d = dayjs(this.dateTs).startOf('day').valueOf()
      if (d === this.today0) return this.todayLabel
      if (d === dayShift(this.today0, 1)) return this.tomorrowLabel
      return dayjs(this.dateTs).format(FMT.cnDate)
    },
    dateChipTime () { const d = this.dateTs ? dayjs(this.dateTs) : null; return d && (d.hour() || d.minute()) ? d.format(FMT.time) : '' } // UX walk 2026-10-12: echo the clock time NL quick-add stored
  },
  mounted () {
    // The hidden date picker input stays out of the Tab focus chain (programmatic "pick a date" only)
    this.$nextTick(() => {
      const pickEl = $elOf(this.$refs.datePick)
      const inp = pickEl && pickEl.querySelector('input')
      if (inp) inp.setAttribute('tabindex', '-1')
    })
  },
  methods: {
    /* [d23 contract] the host keeps its onDateChipKey anchor; chips own their key handling here */
    onChipKey (which, e) {
      if (which === 'pick') return roleButtonActivate(function () { this.openPick() }).call(this, e)
      roleButtonActivate(function () { this.$emit('set', which) }).call(this, e)
    },
    /* focus() invokes the calendar panel (simulating a click on the 0-size hidden input is flaky), plus one extra click as a fallback */
    openPick () {
      const p = this.$refs.datePick
      if (!p) return
      if (p.focus) p.focus()
      const pickEl = $elOf(p)
      const inp = pickEl && pickEl.querySelector('input')
      if (inp) inp.click()
    }
  }
}
</script>
