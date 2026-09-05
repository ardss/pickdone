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
      <input ref="searchInput" :value="$store.state.todo.search" :placeholder="$t('statsG.SideNav.searchPlaceholder')" spellcheck="false" autocomplete="false"
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
      const st = this.$store.state.settings
      let list = NAV_ORDER
      // Developer mode is the master gate: unfinished/structural experiments only surface when it is on
      if (!st.developerMode) list = list.filter(n => n !== 'todo-list-today-x')
      if (!st.developerMode || !st.showHabitModule) list = list.filter(n => n !== 'todo-list-habit')
      if (!st.developerMode || !st.showProjectsModule) list = list.filter(n => n !== 'todo-list-projects')
      return list
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
      if (w && this.$route.name !== 'todo-list-search') this.go('todo-list-search')
      if (!w && this.$route.name === 'todo-list-search') this.$router.back()
    },
    clearSearch () {
      this.$store.commit('todo/setSearch', '')
      if (this.$route.name === 'todo-list-search') this.$router.back()
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
