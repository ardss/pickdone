// i18n 分片（Batch K：反馈弹窗 + 放弃专注弹窗）
export default {
  statsK: {
    TomatoAccount: {
      addHint: '手动补录一条专注记录：填开始时间与时长，保存后计入任务账本',
      title: '番茄账 · {name}',
      close: '关闭',
      sumLine: '实际收成 {n} 个番茄 = 下列记录的合计；点击任一条可修正时间或删除',
      emptyTitle: '还没有入账记录',
      emptyDesc: '开始一次专注，或在下方补录一条，都会记进这本账',
      manual: '手动补录',
      givenUp: '已放弃',
      minUnit: ' 分钟',
      start: '开始',
      focusMin: '专注 (分钟)',
      restMin: '休息 (分钟)',
      save: '保存',
      delete: '删除记录',
      deleteConfirm: '删除这条专注记录？实际收成会随之减少。',
      deleted: '记录已删除',
      saved: '记录已更新',
      addBtn: '+ 补一条番茄',
      addSave: '入账',
      cancel: '取消',
      added: '已入账一个番茄'
    },
    TomatoAbandonModal: {
      title: '放弃本次专注？',
      close: '关闭',
      hint: '本次已专注 {min} 分钟，放弃将计入放弃次数（不计入今日收成）。',
      reasonPh: '放弃原因（可选，如：被临时会议打断）',
      continue: '继续专注',
      giveUp: '放弃',
      k125: '已放弃专注',
      reasonSuffix: '，原因：{r}'
    }
  }
}
