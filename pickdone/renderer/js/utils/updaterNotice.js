/** Display an optional update as a choice, not a silent install. */
export function createUpdateChoiceToast ({ h, notify, translate, openSettings }) {
  if (typeof h !== 'function' || typeof notify !== 'function') throw new Error('update notice renderer unavailable')
  return (type, message) => notify({
    type,
    duration: 12000,
    showClose: true,
    message: h('span', {}, [
      message, ' ',
      h('button', { type: 'button', class: 'mini', onClick: openSettings }, translate('update.viewUpdate'))
    ])
  })
}
