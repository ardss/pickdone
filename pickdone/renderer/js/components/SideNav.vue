<template>

  <aside class="side-nav" :class="{'side-nav--collapsed': collapsed}">
    <div class="sn-fixed">
    <div class="sn-brand" role="button" tabindex="0" :title="collapsed ? $t('statsG.SideNav.expandSidebar') : $t('statsG.SideNav.collapseSidebar')" :aria-label="collapsed ? $t('statsG.SideNav.expandSidebar') : $t('statsG.SideNav.collapseSidebar')" @click="toggleCollapse" @keydown.enter.prevent="toggleCollapse">
      <div class="sn-brand__mark"><svg viewBox="0 0 64 64" aria-hidden="true">
  <rect x="13" y="6" width="40" height="30" rx="10" fill="#b5ded9" transform="rotate(-5 33 21)"/>
  <rect x="11" y="19" width="43" height="36" rx="11" fill="#0f9d8f"/>
  <path d="M23 37 L31 45 L43 30" fill="none" stroke="#fff" stroke-width="6.5" stroke-linecap="round" stroke-linejoin="round"/>
</svg></div>
      <div class="sn-brand__text">
        <div class="sn-brand__name">{{ $t('app.name') }}</div>
        <div class="sn-brand__en">PickDone</div>
      </div>
      <div class="sn-collapse-btn" aria-hidden="true">
        <span>{{ collapsed ? '»' : '«' }}</span>
      </div>
    </div>
    <weather-widget class="sn-weather"/>
    <div class="main-nav-search sn-search" :role="collapsed ? 'button' : null"
         :tabindex="collapsed ? 0 : null"
         :aria-label="collapsed ? $t('statsG.SideNav.searchAria') : null"
         :title="collapsed ? $t('statsG.SideNav.searchAria') : ''"
         @click="onSearchClick"
         @keydown.enter.prevent="expandAndFocusSearch">
      <app-icon name="search" :size="14"/>
      <input ref="searchInput" :value="$store.state.todo.search" :placeholder="$t('statsG.SideNav.searchPlaceholder')" spellcheck="false" autocomplete="off"
             :aria-label="$t('statsG.SideNav.searchAria')"
             @input="onSearchInputEvt"
             @keydown.esc.prevent="onSearchEsc"/>
      <div v-if="String($store.state.todo.search||'').trim()" class="main-nav-search__clear close-x close-x--sm" role="button" tabindex="0"
           :aria-label="$t('statsG.SideNav.clearSearchAria')" @click="clearSearch" @keydown.enter.prevent="clearSearch">
      </div>
    </div>

    <nav class="sn-navs">
      <div v-for="n in filteredNavOrder" :key="n" class="sn-nav-item" role="link" tabindex="0" :title="collapsed ? navLabel(n) : ''"
           :class="{active: $route.name===n || (n==='todo-list-projects' && $route.name==='todo-list-project')}"
           :aria-current="$route.name===n ? 'page' : null"
           @click="go(n)" @keydown.enter.prevent="go(n)">
        <img class="sn-nav-ico" :src="NAV_ICON[n]" alt="">
        <span>{{ navLabel(n) }}</span>
        <em v-if="n==='todo-list-todo-box' && todoBoxCount" class="sn-badge">{{todoBoxCount}}</em>
        <em v-if="n==='todo-list-projects' && projectWarn" class="sn-badge warn" :title="$t('statsG.SideNav.projectWarnTip')">{{projectWarn}}</em>
      </div>
    </nav>
    </div>

    <div class="sn-scrollable">
    <div class="sn-section">
      <div class="sn-sec-head sn-sec-foldable"
           @click.stop="catFold=!catFold">
        <button type="button" class="sn-sec-toggle" :aria-expanded="catFold ? 'false' : 'true'" :aria-label="$t('statsG.SideNav.catSectionAria')"
                @click.stop="catFold=!catFold" @keydown.enter.prevent.stop="catFold=!catFold" @keydown.space.prevent.stop="catFold=!catFold"><span>{{ $t('statsG.SideNav.catSection') }}</span></button>
        <span class="sn-sec-tools">
          <button class="sn-ico-btn" :title="$t('statsG.SideNav.newCatTitle')" @click.stop="createCategory"><app-icon name="plus" :size="12"/></button>
          <button class="sn-ico-btn" :title="$t('statsG.SideNav.manageCatTitle')" @click.stop="manageVisible = true"><app-icon name="gear" :size="12"/></button>
          <i class="sn-fold-arrow" :class="{open:!catFold}"><app-icon name="chevron-down" :size="11"/></i>
        </span>
      </div>
      <template v-if="!catFold">
      <div class="sn-cat-item" :class="{active: $route.params && Number($route.params.id) === -1}" role="link" tabindex="0"
           :title="$t('statsG.SideNav.defaultCatTip')"
           @click="go('todo-list-category',{id:-1})" @keydown.enter.prevent="go('todo-list-category',{id:-1})">
        <span class="sn-dot none"></span><span>{{ $t('statsG.SideNav.uncategorized') }}</span>
      </div>
      <template v-for="o in hierarchical" :key="o.categoryId">
        <div v-if="o.folderIs" class="sn-cat-item sn-cat-folder"
             :class="{'drag-over-before': dragOverId===o.categoryId && dragPos==='before', 'drag-over-after': dragOverId===o.categoryId && dragPos==='after', dragging: catDragId===o.categoryId}"
             role="button" tabindex="0" draggable="true"
             :title="$t('statsG.SideNav.dblclickRenameTip')"
             :aria-expanded="isFolderExpanded(o.categoryId) ? 'true' : 'false'"
             @click="toggleFolder(o.categoryId)" @keydown.enter.prevent="toggleFolder(o.categoryId)"
             @dblclick.stop="startCatEdit(o)"
             @dragstart="dragStartCat(o,$event)" @dragover.prevent="dragOverCat(o,$event)" @drop.prevent="dropOnCat(o,$event)" @dragend="dragEndCat">
          <app-icon name="folder" :size="14" v-if="!isFolderExpanded(o.categoryId)" :style="{color:o.categoryColor}"/>
          <app-icon name="folder" :size="14" v-else :style="{color:o.categoryColor}"/>
          <template v-if="catEditing===o.categoryId">
            <input v-model="newCatName" class="sn-cat-edit" @keyup.enter="saveCatEdit(o)" @blur="saveCatEdit(o)"/>
          </template>
          <template v-else><span class="sn-cat-name">{{o.categoryName}}</span></template>
          <i class="folder-toggle-icon"><app-icon :name="isFolderExpanded(o.categoryId)?'chevron-down':'chevron-right'" :size="11"/></i>
          <i class="sn-cat-del" role="button" tabindex="0" :aria-label="$t('statsG.SideNav.delCatAria')" style="display:inline-flex"
             :title="$t('statsG.SideNav.delCatTitle')" @click.stop="delCat(o)" @keydown.enter.prevent.stop="delCat(o)"><app-icon name="trash" :size="12"/></i>
        </div>
        <template v-if="o.folderIs && o.children && o.children.length && isFolderExpanded(o.categoryId)">
          <div v-for="ch in o.children" :key="'c'+ch.categoryId"
               class="sn-cat-item sn-cat-child" role="link" tabindex="0"
               :title="$t('statsG.SideNav.dblclickRenameTip')"
               :class="{active: $route.params && $route.params.id == ch.categoryId}"
               @click="go('todo-list-category',{id:ch.categoryId})"
               @dblclick.stop="startCatEdit(ch)"
               @keydown.enter.prevent="go('todo-list-category',{id:ch.categoryId})">
            <span class="sn-dot" :style="{background:ch.categoryColor}"></span>
            <template v-if="catEditing===ch.categoryId">
              <input v-model="newCatName" class="sn-cat-edit" @keyup.enter="saveCatEdit(ch)" @blur="saveCatEdit(ch)"/>
            </template>
            <template v-else><span>{{ch.categoryName}}</span></template>
            <i class="sn-cat-del" role="button" tabindex="0" :aria-label="$t('statsG.SideNav.delCatAria')" style="display:inline-flex"
               :title="$t('statsG.SideNav.delCatTitle')" @click.stop="delCat(ch)" @keydown.enter.prevent.stop="delCat(ch)"><app-icon name="trash" :size="12"/></i>
          </div>
        </template>
        <div v-if="!o.folderIs"
             class="sn-cat-item" role="link" tabindex="0" draggable="true"
             :title="$t('statsG.SideNav.dblclickRenameTip')"
             :class="{active: $route.params && $route.params.id == o.categoryId,
                      'drag-over-before': dragOverId===o.categoryId && dragPos==='before', 'drag-over-after': dragOverId===o.categoryId && dragPos==='after', dragging: catDragId===o.categoryId}"
             @click="go('todo-list-category',{id:o.categoryId})"
             @keydown.enter.prevent="go('todo-list-category',{id:o.categoryId})"
             @dblclick.stop="startCatEdit(o)"
             @dragstart="dragStartCat(o,$event)" @dragover.prevent="dragOverCat(o,$event)" @drop.prevent="dropOnCat(o,$event)" @dragend="dragEndCat">
          <span class="sn-dot" :style="{borderColor:o.categoryColor, background:o.categoryColor}"></span>
          <template v-if="catEditing===o.categoryId">
            <input v-model="newCatName" class="sn-cat-edit" @keyup.enter="saveCatEdit(o)" @blur="saveCatEdit(o)"/>
          </template>
          <template v-else><span>{{o.categoryName}}</span></template>
          <i class="sn-cat-del" role="button" tabindex="0" :aria-label="$t('statsG.SideNav.delCatAria')" style="display:inline-flex"
             :title="$t('statsG.SideNav.delCatTitle')" @click.stop="delCat(o)" @keydown.enter.prevent.stop="delCat(o)"><app-icon name="trash" :size="12"/></i>
        </div>
      </template>
      </template>
    </div>

    <div class="sn-section sn-filters">
      <div class="sn-sec-head clickable" @click="showFilterPanel=!showFilterPanel">
        <button type="button" class="sn-sec-toggle" :aria-expanded="showFilterPanel ? 'true' : 'false'" :aria-label="$t('statsJ.SideNav.filterSectionAria')"
                @click.stop="showFilterPanel=!showFilterPanel" @keydown.enter.prevent.stop="showFilterPanel=!showFilterPanel" @keydown.space.prevent.stop="showFilterPanel=!showFilterPanel"><span>{{ $t('statsJ.SideNav.filterSection') }}</span></button>
        <span class="sn-sec-tools">
          <button class="sn-ico-btn" :title="$t('statsJ.SideNav.newFilterTitle')" @click.stop="filterEditVisible = true"><app-icon name="plus" :size="12"/></button>
          <i class="sn-fold-arrow" :class="{open:showFilterPanel}"><app-icon name="chevron-down" :size="11"/></i>
        </span>
      </div>
      <template v-if="showFilterPanel">
        <div v-for="f in $store.state.filters.list" :key="'f'+f.id"
             class="sn-cat-item" role="link" tabindex="0"
             :class="{active: $route.name==='todo-list-filter' && $route.params.id == f.id}"
             @click="go('todo-list-filter',{id:f.id})" @keydown.enter.prevent="go('todo-list-filter',{id:f.id})">
          <app-icon name="search" :size="12"/>
          <span>{{ f.name }}</span>
        </div>
        <div v-if="!$store.state.filters.list.length" class="sn-filter-empty">{{ $t('statsJ.SideNav.filterEmpty') }}</div>
      </template>
    </div>

    <div class="sn-section sn-tags">
      <div class="sn-sec-head clickable"
           @click="showTagPanel=!showTagPanel">
        <button type="button" class="sn-sec-toggle" :aria-expanded="showTagPanel ? 'true' : 'false'" :aria-label="$t('statsG.SideNav.tagSectionAria')"
                @click.stop="showTagPanel=!showTagPanel" @keydown.enter.prevent.stop="showTagPanel=!showTagPanel" @keydown.space.prevent.stop="showTagPanel=!showTagPanel"><span>{{ $t('statsG.SideNav.tagSection') }}</span></button><span class="sn-sec-tools"><button class="sn-ico-btn" :title="$t('statsG.SideNav.newTagBtnTitle')" @click.stop="createTag"><app-icon name="plus" :size="12"/></button><button class="sn-ico-btn" :title="$t('statsG.SideNav.manageTagTitle')" @click.stop="tagMgrVisible = true"><app-icon name="gear" :size="12"/></button><i class="sn-fold-arrow" :class="{open:showTagPanel}"><app-icon name="chevron-down" :size="11"/></i></span>
      </div>
      <template v-if="showTagPanel">
        <div v-for="t in tags.slice(0,10)" :key="t.name" class="sn-cat-item" role="link" tabindex="0"
             :class="{active:$route.params&&$route.params.id===t.name}"
             @click="go('todo-list-tag',{id:t.name})"
             @keydown.enter.prevent="go('todo-list-tag',{id:t.name})">
          <span class="sn-dot none"></span><span>{{t.name}}</span><em class="sn-badge">{{t.count}}</em>
        </div>
      </template>
    </div>

    </div>

    <!-- Recycle bin merged into the account row (user-finalized): a low-frequency defensive tool doesn't compete with navigation for space; the category-drag-into-delete target moved with the button -->
    <div class="sn-account">
      <span class="sn-avatar" :style="avatarStyle" aria-hidden="true">{{avatarChar}}</span>
      <span class="sn-username" :title="userNameMasked">{{userNameMasked}}</span>
      <span class="ml-auto"></span>
      <svg v-if="syncDone" class="sn-sync sn-sync--done" viewBox="0 0 24 24" role="img" :aria-label="$t('statsG.SideNav.syncDoneAria')">
        <path d="M20 6L9 17l-5-5" fill="none" stroke="#0c8172" stroke-width="2.4"
              stroke-linecap="round" stroke-linejoin="round" pathLength="1"/>
      </svg>
      <img v-else class="sn-sync" :class="{spinning}" src="app://app/assets/img/icon-sync3.svg" :title="$t('statsG.SideNav.syncTitle')"
           role="button" tabindex="0" :aria-label="$t('statsG.SideNav.syncAria')" @click="syncNow" @keydown.enter.prevent="syncNow">
      <button class="sn-account-gear sn-account-trash" :class="{'drag-ready': catDragId!=null, 'drag-over': trashHot}"
              :title="$t('statsG.SideNav.recycleBinBtn')" :aria-label="$t('statsG.SideNav.recycleBinBtn')"
              @click="go('todo-list-recycle-bin')" @keydown.enter.prevent="go('todo-list-recycle-bin')"
              @dragover="trashDragOver" @dragleave="trashHot=false" @drop.prevent="dropOnTrash">
        <app-icon name="trash" :size="14"/>
        <em v-if="recycleCount" class="sn-badge">{{ recycleCount }}</em>
      </button>
      <button class="sn-account-gear" :title="$t('statsG.SideNav.settingsTitle')" :aria-label="$t('statsG.SideNav.settingsAria')" @click="openSettings">
        <app-icon name="gear" :size="15"/>
        <i v-if="$store.state.ui.updateReady" class="sn-upd-dot" :title="$t('update.readyBadge')"></i>
      </button>
    </div>

    <div class="sn-collapsed-foot">
      <!-- Sync is also added to the collapsed state (user-finalized): the account row hides entirely when collapsed; sync/recycle bin/settings stack vertically -->
      <button class="sn-cog-btn" :title="$t('statsG.SideNav.syncTitle')" :aria-label="$t('statsG.SideNav.syncAria')"
              @click="syncNow" @keydown.enter.prevent="syncNow">
        <svg v-if="syncDone" class="sn-sync sn-sync--done" viewBox="0 0 24 24" role="img" :aria-label="$t('statsG.SideNav.syncDoneAria')">
          <path d="M20 6L9 17l-5-5" fill="none" stroke="#0c8172" stroke-width="2.4"
                stroke-linecap="round" stroke-linejoin="round" pathLength="1"/>
        </svg>
        <img v-else class="sn-sync" :class="{spinning}" src="app://app/assets/img/icon-sync3.svg" alt="">
      </button>
      <button class="sn-cog-btn" :class="{'drag-ready': catDragId!=null, 'drag-over': trashHot}"
              :title="$t('statsG.SideNav.recycleBinBtn')" :aria-label="$t('statsG.SideNav.recycleBinBtn')"
              @click="go('todo-list-recycle-bin')" @keydown.enter.prevent="go('todo-list-recycle-bin')"
              @dragover="trashDragOver" @dragleave="trashHot=false" @drop.prevent="dropOnTrash">
        <app-icon name="trash" :size="15"/>
      </button>
      <button class="sn-cog-btn" :title="$t('statsG.SideNav.settingsTitle')" :aria-label="$t('statsG.SideNav.settingsAria')"
              @click="openSettings" @keydown.enter.prevent="openSettings">
        <app-icon name="gear" :size="15"/>
        <i v-if="$store.state.ui.updateReady" class="sn-upd-dot" :title="$t('update.readyBadge')"></i>
      </button>
    </div>

    <!-- Expand handle while collapsed: appears at the right-edge middle on hovering the sidebar's blank area (2026-08-31 user feedback on discoverability) -->
    <button v-if="collapsed" class="sn-expand-hint" :title="$t('statsG.SideNav.expandSidebar')" :aria-label="$t('statsG.SideNav.expandSidebar')"
            tabindex="0" @click="toggleCollapse" @keydown.enter.prevent="toggleCollapse">
      <app-icon name="chevron-right" :size="14"/>
    </button>
    <!-- Mirrored handle while expanded: same position, same interaction language; a collapse arrow appears on hover (consistent symmetry) -->
    <button v-if="!collapsed" class="sn-collapse-hint" :title="$t('statsG.SideNav.collapseSidebar')" :aria-label="$t('statsG.SideNav.collapseSidebar')"
            tabindex="0" @click="toggleCollapse" @keydown.enter.prevent="toggleCollapse">
      <app-icon name="chevron-left" :size="14"/>
    </button>

    <el-dialog :title="$t('statsG.SideNav.manageCatTitle')" v-model="manageVisible" width="460px" append-to-body class="cat-mgr-dialog">
      <div class="cat-mgr-tip">{{ $t('statsG.SideNav.catMgrTip') }}</div>
      <div class="cat-mgr-head" aria-hidden="true">
        <span class="cat-mgr-hname">{{ $t('statsG.SideNav.catSection') }}</span><span class="cat-mgr-hcount">{{ $t('statsG.SideNav.unfinishedHeader') }}</span><span class="cat-mgr-hops">{{ $t('statsG.SideNav.opsHeader') }}</span>
      </div>
      <template v-for="c in categories" :key="c.categoryId">
      <div class="cat-mgr-row"
           :class="{ 'cat-mgr-row--dragging': mgrDragId === c.categoryId,
                     'cat-mgr-row--over-before': mgrDragOverId === c.categoryId && mgrDragPos === 'before',
                     'cat-mgr-row--over-after': mgrDragOverId === c.categoryId && mgrDragPos === 'after' }"
           draggable="true"
           @dragstart="dragMgrStart(c,$event)" @dragover.prevent="dragMgrOver(c,$event)" @drop.prevent="dropMgrOn(c)" @dragend="mgrDragId=null; mgrDragOverId=null; mgrDragPos=null">
        <i class="cat-mgr-drag" :title="$t('statsG.SideNav.dragSortTitle')"><app-icon name="dots" :size="13"/></i>
        <span class="sn-dot" :style="{borderColor:c.categoryColor, background:c.categoryColor}"></span>
        <input v-if="mgrEditing===c.categoryId" v-model="mgrName" class="sn-cat-edit"
               @keyup.enter="saveMgrEdit(c)" @blur="saveMgrEdit(c)"/>
        <span v-else class="cat-mgr-name" role="button" tabindex="0" :title="$t('statsG.SideNav.clickRenameTitle')"
              @click="startMgrEdit(c)" @keydown.enter.prevent="startMgrEdit(c)">{{c.categoryName}}</span>
        <em class="cat-mgr-count" role="button" tabindex="0" :title="$t('statsG.SideNav.previewTitle')"
            @click="toggleMgrPreview(c.categoryId)">{{ $t('statsG.SideNav.countItems', { n: countOf(c.categoryId) }) }}
          <app-icon :name="mgrExpanded[c.categoryId] ? 'chevron-up' : 'chevron-down'" :size="11"/></em>
        <button class="cat-mgr-del" :class="{'cat-mgr-del--on': isProject(c.categoryId)}" @click="toggleProject(c)">{{isProject(c.categoryId) ? $t('statsE.SideNav.cancelProject') : $t('statsG.SideNav.setProjectBtn')}}</button>
        <button class="cat-mgr-del" @click="removeMgrCat(c)">{{ $t('statsG.SideNav.deleteBtn') }}</button>
      </div>
      <div v-if="mgrExpanded[c.categoryId]" class="cat-mgr-preview">
        <div v-for="(title,i) in previewOf(c.categoryId)" :key="i" class="cat-mgr-preview__item">· {{title}}</div>
        <div v-if="!previewOf(c.categoryId).length" class="cat-mgr-preview__item cat-mgr-preview__empty">{{ $t('statsG.SideNav.noUnfinished') }}</div>
        <div v-if="countOf(c.categoryId) > 5" class="cat-mgr-preview__more">{{ $t('statsG.SideNav.moreItems', { n: countOf(c.categoryId) }) }}</div>
      </div>
      </template>
      <template #footer>
        <el-button size="small" type="primary" @click="manageVisible=false">{{ $t('statsG.SideNav.doneBtn') }}</el-button>
      </template>
    </el-dialog>

    <el-dialog :title="$t('statsG.SideNav.manageTagTitle')" v-model="tagMgrVisible" width="420px" append-to-body class="cat-mgr-dialog">
      <div class="cat-mgr-tip">{{ $t('statsG.SideNav.tagMgrTip') }}</div>
      <div v-for="t in tags" :key="t.name" class="cat-mgr-row cat-mgr-row--tag">
        <i class="cat-mgr-drag" :title="$t('statsG.SideNav.tagTitle')"><app-icon name="tag" :size="13"/></i>
        <input v-if="tagMgrEditing===t.name" v-model="tagMgrName" class="sn-cat-edit"
               @keyup.enter="renameTag(t)" @blur="renameTag(t)"/>
        <span v-else class="cat-mgr-name" role="button" tabindex="0" :title="$t('statsG.SideNav.clickRenameTitle')"
              @click="tagMgrEditing=t.name; tagMgrName=t.name" @keydown.enter.prevent="tagMgrEditing=t.name">{{t.name}}</span>
        <em class="cat-mgr-count">{{ $t('statsG.SideNav.countItems', { n: t.count }) }}</em>
        <button class="cat-mgr-del" @click="removeTag(t)">{{ $t('statsG.SideNav.deleteBtn') }}</button>
      </div>
      <div v-if="!tags.length" class="cat-mgr-tip" style="padding:12px 2px">{{ $t('statsG.SideNav.noTagsTip') }}</div>
      <template #footer>
        <el-button size="small" type="primary" @click="tagMgrVisible=false">{{ $t('statsG.SideNav.doneBtn') }}</el-button>
      </template>
    </el-dialog>
    <filter-modal v-if="filterEditVisible" @close="filterEditVisible=false" @saved="onFilterSaved"/>
  </aside>
