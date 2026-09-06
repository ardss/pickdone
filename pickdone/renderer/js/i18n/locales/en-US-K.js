// i18n slice (Batch K: feedback modal + abandon focus modal)
export default {
  statsK: {
    TomatoAccount: {
      addHint: 'Log one focus session manually: set start time and duration; it counts toward the task ledger',
      title: 'Pomodoro account · {name}',
      close: 'Close',
      sumLine: 'Actual {n} pomodoros = the sum of the records below; click one to correct or delete',
      emptyTitle: 'No records yet',
      emptyDesc: 'Start a focus session or log one below — it all lands in this account',
      manual: 'manual',
      givenUp: 'given up',
      minUnit: ' min',
      start: 'Start',
      focusMin: 'Focus (min)',
      restMin: 'Break (min)',
      save: 'Save',
      delete: 'Delete record',
      deleteConfirm: 'Delete this focus record? Actual pomodoros will decrease accordingly.',
      deleted: 'Record deleted',
      saved: 'Record updated',
      addBtn: '+ Log a pomodoro',
      addSave: 'Add',
      cancel: 'Cancel',
      added: 'Pomodoro logged'
    },
    TomatoAbandonModal: {
      title: 'Give up this focus session?',
      close: 'Close',
      hint: 'Focused for {min} minutes. Giving up counts toward abandon stats (not today\'s harvest).',
      reasonPh: 'Reason (optional, e.g. interrupted by a meeting)',
      continue: 'Keep focusing',
      giveUp: 'Give up',
      k125: 'Focus abandoned',
      reasonSuffix: ', reason: {r}'
    }
  }
}
