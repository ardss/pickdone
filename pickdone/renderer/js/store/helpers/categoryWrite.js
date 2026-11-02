// [w29 P2 / size split] updateCategory mutation body, extracted from store/category.js so the
// awaited ACTION can return the persist boolean (Vuex commit()/context.commit() both swallow
// mutation return values). Pure move — deps injected, same coded-error contract:
// returns persist()'s Promise<boolean> (true = SQLite write confirmed); throws coded
// CATEGORY_EXISTS / CATEGORY_* on invalid patches.
import { normKey } from '../../../../shared/norm-key.mjs'
import { validateCategoryStructure } from '../../../../shared/category-structure.mjs'

export function makeDoUpdateCategory ({ persist, stateRowView }) {
  return function doUpdateCategory (state, patch) {
    // Same normKey uniqueness contract as addCategory (updateCategory previously had no name check).
    if ('categoryName' in patch) {
      const newKey = normKey(patch.categoryName)
      const clash = state.list.some(c => !c.delete && c.categoryId !== patch.categoryId && normKey(c.categoryName) === newKey)
      if (clash) {
        const e = new Error('category "' + patch.categoryName + '" already exists (names must stay unique so the CLI can address them)')
        e.code = 'CATEGORY_EXISTS'
        throw e
      }
    }
    const i = state.list.findIndex(c => c.categoryId === patch.categoryId)
    // F4: validate folderId/folderIs patches against the resulting row BEFORE mutating or
    // persisting — coded errors (CATEGORY_NOT_FOLDER/_NOT_FOUND/_NESTED_FOLDER/_CYCLE), list untouched.
    if (i >= 0 && ('folderId' in patch || 'folderIs' in patch)) {
      const target = { ...state.list[i], ...patch }
      const guard = validateCategoryStructure(
        { id: target.categoryId, isFolder: !!target.folderIs, parentId: target.folderId },
        stateRowView(state.list))
      if (guard) { const e = new Error(guard.message); e.code = guard.code; throw e }
    }
    if (i >= 0) { state.list[i] = { ...state.list[i], ...patch }; return persist(state.list) }
    return Promise.resolve(true)
  }
}