</template>

<script lang="ts">
/** Left sidebar -- structure/icons/styles aligned with the reference: user row, search, 5 main nav items, categories, tags, bottom buttons */
import { extractTags } from '../utils/search.js'
import { visibleNavRoutes } from '../utils/nav-gate.js'
import i18n from '../i18n/index.js'
import WeatherWidget from './WeatherWidget.vue'
import { NAV_ITEMS, navKeyOfRoute } from '../views/registry.js'

// Icons/copy/order are all derived from views/registry.js (single source of truth); labelKey is resolved via navLabel() at render time --
// there is no component context at module top level, calling this.$t directly would blow up the whole module (white screen)
const NAV_ICON = Object.fromEntries(NAV_ITEMS.map(n => [n.route, n.icon]))
const NAV_LABEL = Object.fromEntries(NAV_ITEMS.map(n => [n.route, { i18n: n.labelKey }]))
const NAV_ORDER = NAV_ITEMS.map(n => n.route)

export default {
  name: 'SideNav',
  components: { WeatherWidget, FilterModal: () => import('./FilterModal.vue') },
  data () {
    return {
      // User's manual collapse preference (localStorage); forced collapse on narrow viewports, see also the narrow/collapsed computed
      // Value is JSON.stringify(boolean); on corruption/tampering fall back to false instead of throwing and blowing up the whole sidebar mount
      userCollapsed: localStorage.getItem('sidebarCollapsed') === 'true',
      narrow: false,
      catEditing: null as any,
      newCatName: '',
      showTagPanel: true,
      searchWord: '',
      // Sync button spin flag (reference: sidebar-profile-item__btn--spin)
      spinning: false,
      syncDone: false, // the icon briefly turns into a checkmark after sync completes
      // Manage categories modal: inline rename / delete (with confirmation) / item count / drag sorting
      manageVisible: false,
      mgrEditing: null as any,
      mgrName: '',
      mgrDragId: null as any,
      mgrDragOverId: null as any,
      mgrDragPos: null,      // drop position: 'before' | 'after' (gap-level indicator)
      mgrExpanded: {},       // expanded state of the category content preview
      // Manage tags modal: renaming/deleting a tag = rewriting the #tag in all task content
      tagMgrVisible: false,
      tagMgrEditing: null as any,
      tagMgrName: '',
      catFold: false,
      showFilterPanel: true,
      filterEditVisible: false,
      expandedFolders: {} as any,
      // Sidebar category drag: source row id / hovered target row id / recycle bin highlight on drag-over
      catDragId: null as any,
      dragOverId: null as any,
      dragPos: null as any,
      trashHot: false
    }
  },
  computed: {
    /* Collapsed state = user preference. Narrow windows (<920px) no longer force collapse: the expanded state is handled by a CSS drawer (absolutely positioned over the main column,
       out of flow) to cover the overflow P0; the collapse-once-on-narrow logic is in mounted/_onNarrow */
    collapsed () { return this.userCollapsed },
    filteredNavOrder () {
      // Gate doctrine lives in utils/nav-gate.js (pure + unit-tested): developer mode is the
      // master gate for experiments, each of which also has its own module switch; projects
      // has graduated and rides on its own switch alone.
      return visibleNavRoutes(this.$store.state.settings, NAV_ORDER)
    },
    user () { return this.$store.state.auth.user },
    todoBoxCount () { return this.$store.state.todo.views.todoBoxCount },
    /* Recycle bin badge: count of soft-deleted entries (the original footer button migrated to the account row, user-finalized) */
    recycleCount () { return this.$store.state.todo.todoList.filter(t => t.delete).length },

    /* Category list dual-getter mapping (the computed was previously missing; template/new-category relied on undefined and the list never rendered = "new category was simply broken") */
    hierarchical () { return this.$store.getters['category/hierarchical'] },
    categories () { return this.$store.getters['category/sortedAll'] },
    NAV_ORDER () { return NAV_ORDER },
    NAV_ICON () { return NAV_ICON },
    NAV_LABEL () { return NAV_LABEL },
    /* Project warning badge: number of projects with an approaching deadline/milestone due (within 7 days, including overdue) — the template previously referenced a never-declared projectWarn so the badge was always empty (confirmed by the template identifier guard's first run) */
    projectWarn () {
      const meta = this.$store.state.category.projectMeta || {}
      const now = Date.now()
      const WEEK = 7 * 86400000
      let n = 0
      for (const id of Object.keys(meta)) {
        const m = meta[id] || {}
        if ((m.deadline && m.deadline - now < WEEK) || (m.nextMilestone && m.nextMilestone.date && m.nextMilestone.date - now < WEEK)) n++
      }
      return n
    },

    userNameMasked () {
      const u = this.user || {}
      // The default name is not persisted (otherwise the first-run language would be frozen); translated live in the current language
      if (u.userNameDefault) return this.$t('statsA.core.offlineUser')
      return u.userName || this.$t('statsE.SideNav.notSignedIn')
    },
    avatarChar () { return (this.userNameMasked || '·').trim().charAt(0).toUpperCase() || '·' },
    avatarStyle () {
      // Hash the username into a fixed hue so the same user keeps a stable color, with no offline avatar file dependency
      let h = 0
      for (const ch of String(this.userNameMasked)) h = (h * 31 + ch.charCodeAt(0)) % 360
      return { background: `linear-gradient(135deg, hsl(${h},62%,58%), hsl(${(h + 40) % 360},62%,46%))` }
    },
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
  mounted () {
    // Restore empty tags created via "New Tag" (stored in meta; the tags themselves are still derived from #xxx in content)
    if (window.todoAPI && window.todoAPI.dbCall) {
      window.todoAPI.dbCall('getMeta', 'userTags').then(v => {
        try { const l = JSON.parse(v || '[]'); if (Array.isArray(l)) this.$store.commit('ui/setUserTags', l) } catch { /* no-op */ }
      }).catch(() => {})
    }
    // Collapse once when entering a narrow viewport (breakpoint = drawer breakpoint 920px; the expanded state uses the CSS drawer overlay, no longer locked);
    // the user preference is restored automatically when the window is widened back
    this._narrowMql = window.matchMedia('(max-width: 919px)')
    this._onNarrow = e => {
      const was = this.narrow
      this.narrow = e.matches
      if (!was && e.matches && !this.userCollapsed) this.toggleCollapse()
    }
    this.narrow = this._narrowMql.matches
    if (this.narrow && !this.userCollapsed) this.userCollapsed = true
    if (this._narrowMql.addEventListener) this._narrowMql.addEventListener('change', this._onNarrow)
    else this._narrowMql.addListener(this._onNarrow)
  },
  // The Vue3 hook is beforeUnmount: it was once written as Vue2's beforeDestroy, so the cleanup never ran (MQL listener leak)
  beforeUnmount () {
    if (this._narrowMql) {
      if (this._narrowMql.removeEventListener) this._narrowMql.removeEventListener('change', this._onNarrow)
      else this._narrowMql.removeListener(this._onNarrow)
    }
  },
  methods: {
    onFilterSaved (id) {
      this.filterEditVisible = false
      if (id) this.$router.push({ name: 'todo-list-filter', params: { id: String(id) } }).catch(() => {})
    },
    navLabel (n) {
      const v = NAV_LABEL[n] || ''
      return (v && v.i18n) ? i18n.global.t(v.i18n) : v
    },
    toggleCollapse () {
      this.userCollapsed = !this.userCollapsed
      localStorage.setItem('sidebarCollapsed', JSON.stringify(this.userCollapsed))
    },
    /* Clicking the search icon while collapsed: expand the sidebar and hand focus to the search input.
       In narrow windows (<920px) the expanded state uses the drawer overlay (CSS media query, absolutely positioned over the main column without squeezing the layout),
       so it can be expanded and focused directly at any width */
    expandAndFocusSearch () {
      if (!this.collapsed) return
      this.toggleCollapse()
      this.$nextTick(() => {
        const input = this.$refs.searchInput
        if (input) { input.focus(); input.select() }
      })
    },
    /* Whole search box click (user-finalized: clicking again collapses it) --
       clicking the input/clear button does not trigger; collapsed = expand + focus; expanded = collapse the sidebar */
    onSearchClick (e) {
      if (e.target.tagName === 'INPUT' || e.target.closest('.main-nav-search__clear')) return
      if (this.collapsed) this.expandAndFocusSearch()
      else this.toggleCollapse()
    },
    /* Esc inside the input: clear text first if any; if empty (or already cleared) collapse the sidebar and dismiss the search box */
    onSearchEsc () {
      if (String(this.$store.state.todo.search || '').trim()) { this.clearSearch(); return }
      const input = this.$refs.searchInput
      if (input) input.blur()
      if (!this.collapsed) this.toggleCollapse()
    },
    go (name: string, params?: any) {
      this.$router.push({ name, params }).catch(() => {})
      // The navKey mapping derives from views/registry.js; parameterized routes (category/tag/project/filter) compose dynamic keys
      this.$store.commit('ui/setNav', navKeyOfRoute(name) || ('category:' + (params && params.id)))
    },
    /* Reference MainNavSearch: typing writes to the store and navigates to the search page immediately; go back when cleared */
    onSearchInputEvt (e: Event) {
      this.onSearchInput((e.target as HTMLInputElement).value)
    },
    onSearchInput (v) {
      this.$store.commit('todo/setSearch', v)
      const w = String(v || '').trim()
      // Snapshot the view we are leaving when entering search, so clearing can navigate back deterministically ($router.back() is unreliable: empty history stack misfires)
      if (w && this.$route.name !== 'todo-list-search') {
        this._searchReturnRoute = { name: this.$route.name, params: { ...this.$route.params } }
        this.go('todo-list-search')
      }
      if (!w && this.$route.name === 'todo-list-search') this._returnFromSearch()
    },
    clearSearch () {
      this.$store.commit('todo/setSearch', '')
      if (this.$route.name === 'todo-list-search') this._returnFromSearch()
    },
    /* Deterministic exit from the search page: router.replace to the snapshotted source view (today as the fallback),
       then re-sync the active nav key the same way go() does */
    _returnFromSearch () {
      const r = this._searchReturnRoute && this._searchReturnRoute.name ? this._searchReturnRoute : { name: 'todo-list-today' }
      this.$router.replace(r).catch(() => {})
      this.$store.commit('ui/setNav', navKeyOfRoute(r.name) || ('category:' + (r.params && r.params.id)))
      this._searchReturnRoute = null
    },
    createCategory () {
      const name = this.$t('statsE.SideNav.newCategory')
      this.$store.commit('category/addCategory', { categoryName: name })
      const list = this.$store.state.category.list
      this.catEditing = list[list.length - 1].categoryId
      this.newCatName = name
      this.$nextTick(() => {
        const inp = this.$el.querySelector('.sn-cat-edit')
        if (inp) { inp.focus(); inp.select() }
      })
    },
    toggleFolder (id) { this.expandedFolders = { ...this.expandedFolders, [id]: !this.expandedFolders[id] } },
    /** New tag: same position and interaction as "New Category"; the tag itself is still derived from #xxx in content, empty tags are stored in meta as placeholders */
    async createTag () {
      try {
        const { value } = await this.$prompt(this.$t('statsE.SideNav.tagAutoCreateHint'), this.$t('statsG.SideNav.newTagTitle'), {
          inputValue: '', inputPattern: /\S/, inputErrorMessage: this.$t('statsE.SideNav.tagNameEmptyError')
        })
        const name = (value || '').trim().replace(/^#+/, '')
        if (!name) return
        const list = this.$store.state.ui.userTags.slice()
        if (!list.includes(name) && !this.tags.some(t => t.name === name)) list.push(name)
        this.$store.commit('ui/setUserTags', list)
        if (window.todoAPI && window.todoAPI.dbCall) {
          window.todoAPI.dbCall('setMeta', ['userTags', JSON.stringify(list)]).catch(() => {})
        }
      } catch { /* cancelled */ }
    },
    isFolderExpanded (id) { return !!this.expandedFolders[id] },
    addCategory () {
      const name = this.newCatName.trim() || (this.$t('statsE.SideNav.categoriesLabel') + (this.categories.length + 1))
      this.$store.commit('category/addCategory', { categoryName: name })
      this.newCatName = ''
    },
    saveCatEdit (c) {
      this.$store.commit('category/updateCategory', { categoryId: c.categoryId, categoryName: this.newCatName.trim() || c.categoryName })
      this.catEditing = null
    },
    startCatEdit (c) {
      this.catEditing = c.categoryId
      this.newCatName = c.categoryName
      this.$nextTick(() => {
        const inp = this.$el.querySelector('.sn-cat-edit')
        if (inp) { inp.focus(); inp.select() }
      })
    },
    /* ===== Manage categories modal (batch management entry) ===== */
    countOf (id) {
      return this.$store.state.todo.todoList.filter(t => t.categoryId === id && !t.complete).length
    },
    isProject (id) { return this.$store.state.category.projectIds.includes(id) },
    /** Set/unset as project (secondary path; the primary entry is "New Project" on the project overview page) */
    toggleProject (c) {
      const flag = !this.isProject(c.categoryId)
      this.$store.commit('category/setProject', { id: c.categoryId, flag })
      this.$message.success(flag ? this.$t('statsG.SideNav.setProject', { name: c.categoryName }) : this.$t('statsG.SideNav.unsetProject', { name: c.categoryName }))
    },
    startMgrEdit (c) {
      this.mgrEditing = c.categoryId
      this.mgrName = c.categoryName
      this.$nextTick(() => {
        const inp = this.$el.querySelector('.cat-mgr-row input')
        if (inp) { inp.focus(); inp.select() }
      })
    },
    saveMgrEdit (c) {
      if (this.mgrEditing !== c.categoryId) return
      this.$store.commit('category/updateCategory', { categoryId: c.categoryId, categoryName: this.mgrName.trim() || c.categoryName })
      this.mgrEditing = null
    },
    dragMgrStart (c, e) {
      this.mgrDragId = c.categoryId
      e.dataTransfer.effectAllowed = 'move'
      e.dataTransfer.setData('text/plain', String(c.categoryId))
    },
    dragMgrOver (c, e) {
      if (this.mgrDragId == null || this.mgrDragId === c.categoryId) return
      const rect = e.currentTarget.getBoundingClientRect()
      this.mgrDragPos = (e.clientY - rect.top) < rect.height / 2 ? 'before' : 'after'
      this.mgrDragOverId = c.categoryId
    },
    dropMgrOn (c) {
      const from = this.mgrDragId
      const pos = this.mgrDragPos
      this.mgrDragId = null
      this.mgrDragOverId = null
      this.mgrDragPos = null
      if (from == null || from === c.categoryId) return
      const ids = this.categories.map(x => x.categoryId)
      const fi = ids.indexOf(from)
      let ti = ids.indexOf(c.categoryId)
      if (fi < 0 || ti < 0) return
      ids.splice(fi, 1)
      if (fi < ti) ti -= 1 // remove before inserting; the drop index is corrected for the visual position
      ids.splice(pos === 'after' ? ti + 1 : ti, 0, from)
      this.$store.commit('category/reorder', ids)
    },
    /** Category content preview: first 5 incomplete task titles */
    previewOf (id) {
      return this.$store.state.todo.todoList
        .filter(t => t.categoryId === id && !t.complete && !t.delete)
        .slice(0, 5).map(t => t.taskContent)
    },
    toggleMgrPreview (id) { this.mgrExpanded = { ...this.mgrExpanded, [id]: !this.mgrExpanded[id] } },
    async removeMgrCat (c) { await this.delCat(c) },
    /* ===== Manage tags: rename/delete = rewrite the #tag across all task content and descriptions in sync ===== */
    tagTodos (name): any[] {
      return this.$store.state.todo.todoList.filter(t =>
        extractTags(t.taskContent, t.taskDescribe).includes(name))
    },
    async renameTag (t) {
      const next = this.tagMgrName.trim().replace(/^#/, '')
      this.tagMgrEditing = null
      if (!next || next === t.name) return
      if (this.tags.some(x => x.name === next)) return this.$message.warning(this.$t('statsG.SideNav.tagExists', { name: next }))
      const esc = t.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const re = new RegExp('#' + esc + '(?=\\s|$)', 'g')
      for (const todo of this.tagTodos(t.name)) {
        const patch: any = {}
        if (todo.taskContent) {
          const v = todo.taskContent.replace(re, '#' + next)
          if (v !== todo.taskContent) patch.taskContent = v
        }
        if (todo.taskDescribe) {
          const v = todo.taskDescribe.replace(re, '#' + next)
          if (v !== todo.taskDescribe) patch.taskDescribe = v
        }
        if (Object.keys(patch).length) await this.$store.dispatch('todo/updateTodoFields', { taskId: todo.taskId, patch })
      }
      this.$message.success(this.$t('statsG.SideNav.tagRenamed', { name: next }))
    },
    async removeTag (t) {
      try {
        await this.$confirm(this.$t('statsG.SideNav.delTagConfirm', { name: t.name, count: this.tagTodos(t.name).length }), this.$t('statsE.SideNav.tipTitle'), { type: 'warning' })
      } catch { return }
      const esc = t.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const re = new RegExp('\\s*#' + esc + '(?=\\s|$)', 'g')
      for (const todo of this.tagTodos(t.name)) {
        const patch: any = {}
        if (todo.taskContent) {
          const v = todo.taskContent.replace(re, '').trim()
          if (v !== todo.taskContent) patch.taskContent = v
        }
        if (todo.taskDescribe) {
          const v = todo.taskDescribe.replace(re, '').trim()
          if (v !== todo.taskDescribe) patch.taskDescribe = v
        }
        if (Object.keys(patch).length) await this.$store.dispatch('todo/updateTodoFields', { taskId: todo.taskId, patch })
      }
      this.$message.success(this.$t('statsG.SideNav.tagDeleted', { name: t.name }))
    },
    async delCat (c) {
      try {
        await this.$confirm(this.$t('statsG.SideNav.delCatConfirm', { name: c.categoryName }), this.$t('statsE.SideNav.tipTitle'), { type: 'warning' })
      } catch { return } // user cancelled; leave the data untouched
      this.$store.commit('category/softDelete', c.categoryId)
      if (this.isProject(c.categoryId)) this.$store.commit('category/setProject', { id: c.categoryId, flag: false })
      for (const t of this.$store.state.todo.todoList.filter(x => x.categoryId === c.categoryId)) {
        await this.$store.dispatch('todo/updateTodoFields', { taskId: t.taskId, patch: { categoryId: 0 } })
      }
      // Clean up settings keys pointing at the dead category id: otherwise the todo box filtered by that category stays forever empty (showing 0 items even after data restore)
      const st: any = this.$store.state.settings
      const reset: any = {}
      if (st.todoBoxCategoryId === c.categoryId) reset.todoBoxCategoryId = -1
      if (st.newTodoCategoryId === c.categoryId) reset.newTodoCategoryId = 0
      if (st.calendarCategory === c.categoryId) reset.calendarCategory = 0
      if (Object.keys(reset).length) this.$store.commit('settings/updateSettings', reset)
    },
    /* ===== Account card: primary entry to Settings (feedback/about live inside the Settings page) ===== */
    openSettings () {
      this.$store.commit('ui/toggleSettings', true)
    },
    /* ===== Sync: the icon spins for exactly the sync duration, then turns into a checkmark in place on completion;
       the result is clearly fed back via a top-right notification (success/failure); the checkmark is only an icon-state supplement ===== */
    async syncNow () {
      if (this.spinning || this.$store.state.todo.isSyncing) return
      this.spinning = true
      try {
        await this.$store.dispatch('todo/syncTodos')
        this.syncDone = true
        clearTimeout(this._syncDoneTimer)
        this._syncDoneTimer = setTimeout(() => { this.syncDone = false }, 1400)
        this.$notify({ title: this.$t('statsE.SideNav.syncCompleteMsg'), message: this.$t('statsG.SideNav.syncDoneMsg'), type: 'success', duration: 2000 })
      } catch (e) {
        this.$notify({ title: this.$t('statsE.SideNav.syncFailedMsg'), message: (e && e.message) || this.$t('statsG.SideNav.syncFailMsg'), type: 'error', duration: 4000 })
      } finally { this.spinning = false }
    },
    /* ===== Direct sidebar category operations (replacing the old "Manage Categories" modal) ===== */
    dragStartCat (o, e) {
      this.catDragId = o.categoryId
      e.dataTransfer.effectAllowed = 'move'
      e.dataTransfer.setData('text/plain', String(o.categoryId))
    },
    dragOverCat (o, e) {
      if (this.catDragId == null || this.catDragId === o.categoryId) return
      this.dragOverId = o.categoryId
      // Decide whether to insert before or after the target based on the mouse being in the row's upper/lower half
      const rect = e.currentTarget.getBoundingClientRect()
      this.dragPos = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
    },
    dropOnCat (o, e) {
      const from = this.catDragId
      const pos = this.dragPos || 'before'
      this.catDragId = null
      this.dragOverId = null
      this.dragPos = null
      if (from == null || from === o.categoryId) return
      const ids = this.hierarchical.map(c => c.categoryId)
      const fi = ids.indexOf(from); const ti = ids.indexOf(o.categoryId)
      if (fi < 0 || ti < 0) return
      ids.splice(fi, 1)
      let insertAt = ids.indexOf(o.categoryId)
      if (pos === 'after') insertAt += 1
      ids.splice(insertAt, 0, from)
      this.$store.commit('category/reorder', ids)
    },
    dragEndCat () { this.catDragId = null; this.dragOverId = null; this.trashHot = false },
    trashDragOver (e) {
      if (this.catDragId == null) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      this.trashHot = true
    },
    dropOnTrash () {
      const id = this.catDragId
      this.catDragId = null
      this.dragOverId = null
      this.trashHot = false
      const c = this.$store.getters['category/byId'](id)
      if (c) this.delCat(c)
    },
  },

  created () { /* NAV_* constants are now exposed via computed (non-reactive instance properties once caused the template identifier guard to under-report) */ }
}
</script>
<style>
.sn-scrollable { flex: 1; overflow-y: auto; min-height: 0; display: flex; flex-direction: column; }
.sn-search {
  display: flex; align-items: center; gap: var(--space-2); height: 36px; margin: 0 0 10px;
  background: var(--gray-bg); border: 1px solid var(--line); border-radius: var(--radius-pill); padding: 0 14px 0 7px; /* 左7=框内图标重心对齐品牌标中心线(x≈25)，右14保住占位文字与导航文字同列(x=40) */
  /* 折叠/展开的形态变形：框收掉↔长出来、图标放大↔缩回框里 */
  transition: background-color var(--dur-slow) cubic-bezier(.2,.8,.2,1), border-color var(--dur-slow) cubic-bezier(.2,.8,.2,1), padding var(--dur-slow) cubic-bezier(.2,.8,.2,1), margin var(--dur-slow) cubic-bezier(.2,.8,.2,1);
}
.sn-search .app-icon--search { transition: width var(--dur-mid) cubic-bezier(.2,.8,.2,1), height var(--dur-mid) cubic-bezier(.2,.8,.2,1), opacity var(--dur-mid) ease; }
.sn-search input { transition: opacity var(--dur-fast) ease, transform var(--dur-mid) cubic-bezier(.2,.8,.2,1), padding var(--dur-slow) cubic-bezier(.2,.8,.2,1), flex var(--dur-slow) cubic-bezier(.2,.8,.2,1); }
.sn-search i { font-style: normal; font-size: var(--fs-sm); opacity: .5; }
.sn-search input { flex: 1; border: 0; background: none; font-size: var(--fs-md); color: var(--text-1); }
.sn-search input::placeholder { color: #8a9099; }
.sn-nav-item {
  display: flex; align-items: center; gap: var(--space-3); height: 40px; padding: 0 12px;
  border-radius: var(--radius-md); cursor: pointer; color: var(--text-1); font-size: var(--fs-md); transition: background var(--dur-fast);
}
.sn-nav-item:hover { background: var(--gray-bg); }
.sn-nav-item.active { background: var(--brand-light); color: var(--brand); font-weight: 600; }
.sn-nav-ico { width: 18px; height: 18px; }
.sn-nav-item.active .sn-badge { color: inherit; font-weight: 600; }
.sn-cat-add {
  width: 46px; border: 0; background: none; text-align: right; font-size: var(--fs-md); color: var(--brand);
}
.sn-cat-add::placeholder { color: var(--brand); }
.sn-cat-item {
  /* 左 14 + 点 10 + 间距 16：圆点中心对齐导航图标中心(19)，文字起点对齐导航文字(40) */
  display: flex; align-items: center; gap: var(--space-4); height: 36px; padding: 0 12px 0 14px;
  border-radius: var(--radius-md); cursor: pointer; font-size: var(--fs-md); color: var(--text-1);
}
.sn-cat-item:hover { background: var(--gray-bg); }
.sn-cat-item.active { background: var(--brand-light); color: var(--brand); }
.sn-cat-edit { border: 0; border-bottom: 1px solid var(--brand); background: none; flex: 1; font-size: var(--fs-md); }
/* 回收站：常态保持灰，hover 才高亮红（危险语义） */
/* 账户卡片（底部）：头像 + 用户名 + 同步 + 设置，替代原顶部用户行与三点菜单 */
.sn-account {
  display: flex; align-items: center; gap: var(--space-2);
  margin-top: 10px; padding: 6px 8px; border-radius: var(--radius-lg);
  background: var(--gray-bg);
}
.sn-account .ml-auto { margin-left: auto; }
.sn-account .sn-username {
  font-size: var(--fs-md); font-weight: 600; color: var(--text-1);
  max-width: 110px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.sn-account-gear {
  position: relative;
  display: flex; align-items: center; justify-content: center;
  width: 26px; height: 26px; border: 0; border-radius: var(--radius-md); padding: 0;
  background: none; color: var(--text-3); cursor: pointer;
  transition: background-color var(--dur-mid), color var(--dur-mid);
}
.sn-account-gear:hover { background: rgba(0, 0, 0, .06); color: var(--text-1); }
/* 回收站并入账户行(用户定稿):默认灰,hover/拖拽悬停才泛红 */
.sn-account-trash { position: relative; }
.sn-account-trash:hover, .sn-account-trash.drag-over { background: var(--danger-soft, rgba(196,85,45,.1)); color: var(--danger-strong, #c4552d); }
.sn-account-trash.drag-over { outline: 1.5px dashed var(--danger-strong, #c4552d); }
.sn-account-trash .sn-badge { position: absolute; top: -4px; right: -5px; }
.sn-account .sn-sync { margin-left: 2px; }
/* 10. 侧边栏分类/标签行高亮过渡（原来 hover/active 是硬切） */
.sn-cat-item { transition: background var(--dur-fast), color var(--dur-fast); }
.side-nav--collapsed .sn-brand__text,
.side-nav--collapsed .sn-section,
.side-nav--collapsed .sn-account { display: none; }
.side-nav--collapsed .sn-navs .sn-nav-item span,
.side-nav--collapsed .sn-navs .sn-nav-item em { display: none; }
.side-nav--collapsed .sn-navs .sn-nav-item { justify-content: center; padding: 0; }
/* 品牌标 svg 定尺寸（内联 svg 无宽高时按默认尺寸溢出，被 overflow 裁切成"缺角"） */
.sn-brand__mark svg { width: 30px; height: 30px; display: block; }
/* 折叠态：天气/搜索退化为图标钮（点击展开侧边栏） */
/* 折叠态几何统一在下方「折叠态退化」区块（40px 图标方格），此处只管内容显隐 */
.side-nav--collapsed .sn-weather,
.side-nav--collapsed .sn-search {
  display: flex; align-items: center; cursor: pointer; border-radius: var(--radius-md);
}
.side-nav--collapsed .sn-weather:hover,
.side-nav--collapsed .sn-search:hover { background: var(--hover-bg); }
.side-nav--collapsed .sn-weather .w-temp,
.side-nav--collapsed .sn-weather .w-desc,
.side-nav--collapsed .sn-weather .w-shape,
.side-nav--collapsed .sn-weather .w-city { display: none; }
.side-nav--collapsed .sn-search input,
.side-nav--collapsed .sn-search .main-nav-search__clear { display: none; }
/* 收起/展开整行可点（用户定稿）：品牌行任意位置点击都切换折叠，「»/«」只作视觉指示 */
.sn-brand { cursor: pointer; border-radius: var(--radius-md); transition: background var(--dur-fast); }
.sn-brand:hover { background: var(--hover-bg); }
.sn-brand:focus-visible { outline: 2px solid var(--brand); outline-offset: -2px; }
.sn-brand .sn-collapse-btn {
  margin-left: auto; width: 22px; height: 22px; border-radius: var(--radius-md);
  display: flex; align-items: center; justify-content: center;
  color: var(--text-3); font-size: var(--fs-md);
  opacity: 0; transition: opacity var(--dur-fast);
}
.sn-brand:hover .sn-collapse-btn { opacity: 1; }
/* 折叠态（48px 图标栏）：品牌行只留 mark，指示符隐藏，点击任意位置展开 */
.side-nav--collapsed .sn-brand__text { display: none; }
.side-nav--collapsed .sn-collapse-btn { display: none; }
/* ==================== 侧边栏品牌头部（拾事 PickDone） ==================== */
.sn-brand { display: flex; align-items: center; gap: 10px; padding: 14px 12px 10px 0; }
/* 左0=导航图标公共列(x=10)：展开态品牌标/天气/搜索/导航同列 */
/* 用户定稿：图标本体直接展示（30px 满幅），不再垫蓝色底块 */
.sn-brand__mark {
  width: 30px; height: 30px; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
}
.sn-brand__name { font-size: var(--fs-lg); font-weight: 700; color: var(--text-1); line-height: 1.2; }
.sn-brand__en { font-size: var(--fs-2xs); letter-spacing: 2.5px; text-transform: uppercase; color: var(--text-3); }
/* ==================== 折叠态退化（搜索→纯图标 / 天气→纯图标 / 底部⚙设置） ==================== */
/* 折叠态统一图标格：栏内边距收窄到 4px，品牌/天气/搜索/导航项/底部齿轮均为 40×40 正方形格（用户定稿：hover 高亮必须是方形，不允许异形长条） */
/* padding-top 与展开态(12px)对齐 + sn-navs 补 17px：品牌行展开 55px/折叠 40px 的高度差不再让导航图标列整体上浮（用户反馈折叠后图标偏高）。
   注意 sn-fixed 是普通块容器，此 margin 与搜索框的 10px 下边距折叠取较大者，故净补偿 = 17-10 = 7px */
.side-nav--collapsed { display: flex; flex-direction: column; padding: 12px 4px 10px; }
.side-nav--collapsed .sn-navs { margin-top: 17px; }
.side-nav--collapsed .sn-brand { height: 40px; padding: 0; justify-content: center; margin-bottom: var(--space-2); }
.side-nav--collapsed .sn-weather { height: 40px; padding: 0; justify-content: center; margin-bottom: var(--space-2); }
/* 8px 与品牌行下距同节奏(2026-08-31 用户反馈两段间距不一) */

/* 展开态搜索行为对齐图标列加了左内边距，折叠态图标钮需重置回居中 */
.side-nav--collapsed .sn-search { height: 40px; padding: 0; justify-content: center; }
.side-nav--collapsed .sn-navs .sn-nav-item { height: 40px; padding: 0; justify-content: center; margin-bottom: var(--space-1); }
.side-nav--collapsed .main-nav-search.sn-search:hover { background: var(--hover-bg); }
/* 上面的透明背景同特异性更靠后，会吃掉 hover 高亮，这里补回 */
.side-nav--collapsed .main-nav-search.sn-search input { flex: 0 0 0px; opacity: 0; transform: scale(.5); padding: 0; pointer-events: none; }
.side-nav--collapsed .main-nav-search.sn-search .main-nav-search__clear { display: none; }
.side-nav--collapsed .main-nav-search.sn-search .app-icon--search { width: 20px; height: 20px; opacity: .9; transform: translate(2px, 2px); }
.side-nav--collapsed .sn-collapsed-foot { display: flex; flex-direction: column; align-items: center; gap: 2px; }
/* 折叠态展开把手：平时隐身，悬停侧栏任意区域从右缘中部滑出；半圆角贴边不占布局空间 */
.side-nav--collapsed { position: relative; }
.side-nav--collapsed:hover .sn-expand-hint, .sn-expand-hint:focus-visible { opacity: 1; }
/* 展开态镜像把手：同位置同交互，箭头朝左、圆角朝右（与折叠态对称） */
.side-nav:not(.side-nav--collapsed) { position: relative; }
.side-nav:not(.side-nav--collapsed):hover .sn-collapse-hint, .sn-collapse-hint:focus-visible { opacity: 1; }
.side-nav--collapsed .sn-cog-btn { width: 40px; height: 40px; padding: 0; justify-content: center; align-items: center; }
/* 与折叠格（天气/搜索/导航）同一高亮 token */

/* 折叠向：内容块轻淡入，掩住 display:none 的瞬间跳变（展开向保留宽度过渡本身，用户定稿去掉镜框高亮） */
.side-nav--collapsed .sn-fixed > *,
.side-nav--collapsed .sn-scrollable > *,
.side-nav--collapsed .sn-collapsed-foot { animation: sn-slide .28s cubic-bezier(.2, .8, .2, 1) both; }
/* 8. 滚动条全局统一：细圆角，hover 加深（main-scroll/page__main/sn-scrollable/ep-inner） */
.main-scroll::-webkit-scrollbar, .page__main::-webkit-scrollbar,
.sn-scrollable::-webkit-scrollbar, .ep-inner::-webkit-scrollbar { width: 6px; height: 6px; }
.main-scroll::-webkit-scrollbar-thumb, .page__main::-webkit-scrollbar-thumb,
.sn-scrollable::-webkit-scrollbar-thumb, .ep-inner::-webkit-scrollbar-thumb {
  background: rgba(144, 147, 153, .22); border-radius: var(--radius-sm);
}
.main-scroll::-webkit-scrollbar-thumb:hover, .page__main::-webkit-scrollbar-thumb:hover,
.sn-scrollable::-webkit-scrollbar-thumb:hover, .ep-inner::-webkit-scrollbar-thumb:hover { background: rgba(144, 147, 153, .45); }
.main-scroll::-webkit-scrollbar-track, .page__main::-webkit-scrollbar-track,
.sn-scrollable::-webkit-scrollbar-track, .ep-inner::-webkit-scrollbar-track { background: transparent; }
/* ============ 交互控件禁选（连点/双击不再拉出选区；任务标题/描述等内容区不受影响） ============ */
.sn-nav-item, .sn-cat-item, .sn-sec-head, .sn-sec-tools, .sn-user-row, .sn-section,
.tg-head, .grp-toggle-btn, .todo-list-item-group-head,
.day-strip, .ds-day, .ds-arrow, .ds-label, .ds-today-ico, .ds-cal-pop,
.ep-row, .ep-cat-row, .ep-tags-row, .ep-date-chip, .ep-tag-chip, .ep-collapse-btn, .ep-done-row,
.td-subs, .td-meta, .td-sub, .td-sub-check,

/* 滚动到边界不再带动父级/整页（滚动链穿透） */
.sn-scrollable, .main-scroll, .ep-inner, .ds-cal-pop, .cal-more-pop__body { overscroll-behavior: contain; }
/* 分类管理弹窗 */
.cat-mgr-tip { font-size: var(--fs-sm); color: var(--text-3); padding: 0 2px 10px; }
.cat-mgr-row {
  display: flex; align-items: center; gap: 10px;
  height: 42px; padding: 0 8px; font-size: var(--fs-md); color: var(--text-1);
  border-bottom: 1px solid var(--line); background: var(--panel, #fff); cursor: grab;
}
.cat-mgr-row:last-of-type { border-bottom: none; }
.cat-mgr-row:hover { background: var(--gray-bg); }
.cat-mgr-row { transition: background var(--dur-fast), transform var(--dur-fast); }
.cat-mgr-row:hover .cat-mgr-drag { color: var(--brand); }
.cat-mgr-row--dragging { opacity: .4; transform: scale(.99); cursor: grabbing; }
/* 拖拽落点指示：独立伪元素横线浮在两行交界的缝隙上（上沿=插到前面，下沿=插到后面），
   首行上沿/末行下沿同样生效；3px 青色圆角线 + 光晕，确保可见 */
.cat-mgr-row { position: relative; }
.cat-mgr-row--over-before::before,
.cat-mgr-row--over-after::after {
  content: ''; position: absolute; left: 6px; right: 6px; height: 3px;
  border-radius: var(--radius-xs); background: var(--brand);
  box-shadow: 0 0 6px rgba(15, 157, 143, .55);
  z-index: 2; pointer-events: none;
}
.cat-mgr-row--over-before::before { top: -2px; }
.cat-mgr-row--over-after::after { bottom: -2px; }
/* 表头：与行同一左右内边距，形成表格感 */
.cat-mgr-head {
  display: flex; align-items: center; gap: 10px;
  padding: 0 8px 6px; font-size: var(--fs-xs); color: var(--text-3);
}
.cat-mgr-hname { flex: 1; margin-left: 40px; }
.cat-mgr-hcount { width: 52px; text-align: right; }
.cat-mgr-hops { width: 40px; text-align: center; }
/* 条目数 = 预览开关：可点击、带箭头 */
.cat-mgr-count { cursor: pointer; min-width: 52px; text-align: right; }
.cat-mgr-count:hover { color: var(--brand); }
/* 预览区：缩进浅底，展示分类内未完成任务 */
.cat-mgr-preview {
  padding: 6px 8px 8px 48px; margin: -1px 0 2px;
  background: var(--gray-bg); border-radius: var(--radius-md); font-size: var(--fs-sm); color: var(--text-2);
  animation: mgr-preview-in .15s cubic-bezier(.2, .8, .2, 1);
}
.cat-mgr-preview__item { line-height: 22px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cat-mgr-preview__empty { color: var(--text-3); }
.cat-mgr-preview__more { color: var(--text-3); font-size: var(--fs-xs); }
.cat-mgr-drag { font-style: normal; color: var(--text-3); font-size: var(--fs-base); cursor: grab; flex-shrink: 0; }
.cat-mgr-name {
  flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap; cursor: text;
}
.cat-mgr-name:hover { color: var(--brand); }
.cat-mgr-count { font-style: normal; flex-shrink: 0; font-size: var(--fs-xs); color: var(--text-3); }
.cat-mgr-del {
  flex-shrink: 0; font-size: var(--fs-sm); color: var(--text-3);
  padding: 3px 8px; border-radius: var(--radius-sm); transition: all var(--dur-fast);
}
.cat-mgr-del:hover { color: var(--danger); background: var(--danger-soft); }
/* ============ 像素级对齐补丁（对照 构建产物 A / index.pretty.js）============ */

/* —— 1. 侧边栏搜索框：设计稿 .main-nav-search__input[scoped]
      185x36 padding-left:39px 字号13px 底#f5f4f5 边1px #e7e7e7 圆角5px focus 边var(--brand) —— */
.main-nav-search.sn-search {
  width: 100%; margin: 0 0 10px;
  background-color: #f5f4f5;
  border: 1px solid #e7e7e7;
  border-radius: var(--radius-sm);
  transition: border-color var(--dur-mid) cubic-bezier(.645,.045,.355,1);
}
.main-nav-search.sn-search:focus-within { border-color: var(--brand); }
.main-nav-search.sn-search .app-icon { flex-shrink: 0; }
/* 图标是 flex 子元素（非绝对定位），输入框无需再留 39px 左内边距，
   否则占位文字「搜索」会被推到中间、看起来没左对齐 */
.main-nav-search.sn-search input {
  height: 100%; width: 100%; min-width: 0;
  padding: 0 9px 0 0;
  font-weight: 400; font-size: var(--fs-md); line-height: 34px; color: var(--text-1);
}
.main-nav-search.sn-search input::placeholder { color: var(--text-4); }
/* 聚焦态：输入框自身不画 outline（默认矩形黑框与 5px 圆角容器不一致），统一由容器 focus-within 描边表达 */
.main-nav-search.sn-search input:focus,
.sn-search input:focus { outline: none; }
/* —— 1b. 侧边栏分类行直接操作：行尾垃圾桶（hover 显现）、拖拽排序指示、
      拖入底部回收站高亮；未分类为默认固定行，不参与拖拽/删除 —— */
.sn-cat-item { position: relative; }
.sn-cat-del {
  position: absolute; right: 8px; top: 50%; transform: translateY(-50%);
  font-size: var(--fs-md); color: var(--text-4); cursor: pointer;
  opacity: 0; transition: opacity var(--dur-fast), color var(--dur-fast);
}
.sn-cat-item:hover .sn-cat-del, .sn-cat-del:focus { opacity: 1; }
.sn-cat-del:hover { color: var(--danger); }
.sn-cat-item.dragging { opacity: .45; }
.sn-cat-item.drag-over-before { box-shadow: inset 0 2px 0 var(--brand); }
.sn-cat-item.drag-over-after { box-shadow: inset 0 -2px 0 var(--brand); }
.sn-cat-item { transition: background-color var(--dur-fast); }
.sn-cat-edit { min-width: 0; outline: none; }
/* —— 2. 导航行/分类行：设计稿 .sidebar-nav-item[scoped] 与
      .todo-category__item[scoped]：高36px 字号13px lh18 圆角5px
      hover rgba(233,237,237,.5)；激活 #e9eded
      注：设计稿行宽 220px（250 侧栏 - 2×15 总缩进）；本实现 .side-nav 已有
      14px 水平 padding，再叠 15px margin 会双重缩进（行宽仅 191px），
      故 margin 归零，总缩进 14px ≈ 设计稿 —— */
.sn-nav-item,
.sn-cat-item {
  height: 36px; margin: 0; padding: 0;
  color: var(--text-1); font-weight: 400; font-size: var(--fs-md); line-height: 18px;
  border-radius: var(--radius-sm);
}
/* 分类行对齐导航几何（含容器自带 10px 缩进）：圆点中心对齐导航图标中心(19)，文字起点对齐导航文字(40) */
.sn-cat-item { padding-left: var(--space-1); gap: var(--space-4); }
.sn-nav-item:hover { background-color: rgba(233,237,237,.5); }
.sn-cat-item:hover { background-color: rgba(233,237,237,.5); }
.side-nav .sn-nav-item.active,
.side-nav .sn-cat-item.active { background-color: #e9eded; color: var(--text-1); font-weight: 400; }
/* ============ 分类文件夹层级（设计稿 todo-category__folder 族） ============ */
.sn-cat-folder { font-weight: 500; position: relative; }
.sn-cat-folder .folder-toggle-icon {
  position: absolute; right: 6px; top: 50%; transform: translateY(-50%);
  font-size: var(--fs-2xs); color: var(--text-3); transition: transform var(--dur-mid) ease;
}
.sn-cat-child { margin-left: 0; padding-left: 25px; font-size: var(--fs-sm); color: var(--text-2); }
.sn-cat-child:hover { background-color: rgba(233,237,237,.3); }
.sn-cat-child .sn-dot { width: 8px; height: 8px; }
/* ============ 分类「＋新建」「⚙管理」行（设计稿） ============ */
.sn-cat-action { color: var(--text-2); font-size: var(--fs-md); }
.sn-cat-action .sn-action-ico {
  width: 20px; height: 20px; margin: 0 0 0 8px; display: inline-flex; align-items: center;
  justify-content: center; font-style: normal; font-size: var(--fs-md); color: var(--text-3);
}
.sn-cat-action .sn-action-ico.plus { color: var(--brand); font-weight: 700; }
.sn-cat-action:hover { color: var(--brand); }
.sn-account-trash.drag-over, .sn-cog-btn.drag-over { animation: trash-pulse .6s ease-in-out infinite; }
/* 分类名溢出保护：长名不顶飞绝对定位的删除按钮 */
.sn-cat-item .sn-cat-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* 管理分类弹窗：项目标记按钮选中态 */
.cat-mgr-del--on { color: var(--brand); }
.cat-mgr-del--on:hover { color: var(--brand-dark); background: var(--brand-light); }
/* —— 以下规则自 theme-dark.css 退回（选择器列表首支为浅色规则，不应集中到深色文件）—— */
.side-nav--collapsed .main-nav-search.sn-search, html[data-theme="dark"] .side-nav--collapsed .main-nav-search.sn-search { height: 40px; padding: 0; justify-content: center; background: transparent; border-color: transparent; }
/* (壳层跨组件深色规则已归位 theme-dark.css;组件自有 sn- 与 cat-mgr- 深色规则保留在本文件) */
/* 深色模式：侧边栏像素对齐补丁的深色对应值（防浅色硬编码破坏暗色） */
html[data-theme="dark"] .main-nav-search.sn-search {
  background-color: var(--gray-bg);
  border-color: var(--line-strong);
}
html[data-theme="dark"] .main-nav-search.sn-search:focus-within { border-color: var(--brand); }
html[data-theme="dark"] .main-nav-search.sn-search input { color: var(--text-1); }
html[data-theme="dark"] .main-nav-search.sn-search input::placeholder { color: var(--text-4); }
html[data-theme="dark"] .sn-nav-item,
html[data-theme="dark"] .sn-cat-item { color: var(--text-1); }
html[data-theme="dark"] .sn-nav-item:hover,
html[data-theme="dark"] .sn-cat-item:hover { background-color: rgba(255,255,255,.06); }
html[data-theme="dark"] .side-nav .sn-nav-item.active,
html[data-theme="dark"] .side-nav .sn-cat-item.active {
  background-color: var(--brand-light); color: var(--brand-bright, #35c2ae);
}
/* 侧栏用户菜单 */

/* 分类管理行 / 番茄计时器选项 */
html[data-theme="dark"] .cat-mgr-row { background: var(--gray-bg); }
/* 折叠态：搜索/天气退化为独立图标，深色背景下同样去掉框（否则暗色卡片底会露出"框还在"） */
html[data-theme="dark"] .side-nav--collapsed .main-nav-search.sn-search,
html[data-theme="dark"] .side-nav--collapsed .main-nav-search.sn-search { background: transparent; border-color: transparent; }
html[data-theme="dark"] .side-nav--collapsed .sn-weather,
html[data-theme="dark"] .side-nav--collapsed .sn-weather { background: transparent; }
html[data-theme="dark"] .cat-mgr-del--on:hover { background: rgba(15, 157, 143, .15); }

/* ========================= 搜索（SearchView）========================= */
.main-nav-search{position:relative;display:flex;align-items:center;justify-content:center;width:185px;height:36px;margin:0 0 8px}
/* 搜索页单一对齐轴：标题/搜索框/结果行同左缘(容器缘,原 12px 标题内缩与 4px 行内缩已清) */
.search-page .main-nav-search{margin:0}
.main-nav-search__input{box-sizing:border-box;width:185px;height:36px;padding:0;padding-right:26px;padding-left:39px;font-weight:400;font-size: var(--fs-md);background-color:#f5f4f5;border:1px solid #e7e7e7;border-radius: var(--radius-sm);outline:none;opacity:1;transition:border-color var(--dur-mid) cubic-bezier(.645,.045,.355,1)}
.main-nav-search__input::placeholder{color:var(--text-4)}
.main-nav-search__input:focus{border-color:var(--brand)}
.main-nav-search__icon{position:absolute;top:0;bottom:0;left:0;display:flex;align-items:center;justify-content:center;width:20px;height:20px;margin:auto 10px auto 10px}
.main-nav-search__icon:after{display:block;width:17px;height:17px;background:url('data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 16 16%22><circle cx=%228%22 cy=%228%22 r=%226%22 fill=%22%23ccc%22/></svg>') no-repeat 50%;background-size:contain;content:""}
.main-nav-search__clear{position:absolute;top:0;right:0;bottom:0;display:flex;align-items:center;justify-content:center;width:20px;height:20px;margin:auto 10px auto 10px;cursor:pointer}
/* 4. 通用按压反馈：所有可点按钮按下轻微缩放（搭配各自 transition） */
.el-button, .row-btn, button.mini, .sn-ico-btn, .grp-toggle-btn { transition: transform var(--dur-fast); }
.el-button:active, .row-btn:active, button.mini:active, .sn-ico-btn:active { transform: scale(.96); }
/* ============ 搜索框 __clear（设计稿 main-nav-search__clear） ============ */
.main-nav-search__clear {
  width: 18px; height: 18px; margin-right: 10px; cursor: pointer;
  display: flex; align-items: center; justify-content: center; flex-shrink: 0;
}
.main-nav-search__clear img { width: 12px; height: 12px; opacity: .55; }
.main-nav-search__clear:hover img { opacity: 1; }
/* ============ 分类区头部图标按钮（＋ 新建 / ⚙ 管理） ============ */
.sn-ico-btn {
  width: 22px; height: 22px; border: 0; background: none; border-radius: var(--radius-sm);
  display: inline-flex; align-items: center; justify-content: center;
  color: var(--text-3); cursor: pointer; padding: 0;
}
.sn-ico-btn:hover { color: var(--brand); background: var(--hover-bg); }
/* ============ 天气组件（侧边栏） ============ */
.sn-weather {
  display: flex; align-items: center; gap: 6px; padding: var(--space-2) 12px 8px 6px; /* 左6=图标重心对齐品牌标中心线(x≈25)：30px大标与16px小图标光学居中 */
  font-size: var(--fs-sm); color: var(--text-2); cursor: pointer; border-radius: var(--radius-md);
}
.sn-weather:hover { background: var(--gray-bg, #f5f5f5); }
.sn-weather:active { transform: scale(.97); }
/* 刷新动效反馈：拉取中天气图标旋转 + 数据轻微呼吸，结束自动停 */
.sn-weather.is-loading .w-icon {
  display: inline-block;
  animation: w-spin 1s linear infinite;
}
.sn-weather.is-loading .w-temp,
.sn-weather.is-loading .w-desc,
.sn-weather.is-loading .w-city {
  animation: w-breathe 1.2s ease-in-out infinite;
}
.sn-sec-foldable:hover .sn-ico-btn { opacity: 1; }
.sn-ico-btn { opacity: 0; transition: opacity var(--dur-fast); }
/* 标签等 clickable 分组头的 ＋ 也按同一逻辑 hover 显形 */
.sn-sec-head.clickable:hover .sn-ico-btn,
.sn-sec-head.clickable .sn-ico-btn:focus { opacity: 1; }
.sn-sec-foldable:hover .sn-ico-btn,
.sn-sec-foldable .sn-ico-btn:focus { opacity: 1; }
html[data-theme="dark"] .sn-ico-btn:hover { background: rgba(255,255,255,.06); }
html[data-theme="dark"] .main-nav-search__input { background-color: var(--gray-bg); border-color: var(--line-strong); }
html[data-theme="dark"] .main-nav-search__input:focus { border-color: var(--brand); }
@media (prefers-reduced-motion: reduce) {
  .sn-weather.is-loading .w-icon,
  .sn-weather.is-loading .w-temp,
  .sn-weather.is-loading .w-desc,
  .sn-weather.is-loading .w-city { animation: none; }
}
/* ---- K. 实现适配补充（设计稿无对应规则的最小 glue，均注明用途）---- */
/* 外层布局 .view-head 已承担快捷添加条；无独立 page__header 的视图在滚动区补回原 header 上内边距节奏 */
.page__main--flow-top{padding-top:18px}
/* 实现页容器：title 行 + 结果列表滚动区 */
.search-page{display:flex;flex-direction:column;height:100%;padding-top:10px}
.search-page .title{padding:0}
.search-page .result-list{flex:1;margin-top:10px;padding:0 0 16px;overflow-y:auto}
.search-page .result-list.empty{overflow:hidden;display:flex;flex-direction:column;align-items:center;justify-content:center}
.sn-sync { width: 18px; height: 18px; cursor: pointer; opacity: .75; }
.sn-sync:hover { opacity: 1; }
/* 同步完成态：原位变对勾（描边画出 + 轻缩放），1.4s 后自动还原为同步图标 */
.sn-sync--done { opacity: 1; animation: sn-sync-pop .22s cubic-bezier(.2, .8, .2, 1); }
.sn-sync--done path { stroke-dasharray: 1; stroke-dashoffset: 1; animation: sn-sync-draw .28s cubic-bezier(.2, .8, .2, 1) .05s forwards; }
.sn-navs { display: flex; flex-direction: column; margin-bottom: 6px; }
.sn-badge.warn { color: #fff; background: var(--danger-strong); }
/* 4.91:1 白字达标 */
/* 分节头折叠按钮：容器为普通 div（避免 role=button 内嵌真实按钮的 nested-interactive），按钮自身承载折叠语义 */
.sn-sec-toggle { background: none; border: none; padding: 0; font: inherit; font-weight: 600; color: var(--text-1); cursor: pointer; display: inline-flex; align-items: center; }
.sn-section { margin-top: var(--space-1); }
.sn-sec-head { cursor: pointer;
  display: flex; align-items: center; justify-content: space-between;
  font-size: var(--fs-md); color: var(--text-2); font-weight: 600; padding: 6px 2px 4px;
}
.sn-sec-head.clickable { cursor: pointer; }
.sn-sec-tools { display: flex; align-items: center; gap: var(--space-2); }
.sn-dot { width: 10px; height: 10px; border-radius: 50%; border: 2px solid transparent; flex-shrink: 0; }
.sn-dot.none { border-color: var(--text-4); background: var(--panel, #fff) !important; }
.sn-tags { margin-bottom: 6px; }
.sn-avatar {
  width: 26px; height: 26px; border-radius: var(--radius-md); flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  color: #fff; font-size: var(--fs-md); font-weight: 600; line-height: 1;

}
/* 更新就绪红点:挂在设置齿轮右上角(展开态/折叠态共用),配合 updater 全局 toast 提示退出即装 */
.sn-upd-dot { position: absolute; top: 2px; right: 2px; width: 7px; height: 7px; border-radius: 50%;
  background: var(--danger-strong); box-shadow: 0 0 0 2px var(--panel, #fff); pointer-events: none; }
/* 放大镜字形画在视框左上角，折叠态无输入框衬托时视觉偏左，向中心补偿 */
.sn-collapsed-foot { margin-top: auto; display: none; padding: 8px 0 10px; }
.sn-expand-hint { position: absolute; right: 0; top: 50%; transform: translateY(-50%); width: 18px; height: 44px;
  border: 0; padding: 0; cursor: pointer; display: flex; align-items: center; justify-content: center;
  color: var(--text-2); background: var(--gray-bg, #f5f5f5); border-radius: var(--radius-pill) 0 0 var(--radius-pill); /* 圆弧朝栏体内(用户定稿：与展开态把手互为翻转) */
  opacity: 0; transition: opacity var(--dur-fast), background var(--dur-fast), color var(--dur-fast); z-index: 5; }
.sn-expand-hint:hover { background: var(--brand-light, #e2f4f1); color: var(--brand); }
.sn-collapse-hint { position: absolute; right: 0; top: 50%; transform: translateY(-50%); width: 18px; height: 44px;
  border: 0; padding: 0; cursor: pointer; display: flex; align-items: center; justify-content: center;
  color: var(--text-2); background: var(--gray-bg, #f5f5f5); border-radius: var(--radius-pill) 0 0 var(--radius-pill); /* 高亮区左右翻转(用户定稿)：与折叠态把手同向 */
  opacity: 0; transition: opacity var(--dur-fast), background var(--dur-fast), color var(--dur-fast); z-index: 5; }
.sn-collapse-hint:hover { background: var(--brand-light, #e2f4f1); color: var(--brand); }
/* 缺 align-items 时 svg 顶格，高亮格与图标错位 12px */
.sn-cog-btn { background: none; border: none; color: var(--text-2); cursor: pointer; padding: 8px; border-radius: var(--radius-md); display: flex; position: relative; }
.sn-cog-btn:hover { background: var(--hover-bg, #f5f5f5); color: var(--brand); }
.grp-toggle-btn:hover { color: var(--brand); }
.w-icon { font-size: 16px; font-style: normal; }
.w-temp { font-size: var(--fs-lg); font-weight: 700; color: var(--text-1); }
.w-desc { color: var(--text-3); }
.w-city { font-size: var(--fs-xs); color: var(--text-3); }
.ds-cal-pop {
  position: absolute; top: 100%; left: auto; right: 6px; z-index: var(--z-pop); margin-top: var(--space-1);
  background: var(--panel, #fff); border-radius: var(--radius-lg); box-shadow: var(--shadow-pop);
  padding: 10px 12px; min-width: 240px;
}
.sn-fold-arrow {
  display: inline-flex; transition: transform var(--dur-mid) ease; color: var(--text-3); font-style: normal;
}
.sn-fold-arrow.open { transform: rotate(0deg); }
.sn-fold-arrow:not(.open) { transform: rotate(-90deg); }
.sn-cog-btn.drag-ready { border-style: dashed; }


</style>
