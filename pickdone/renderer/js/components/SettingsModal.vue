<template>

  <div class="modal-container modal-container--settings" @click="maskClickHide">
    <div class="modal-tablecloth modal-tablecloth--body" @click="maskClickHide">
      <div class="modal modal--settings modal--settings-center" role="dialog" aria-modal="true" :aria-label="$t('statsE.SettingsModal.settingsTitle')" @keydown.esc="close">
        <div class="modal__header modal__header--header-no-padding">
          <el-tabs v-model="tab" class="setting_tabs" tab-position="left">
            <el-tab-pane v-for="t in tabs" :key="t[0]" :label="t[1]" :name="t[0]"/>
          </el-tabs>
          <button type="button" class="modal__close close-x" :title="$t('statsE.SettingsModal.closeBtn')" :aria-label="$t('statsE.SettingsModal.closeBtn')" @click="close"></button>
        </div>

        <div class="modal__body modal__body--body-no-padding settings-modal-body">
          <!-- Settings search: filter across tabs (convention aligned with VS Code/TickTick) -->
          <div class="settings-search">
            <app-icon name="search" :size="14"/>
            <input type="text" class="settings-search__input" :placeholder="$t('statsH.SettingsModal.searchSettings')"
                   :aria-label="$t('statsH.SettingsModal.searchSettings')" v-model="searchQ" @input="applySearchFilter"/>
            <button v-if="searchQ" type="button" class="settings-search__clear close-x close-x--sm" :aria-label="$t('statsE.SettingsModal.closeBtn')" @click="clearSearch"></button>
          </div>
          <div v-if="searchEmpty" class="settings-search-empty">{{ $t('statsH.SettingsModal.searchEmpty') }}</div>

          <!-- General -->
          <div v-show="searching || tab==='general'" class="tab-panel">
            <div class="form">
              <div class="form-label">{{ $t('statsE.SettingsModal.accountSection') }}</div>
              <div class="form-item"><span class="form-item__label">{{ $t('statsE.SettingsModal.usernameLabel') }}</span>
                <div class="form-item__control">
                  <el-input size="small" class="ctl-md" maxlength="20" :aria-label="$t('statsE.SettingsModal.usernameLabel')"
                            :placeholder="$t('statsE.SettingsModal.enterToSaveHint')"
                            v-model="nameDraft" @keyup.enter="saveName" @blur="saveName"/>
                </div></div>
            </div>
            <div class="form">
              <div class="form-label">{{ $t('statsE.SettingsModal.basicSection') }}</div>
              <div class="form-item"><span class="form-item__label">{{ $t('statsE.SettingsModal.launchAtStartupLabel') }}</span><div class="form-item__control"><el-switch :model-value="st.runWhenComputerStart" @change="v=>set({runWhenComputerStart:v})"/></div></div>
              <div class="form-item"><span class="form-item__label">{{ $t('statsE.SettingsModal.hideOnLaunchLabel') }}</span><div class="form-item__control"><el-switch :model-value="st.hideMainWindowOnStartup" @change="v=>set({hideMainWindowOnStartup:v})"/></div></div>
              <div class="form-item"><span class="form-item__label">{{ $t('statsE.SettingsModal.closeToTrayLabel') }}</span><div class="form-item__control"><span class="tip">{{ $t('statsE.SettingsModal.offlineBuiltin') }}</span></div></div>
              <div class="form-item"><span class="form-item__label">{{ $t('statsE.SettingsModal.hardwareAccelLabel') }}</span><div class="form-item__control"><el-switch :model-value="st.enableHardwareAcceleration" @change="v=>set({enableHardwareAcceleration:v})"/></div></div>
              <div class="form-item"><span class="form-item__label">{{ $t('statsE.SettingsModal.parentChecksSubtasksLabel') }}</span><div class="form-item__control"><el-switch :model-value="st.isCompleteWithSubtasks" @change="v=>set({isCompleteWithSubtasks:v})"/></div></div>
              <div class="form-item"><span class="form-item__label">{{ $t('statsE.SettingsModal.languageLabel') }}</span>
                <div class="form-item__control">
                  <el-select size="small" class="ctl-md" :model-value="getLocale()" @change="onLangChange" :aria-label="$t('statsE.SettingsModal.languageLabel')">
                    <el-option v-for="l in langOptions" :key="l[0]" :label="l[1]" :value="l[0]"/>
                  </el-select>
                </div></div>
            </div>
            <div class="form">
              <div class="form-label">{{ $t('statsH.Onboarding.replayLabel') }}</div>
              <div class="form-item"><span class="form-item__label">{{ $t('statsH.Onboarding.replayLabel2') }}</span>
                <div class="form-item__control"><button class="mini" @click="replayOnboarding">{{ $t('statsH.Onboarding.replayBtn') }}</button></div></div>
            </div>
            <div class="form">
              <div class="form-label">{{ $t('statsE.SettingsModal.defaultsSection') }}</div>
              <div class="form-item"><span class="form-item__label">{{ $t('statsE.SettingsModal.newTasksGoToLabel') }}</span>
                <div class="form-item__control">
                  <el-select size="small" :model-value="st.newTodoDefaultSort" @change="v=>set({newTodoDefaultSort:v})" class="ctl-sm">
                    <el-option v-for="o in enumOptions('newTodoDefaultSort')" :key="o.v" :label="$t(o.l)" :value="o.v"/>
                  </el-select>
                </div></div>
              <div class="form-item"><span class="form-item__label">{{ $t('statsE.SettingsModal.defaultCategoryLabel') }}</span>
                <div class="form-item__control">
                  <el-select size="small" :model-value="st.newTodoCategoryId" @change="v=>set({newTodoCategoryId:v})" class="ctl-md">
                    <el-option :label="$t('statsE.SettingsModal.noCategoryOption')" :value="0"/>
                    <el-option v-for="c in $store.getters['category/roots']" :key="c.categoryId" :label="c.categoryName" :value="c.categoryId"/>
                  </el-select>
                </div></div>
              <div class="form-item"><span class="form-item__label">{{ $t('statsE.SettingsModal.descLinesLabel') }}</span>
                <div class="form-item__control"><el-slider class="ctl-md" :min="1" :max="6" v-model="localDescLines" :format-tooltip="v => $t('statsE.SettingsModal.descLinesUnit', { n: v })" @change="v=>set({todoDescriptionDisplayLineNumber:v})" :aria-label="$t('statsE.SettingsModal.descLinesLabel')"/></div></div>
              <div class="form-item"><span class="form-item__label">{{ $t('statsE.SettingsModal.notifyDurationLabel') }}</span>
                <div class="form-item__control">
                  <el-radio-group size="small" :model-value="String(st.notificationTimeoutInterval)" @change="v=>set({notificationTimeoutInterval:+v})" :aria-label="$t('statsE.SettingsModal.notifyDurationLabel')">
                    <el-radio-button value="30000">{{ $t('statsE.SettingsModal.intervalThirtySec') }}</el-radio-button>
                    <el-radio-button value="120000">{{ $t('statsE.SettingsModal.intervalTwoMin') }}</el-radio-button>
                    <el-radio-button value="300000">{{ $t('statsE.SettingsModal.intervalFiveMin') }}</el-radio-button>
                  </el-radio-group>
                </div></div>
              <div class="form-item"><span class="form-item__label">{{ $t('statsE.SettingsModal.maxRepeatGroupLabel') }}</span>
                <div class="form-item__control">
                  <el-radio-group size="small" :model-value="st.maxRepeat" @change="v=>set({maxRepeat:v})" :aria-label="$t('statsE.SettingsModal.maxRepeatGroupLabel')">
                    <el-radio-button v-for="o in ['1','2','3','5']" :key="o" :value="o">{{ o }}</el-radio-button>
                  </el-radio-group>
                </div></div>
            </div>
            <div class="form">
              <div class="form-label">{{ $t('statsE.SettingsModal.formTaskList') }}</div>
              <div class="form-item"><span class="form-item__label">{{ $t('statsE.SettingsModal.mainSortModeLabel') }}</span>
                <div class="form-item__control">
                  <el-select size="small" :model-value="st.sortMode" @change="v=>set({sortMode:v})" class="ctl-md" :aria-label="$t('statsE.SettingsModal.mainSortModeLabel')">
                    <el-option v-for="o in enumOptions('sortMode')" :key="o.v" :label="$t(o.l)" :value="o.v"/>
                  </el-select>
                </div></div>
              <div class="form-item"><span class="form-item__label">{{ $t('statsE.SettingsModal.showCompletedLabel') }}</span><div class="form-item__control"><el-switch :model-value="st.showComplete" @change="v=>{set({showComplete:v});$store.dispatch('todo/computeViews')}"/></div></div>
              <div class="form-item"><span class="form-item__label">{{ $t('statsE.SettingsModal.showNoDateLabel') }}</span><div class="form-item__control"><el-switch :model-value="st.showNoDate" @change="v=>{set({showNoDate:v});$store.dispatch('todo/computeViews')}"/></div></div>
              <div class="form-item"><span class="form-item__label">{{ $t('statsE.SettingsModal.keepExpiredCompletedLabel') }}</span>
                <div class="form-item__control">
                  <el-select size="small" :model-value="st.expiredCompletedTodoRange" @change="v=>{set({expiredCompletedTodoRange:v});$store.dispatch('todo/computeViews')}" class="ctl-sm" :aria-label="$t('statsE.SettingsModal.keepExpiredCompletedLabel')">
                    <el-option v-for="o in enumOptions('expiredCompletedTodoRange')" :key="o.v" :label="$t(o.l)" :value="o.v"/>
                  </el-select>
                </div></div>
              <div class="form-item"><span class="form-item__label">{{ $t('statsE.SettingsModal.keepExpiredUncompletedLabel') }}</span>
                <div class="form-item__control">
                  <el-select size="small" :model-value="st.expiredUncompletedTodoRange" @change="v=>{set({expiredUncompletedTodoRange:v});$store.dispatch('todo/computeViews')}" class="ctl-sm" :aria-label="$t('statsE.SettingsModal.keepExpiredUncompletedLabel')">
                    <el-option v-for="o in enumOptions('expiredUncompletedTodoRange')" :key="o.v" :label="$t(o.l)" :value="o.v"/>
                  </el-select>
                </div></div>
            </div>
            <div class="form">
              <div class="form-label">{{ $t('statsE.SettingsModal.sidebarWeatherSection') }}</div>
              <div class="form-item"><span class="form-item__label">{{ $t('statsE.SettingsModal.showWeatherLabel') }}</span>
                <div class="form-item__control">
                  <el-switch :model-value="st.weatherEnabled" @change="v=>set({weatherEnabled:v})"/>
                  <span class="tip">{{ $t('statsE.SettingsModal.weatherPrivacyDesc') }}</span>
                </div></div>
              <div class="form-item" v-if="st.weatherEnabled"><span class="form-item__label">{{ $t('statsE.SettingsModal.weatherDataSourceLabel') }}</span>
                <div class="form-item__control">
                  <el-select size="small" :model-value="st.weatherSource||'open-meteo'" @change="v=>set({weatherSource:v})" class="ctl-md">
                    <el-option v-for="o in enumOptions('weatherSource')" :key="o.v" :label="o.v === 'wttr' ? o.l : $t(o.l)" :value="o.v"/>
                  </el-select>
                  <span class="tip">{{ $t('statsE.SettingsModal.weatherFreeServicesDesc') }}</span>
                </div></div>
              <div class="form-item" v-if="st.weatherEnabled"><span class="form-item__label">{{ $t('statsE.SettingsModal.cityLabel') }}</span>
                <div class="form-item__control">
                  <el-cascader size="small" class="ctl-lg" :options="cityOptions" filterable clearable
                               :placeholder="$t('statsE.SettingsModal.cityAutoLocateHint')" :model-value="cityPath" @change="onCityPick"/>
                  <span class="tip">{{ $t('statsE.SettingsModal.provinceCityDesc') }}</span>
                </div></div>
            </div>
            <div class="form">
              <div class="form-label">{{ $t('statsE.SettingsModal.securityPrivacySection') }}</div>
              <div class="form-item"><span class="form-item__label">{{ $t('statsE.SettingsModal.securityLockLabel') }}</span><div class="form-item__control"><el-switch :model-value="st.enableSecurityLock" @change="v=>set({enableSecurityLock:v})"/></div></div>
              <div class="form-item" v-if="st.enableSecurityLock"><span class="form-item__label">{{ $t('statsE.SettingsModal.lockPasswordLabel') }}</span>
                <div class="form-item__control">
                  <el-input size="small" class="ctl-md" show-password :aria-label="$t('statsE.SettingsModal.lockPasswordLabel')" :model-value="st.securityLockPassword" @change="saveLockPassword"/>
                  <button class="mini" @click="setLockTest">{{ $t('statsE.SettingsModal.lockNowBtn') }}</button>
                </div></div>
            </div>
            <!-- Developer mode sinks to the bottom and is de-emphasized (user-finalized): a low-frequency internal switch, one line of hint suffices -->
            <div class="form">
              <div class="form-label">{{ $t('statsE.SettingsModal.devSection') }}</div>
              <div class="form-item"><span class="form-item__label">{{ $t('statsE.SettingsModal.sDev') }}</span><div class="form-item__control"><el-switch :model-value="st.developerMode === true" @change="v=>set({developerMode:v})"/></div></div>
              <div v-show="st.developerMode === true">
                <div class="form-item"><span class="form-item__label">{{ $t('statsE.SettingsModal.habitExperimentalLabel') }}</span><div class="form-item__control"><el-switch :model-value="st.showHabitModule !== false" @change="v=>set({showHabitModule:v})"/></div></div>
                <div class="form-item"><span class="form-item__label">{{ $t('statsE.SettingsModal.sProjects') }}</span><div class="form-item__control"><el-switch :model-value="st.showProjectsModule === true" @change="v=>set({showProjectsModule:v})"/></div></div>
              </div>
              <div class="form-item"><span class="form-item__label"></span><div class="form-item__control"><span class="tip">{{ $t('statsE.SettingsModal.devHint') }}</span></div></div>
            </div>
          </div>

          <!-- Appearance -->
          <div v-show="searching || tab==='appearance'" class="tab-panel">
            <div class="form">
              <div class="form-item"><span class="form-item__label">{{ $t('statsE.SettingsModal.paperPlaneToggleLabel') }}</span>
                <div class="form-item__control">
                  <el-switch :model-value="st.taskFlyAnimation !== false" @change="v=>set({taskFlyAnimation:v})"/>
                  <span class="tip" style="margin-left:8px">{{ $t('statsE.SettingsModal.paperPlaneDesc') }}</span>
                </div></div>
              <div class="form-label">{{ $t('statsE.SettingsModal.listDisplaySection') }}</div>
              <div class="form-item"><span class="form-item__label">{{ $t('statsE.SettingsModal.colorModeLabel') }}</span>
                <div class="form-item__control">
                  <el-radio-group size="small" :model-value="st.colorMode||'light'" @change="v=>set({colorMode:v})">
                    <el-radio-button v-for="o in enumOptions('colorMode')" :key="o.v" :value="o.v">{{ $t(o.l) }}</el-radio-button>
                  </el-radio-group>
                </div></div><div class="form-item"><span class="form-item__label">{{ $t('statsE.SettingsModal.checkboxFollowColorLabel') }}</span><div class="form-item__control"><el-switch :model-value="st.isCompleteCheckboxColorFollow" @change="v=>set({isCompleteCheckboxColorFollow:v})"/></div></div>
              <div class="form-item"><span class="form-item__label">{{ $t('statsE.SettingsModal.subtaskProgressLabel') }}</span><div class="form-item__control"><el-switch :model-value="st.isShowSubTask" @change="v=>set({isShowSubTask:v})"/></div></div>
              <div class="form-label">{{ $t('statsE.SettingsModal.retentionSection') }}</div>
              <div class="form-item"><span class="form-item__label">{{ $t('statsE.SettingsModal.upcomingRangeLabel') }}</span>
                <div class="form-item__control">
                  <el-select size="small" :model-value="st.upcomingTodoRange" @change="v=>{set({upcomingTodoRange:v});$store.dispatch('todo/computeViews')}" class="ctl-sm" :aria-label="$t('statsE.SettingsModal.upcomingRangeLabel')">
                    <el-option v-for="o in enumOptions('upcomingTodoRange')" :key="o.v" :label="$t(o.l)" :value="o.v"/>
                  </el-select>
                </div></div>
            </div>
          </div>

          <!-- Calendar -->
          <div v-show="searching || tab==='calendar'" class="tab-panel">
            <div class="form">
              <div class="form-label">{{ $t('statsE.SettingsModal.calendarDisplaySection') }}</div>
              <div class="form-item"><span class="form-item__label">{{ $t('statsE.SettingsModal.weekStartLabel') }}</span>
                <div class="form-item__control">
                  <el-radio-group size="small" :model-value="st.weekStartDay" @change="v=>set({weekStartDay:v})">
                    <!-- value must be the stable enum mon/sun: it was once bound to the translated label itself, storing "Monday" under the English UI -->
                    <el-radio-button value="mon">{{ $t('statsE.SettingsModal.weekStartMonday') }}</el-radio-button><el-radio-button value="sun">{{ $t('statsE.SettingsModal.weekStartSunday') }}</el-radio-button>
                  </el-radio-group>
                </div></div>
              <div class="form-item"><span class="form-item__label">{{ $t('statsE.SettingsModal.holidayBadgesLabel') }}</span><div class="form-item__control"><el-switch :model-value="st.showHolidayMarkers" @change="v=>set({showHolidayMarkers:v})"/></div></div>
              <div class="form-item"><span class="form-item__label">{{ $t('statsE.SettingsModal.blurScheduleLabel') }}</span><div class="form-item__control"><el-switch :model-value="st.isShowCalendarPrivacyMode" @change="v=>set({isShowCalendarPrivacyMode:v})"/></div></div>
              <div class="form-item"><span class="form-item__label">{{ $t('statsE.SettingsModal.dimUncompletedLabel') }}</span><div class="form-item__control"><el-switch :model-value="st.isCalendarDimUncompleted" @change="v=>{set({isCalendarDimUncompleted:v});$store.dispatch('todo/computeViews')}"/></div></div>
              <div class="form-item"><span class="form-item__label">{{ $t('statsE.SettingsModal.fontSizeLabel') }}</span>
                <div class="form-item__control">
                  <el-radio-group size="small" :model-value="st.calendarFontSize" @change="v=>set({calendarFontSize:v})">
                    <el-radio-button v-for="f in enumOptions('calendarFontSize')" :key="f.v" :value="f.v">{{ $t(f.l) }}</el-radio-button>
                  </el-radio-group>
                </div></div>
            </div>
          </div>

          <!-- Shortcuts: key capture controls -->
          <div v-show="searching || tab==='shortcuts'" class="tab-panel">
            <div class="form">
              <div class="form-label">{{ $t('statsE.SettingsModal.shortcutsSection') }}</div>
              <template v-for="sc in shortcutDefs" :key="sc.key">
                <div class="form-item">
                  <span class="form-item__label">{{ sc.label }}</span>
                  <div class="form-item__control">
                    <button type="button" class="sc-capture" :class="{listening: capturing===sc.key, conflict: hasConflict(sc.key)}"
                            tabindex="0"
                            @click="startCapture(sc.key)" @blur="onCaptureBlur">
                      <span class="sc-kbd">{{ capturing===sc.key ? $t('statsE.SettingsModal.scPressKey') : formatShortcut(shortcutForm[sc.key]) }}</span>
                    </button>
                    <span v-if="capturing!==sc.key" class="tip">{{ $t('statsE.SettingsModal.scClickToEdit') }}</span>
                  </div>
                </div>
              </template>
              <div class="form-item" v-if="capturing"><span class="form-item__hint">{{ $t('statsE.SettingsModal.scCaptureHint') }}</span></div>
              <div class="form-item"><span class="form-item__label"></span>
                <div class="form-item__control"><button class="primary mini-lg" @click="saveShortcuts">{{ $t('statsE.SettingsModal.saveShortcutBtn') }}</button></div></div>
              <div class="form-item"><span class="form-item__label"></span>
                <div class="form-item__control"><button class="mini" @click="resetShortcuts">{{ $t('statsE.SettingsModal.resetDefaultBtn') }}</button></div></div>
            </div>
          </div>

          <!-- Pomodoro -->
          <div v-show="searching || tab==='tomato'" class="tab-panel">
            <div class="form">
              <div class="form-label">{{ $t('statsE.SettingsModal.pomodoroSection') }}</div>
              <div class="form-item"><span class="form-item__label">{{ $t('statsE.SettingsModal.completionNotifyLabel') }}</span><div class="form-item__control"><el-switch :model-value="sEnableNoti" @change="setTomatoNoti"/></div></div>
              <div class="form-item"><span class="form-item__label">{{ $t('statsE.SettingsModal.completionSoundLabel') }}</span>
                <div class="form-item__control">
                  <el-select size="small" :model-value="st.completeSound || 'confirm1'" @change="v=>set({completeSound:v})" class="ctl-md">
                    <el-option v-for="snd in confirmSoundOptions" :key="snd.id" :label="$t(snd.labelKey)" :value="snd.id"/>
                  </el-select>
                  <button class="mini" @click="previewCompleteSound">{{ $t('statsE.SettingsModal.soundPreviewBtn') }}</button>
                </div></div>
              <div class="form-item"><span class="form-item__label">{{ $t('statsE.SettingsModal.dailyGoalLabel') }}</span>
                <div class="form-item__control">
                  <el-input-number size="small" class="ctl-sm" :controls="false" :min="1" :max="50" :model-value="Number(st.dailyTomatoTarget)||8" :aria-label="$t('statsE.SettingsModal.dailyGoalLabel')"
                                   @change="v=>set({dailyTomatoTarget:v})"/>
                  <span class="tip">{{ $t('statsE.SettingsModal.harvestGoalHint') }}</span>
                </div></div>
              <div class="form-item"><span class="form-item__label">{{ $t('statsE.SettingsModal.focusLengthLabel') }}</span>
                <div class="form-item__control">
                  <el-input-number size="small" class="ctl-sm" :min="5" :max="180" :model-value="Number(st.tomatoTime)||25" :aria-label="$t('statsE.SettingsModal.focusLengthLabel')"
                                   @change="v=>set({tomatoTime:v})"/>
                  <span class="tip">{{ $t('statsE.SettingsModal.panelSyncHint') }}</span>
                </div></div>
              <div class="form-item"><span class="form-item__label">{{ $t('statsE.SettingsModal.breakLengthLabel') }}</span>
                <div class="form-item__control">
                  <el-input-number size="small" class="ctl-sm" :min="1" :max="60" :model-value="Number(st.restTime)||5" :aria-label="$t('statsE.SettingsModal.breakLengthLabel')"
                                   @change="v=>set({restTime:v})"/>
                </div></div>
              <div class="form-item"><span class="form-item__label">{{ $t('statsE.SettingsModal.floatingWindowLabel') }}</span><div class="form-item__control"><el-switch :model-value="st.enableTomatoFloating !== false" @change="setTomatoFloat"/></div></div>
              <div class="form-item"><span class="form-item__label">{{ $t('statsE.SettingsModal.customSoundLabel') }}</span>
                <div class="form-item__control">
                  <button class="mini" @click="pickCustomAudio">{{isCustomNoise?$t('statsE.SettingsModal.selectedCount'):$t('statsH.SettingsModal.chooseAudio')}}</button>
                  <span v-if="customAudioLabel" class="tip">{{customAudioLabel}}</span>
                </div></div>
              <div class="form-item"><span class="form-item__label">{{ $t('statsE.SettingsModal.noiseVolumeLabel') }}</span>
                <div class="form-item__control">
                  <el-slider size="small" class="ctl-sm" :min="0" :max="100" :model-value="noiseVolumePct" :aria-label="$t('statsE.SettingsModal.noiseVolumeLabel')"
                             @change="v=>set({whiteNoiseVolume:+v/100})"/>
                  <span class="tip">{{ noiseVolumePct }}%</span>
                </div></div>
              <div class="form-item"><span class="form-item__label"></span>
                <div class="form-item__control"><button class="mini" @click="$store.commit('ui/toggleTomatoPanel', true)">{{ $t('statsE.SettingsModal.openPomodoroPanelBtn') }}</button></div></div>
            </div>
          </div>

          <!-- Data management -->
          <div v-show="searching || tab==='about'" class="tab-panel">
            <div class="form">
              <div class="form-label">{{ $t('statsE.SettingsModal.feedbackAboutSection') }}</div>
              <div class="form-item"><span class="form-item__label">{{ $t('update.current') }}</span>
                <div class="form-item__control">
                  <span class="upd-version" v-if="updVersion">v{{ updVersion }}</span>
                  <button class="mini" v-if="updActive" :disabled="updStatus === 'checking' || updStatus === 'downloading'" @click="checkUpdate">{{ $t('update.checkNow') }}</button>
                  <span v-if="updStatus === 'downloading'" class="upd-hint">{{ $t('update.downloading') }} {{ updPercent }}%</span>
                  <span v-else-if="updStatus === 'available'" class="upd-hint">{{ $t('update.available') }} v{{ updNewVersion }}</span>
                  <button v-if="updStatus === 'available'" class="mini" @click="downloadNow">{{ $t('update.downloadNow') }}</button>
                  <button v-else-if="updStatus === 'ready'" class="primary mini-lg" @click="restartToUpdate">{{ $t('update.restartNow') }}</button>
                  <button class="mini" v-if="!updActive" @click="openReleases">{{ $t('update.openReleases') }}</button>
                </div></div>
              <div class="form-item" v-if="updActive"><span class="form-item__label">{{ $t('update.autoDownload') }}</span>
                <div class="form-item__control"><el-switch :model-value="st.autoDownloadUpdates !== false" @change="v=>set({autoDownloadUpdates:v})"/></div></div>
              <div class="form-item"><span class="form-item__label">{{ $t('statsE.SettingsModal.feedbackLabel') }}</span>
                <div class="form-item__control"><button class="mini" @click="feedback">{{ $t('statsE.SettingsModal.feedbackChannelsLabel') }}</button></div></div>
              <div class="form-item"><span class="form-item__label">{{ $t('statsH.SettingsModal.logsLabel') }}</span>
                <div class="form-item__control"><button class="mini" @click="openLogsDir">{{ $t('statsH.SettingsModal.openLogsDir') }}</button></div></div>
            </div>
            <div class="form">
              <div class="form-item"><span class="form-item__label">{{ $t('statsE.SettingsModal.aboutLabel') }}</span>
                <div class="form-item__control"><span class="tip">{{ $t('statsE.SettingsModal.aboutLead', { v: appVersion }) }}</span></div></div>
              <div class="form-item"><span class="form-item__label">{{ $t('statsE.SettingsModal.aboutSiteLabel') }}</span>
                <div class="form-item__control">
                  <button class="mini" @click="openOfficialSite">{{ $t('statsE.SettingsModal.aboutSiteBtn') }}</button>
                  <button class="mini" @click="openReleases">GitHub</button>
                </div></div>
              <div class="form-item"><span class="form-item__label"></span>
                <div class="form-item__control"><span class="tip">{{ $t('statsE.SettingsModal.aboutPrivacy') }}</span></div></div>
            </div>
          </div>
          <div v-show="searching || tab==='data'" class="tab-panel">
            <div class="form">
              <div class="form-label">{{ $t('statsE.SettingsModal.autoBackupSection') }}</div>
              <div class="form-item"><span class="form-item__label">{{ $t('statsE.SettingsModal.autoBackupLabel') }}</span><div class="form-item__control"><el-switch :model-value="st.autoBackupEnabled !== false" @change="v=>set({autoBackupEnabled:v})"/></div></div>
              <div class="form-item"><span class="form-item__label">{{ $t('statsE.SettingsModal.backupIntervalLabel') }}</span>
                <div class="form-item__control">
                  <el-radio-group size="small" :model-value="String(st.autoBackupIntervalMin || 30)" @change="v=>set({autoBackupIntervalMin:+v})" :aria-label="$t('statsE.SettingsModal.backupIntervalLabel')">
                    <el-radio-button v-for="o in ['10','30','60','180','360']" :key="o" :value="o">{{ (Number(o)>=60 ? (Number(o)/60)+$t('statsE.SettingsModal.hoursUnit') : $t('statsH.SettingsModal.minutesUnit', { n: o })) }}</el-radio-button>
                  </el-radio-group>
                </div></div>
              <div class="form-item"><span class="form-item__label">{{ $t('statsE.SettingsModal.recentCopiesLabel') }}</span>
                <div class="form-item__control">
                  <el-select size="small" :model-value="String(st.autoBackupKeep || 10)" @change="v=>set({autoBackupKeep:+v})" class="ctl-sm">
                    <el-option v-for="o in ['5','10','20','30']" :key="o" :label="o+$t('statsE.SettingsModal.copiesUnit')" :value="o"/>
                  </el-select>
                </div></div>
              <div class="form-item"><span class="form-item__label">{{ $t('statsE.SettingsModal.autoPurgeBinLabel') }}</span>
                <div class="form-item__control">
                  <el-radio-group size="small" :model-value="String(st.recycleBinAutoDeleteDays)" @change="v=>set({recycleBinAutoDeleteDays:+v})" :aria-label="$t('statsE.SettingsModal.autoPurgeBinLabel')">
                    <el-radio-button v-for="o in [7,15,30,60,90,0]" :key="o" :value="String(o)">{{ o===0 ? $t('statsH.SettingsModal.never') : $t('statsH.SettingsModal.dayUnit', { n: o }) }}</el-radio-button>
                  </el-radio-group>
                </div></div>
              <div class="form-item"><span class="form-item__label">{{ $t('statsE.SettingsModal.backupLocationLabel') }}</span>
                <div class="form-item__control">
                  <span class="tip">{{ backupDirDisplay }}</span>
                  <button class="mini" @click="pickBackupDir">{{ $t('statsE.SettingsModal.changeBtn') }}</button>
                  <button v-if="st.backupDir" class="mini" @click="resetBackupDir">{{ $t('statsE.SettingsModal.resetDefaultBtn') }}</button>
                </div></div>
              <div class="form-item"><span class="form-item__label">{{ $t('statsE.SettingsModal.backUpNowLabel') }}</span>
                <div class="form-item__control">
                  <button class="mini" @click="runAutoBackupNow">{{ $t('statsE.SettingsModal.autoBackUpNowBtn') }}</button>
                  <span class="tip">{{ autoBackupLastAt ? $t('statsE.SettingsModal.lastRunPrefix') + dfmt(autoBackupLastAt) : $t('statsH.SettingsModal.notRunYet') }} · {{ $t('statsH.SettingsModal.backupRetentionTip') }}</span>
                </div></div>
            </div>
            <div class="form">
              <div class="form-label">{{ $t('statsE.SettingsModal.dataManagementSection') }}</div>
              <div class="form-item"><span class="form-item__label">{{ $t('statsE.SettingsModal.exportExcelLabel') }}</span>
                <div class="form-item__control"><button class="primary mini-lg" :disabled="exporting" @click="exportXlsx">{{ $t('statsE.SettingsModal.exportXlsxBtn') }}</button></div></div>
              <div class="form-item"><span class="form-item__label">{{ $t('statsE.SettingsModal.importCsvLabel') }}</span>
                <div class="form-item__control"><button class="mini-lg" :disabled="importing" @click="importFromCsv">{{ $t('statsE.SettingsModal.importCsvBtn') }}</button></div></div>
              <div class="form-item"><span class="form-item__label">{{ $t('statsE.SettingsModal.snapshotWriteLabel') }}</span>
                <div class="form-item__control">
                  <button class="mini-lg" @click="writeBackupNow">{{ $t('statsE.SettingsModal.snapshotBackUpNowBtn') }}</button>
                  <span class="tip">{{ $t('statsE.SettingsModal.snapshotStructureHint') }}</span>
                </div></div>
            </div>
            <div class="form">
              <div class="form-label">{{ $t('statsE.SettingsModal.dangerZone') }}</div>
              <div class="form-item"><span class="form-item__label">{{ $t('statsE.SettingsModal.restoreSnapshotLabel') }}</span>
                <div class="form-item__control"><button class="danger-btn" @click="restoreFromBackup">{{ $t('statsE.SettingsModal.restoreEllipsis') }}</button></div></div>
              <div class="form-item"><span class="form-item__label">{{ $t('statsE.SettingsModal.autoRestoreLabel') }}</span>
                <div class="form-item__control" style="display:flex;gap:8px">
                  <el-select size="small" v-model="autoBackupPick" filterable style="max-width:260px" @focus="loadAutoBackupList" @visible-change="v => v && loadAutoBackupList()">
                    <el-option v-for="f in autoBackupFiles" :key="f" :label="f" :value="f" />
                  </el-select>
                  <button class="mini" @click="restoreFromAutoBackup">{{ $t('statsE.SettingsModal.autoRestoreBtn') }}</button>
                </div></div>
              <div class="form-item danger-row"><span class="form-item__label">{{ $t('statsE.SettingsModal.clearDemoDataLabel') }}</span>
                <div class="form-item__control"><button class="danger-btn" @click="purgeSeed">{{ $t('statsE.SettingsModal.clearBtn') }}</button></div></div>
              <div class="form-item danger-row"><span class="form-item__label">{{ $t('statsE.SettingsModal.emptyBinLabel') }}</span>
                <div class="form-item__control"><button class="danger-btn" @click="purgeRecycle">{{ $t('statsE.SettingsModal.emptyBinBtn') }}</button></div></div>
            </div>
          </div>

        </div>
      </div>
    </div>
  </div>
</template>

<script lang="ts">
/** Settings center -- structure aligned with the reference: full-screen base-modal (modal-container/modal-tablecloth--body)
 *  + el-tabs.setting_tabs tabs in the header + .tab-panel>.form>.form-label+.form-item rows in the body.
 *  All feature bindings are preserved (visual rework only, no functional change). */
import {dayjs , FMT , appVersion} from '../utils/core.js'
import { confirmRecycleClear } from '../utils/confirm.js'
import { CONFIRM_SOUNDS, confirmUrl } from '../utils/mediaRegistry.js'
import { SETTING_ENUMS } from '../store/settings.js'
import dialogA11y from '../utils/dialogA11y.js'
import { loadRuntime } from '../store/runtimeState.js'
import { CITY_OPTIONS, CITY_PATH_MAP } from '../utils/chinaRegions.js'
import { SUPPORTED, getLocale, setLocale } from '../i18n/index.js'

export default {
  name: 'SettingsModal',
  mixins: [dialogA11y],
  data () {
    let tab0 = 'general'
    try { tab0 = localStorage.getItem('settingsTab') || 'general' } catch (e) { /* privacy mode etc. */ }
    return {
      tab: ['general', 'appearance', 'calendar', 'shortcuts', 'tomato', 'data', 'about'].indexOf(tab0) >= 0 ? tab0 : 'general',
      searchQ: '',
      searching: false,
      searchEmpty: false,
      langOptions: SUPPORTED,
      // Empty skeleton before the async response arrives: the template (shortcuts tab) renders before created's getSettings resolves; null would blow up with "reading 'toggleMainWindow'"
      shortcutForm: { sync: '', toggleMainWindow: '', quickAddGlobal: '', addEvent: '', deleteEvent: '' },
      capturing: null as any,
      exporting: false,
      importing: false,
      backupDirDefault: '',
      autoBackupLastAt: 0,
      backupDirShown: '',
      autoBackupFiles: [] as any,
      autoBackupPick: '',
      nameDraft: '',
      updStatus: 'idle',
      updVersion: '',
      updActive: true,
      updPercent: 0,
      updNewVersion: ''
    }
  },
  watch: {
    userName: { immediate: true, handler (v) { this.nameDraft = v } },
    tab (v) { try { localStorage.setItem('settingsTab', v) } catch (e) { /* ignored */ } }
  },
  computed: {
    /** Note: the computed name collides with the appVersion function in utils/core.js -- {{ appVersion }} in the template is a string;
     *  writing appVersion() would recursively call itself and report "appVersion is not a function" (this once broke the settings modal render) */
    appVersion () { return appVersion() },
    confirmSoundOptions () { return CONFIRM_SOUNDS },
    /** Settings enum options: derived from the SETTING_ENUMS schema in store/settings.js (do not hardcode options in the template) */
    enumOptions () { return key => SETTING_ENUMS[key] || [] },
    st () { return this.$store.state.settings },
    cityOptions () { return CITY_OPTIONS },
    cityPath () { return CITY_PATH_MAP[this.st.weatherCity] || [] },
    backupDirDisplay () { return this.backupDirShown || this.$t('statsE.SettingsModal.loadingPlaceholder') },
    userName () {
      const u = this.$store.state.auth.user || {}
      return u.userNameDefault ? this.$t('statsA.core.offlineUser') : (u.userName || '')
    },
    shortcutDefs () {
      return [
        { key: 'toggleMainWindow', label: this.$t('statsE.SettingsModal.scToggleWin') },
        { key: 'quickAddGlobal', label: this.$t('statsE.SettingsModal.scQuickAddGlobal') },
        { key: 'addEvent', label: this.$t('statsE.SettingsModal.scAddEvent') },
        { key: 'deleteEvent', label: this.$t('statsE.SettingsModal.scDeleteEvent') },
        { key: 'pinEvent', label: this.$t('statsE.SettingsModal.scPin') },
        { key: 'unpinEvent', label: this.$t('statsE.SettingsModal.scUnpin') },
        { key: 'toggleAllSubtasks', label: this.$t('statsE.SettingsModal.scSubtasks') },
        { key: 'startPomodoro', label: this.$t('statsE.SettingsModal.scPomodoro') },
        { key: 'sync', label: this.$t('statsE.SettingsModal.scSync') },
        { key: 'switchToDaytodo', label: this.$t('statsE.SettingsModal.scNavToday') },
        { key: 'switchToRecentTodos', label: this.$t('statsE.SettingsModal.scNavRecent') },
        { key: 'switchToSchedule', label: this.$t('statsE.SettingsModal.scNavCalendar') },
        { key: 'switchToInbox', label: this.$t('statsE.SettingsModal.scNavInbox') }
      ]
    },
    tabs () { return [['general', this.$t('statsE.SettingsModal.generalTab')], ['appearance', this.$t('statsH.SettingsModal.tabAppearance')], ['calendar', this.$t('statsH.SettingsModal.tabCalendar')], ['shortcuts', this.$t('statsH.SettingsModal.tabShortcuts')], ['tomato', this.$t('statsH.SettingsModal.tabTomato')], ['data', this.$t('statsH.SettingsModal.tabData')], ['about', this.$t('statsE.SettingsModal.aboutTab')]] },
    localDescLines: {
      get () { return this.st.todoDescriptionDisplayLineNumber },
      set (v) { this.set({ todoDescriptionDisplayLineNumber: v }) }
    },
    sEnableNoti () { return this.$store.state.tomato.enableNotification !== false },
    isCustomNoise () { const f = this.st.whiteNoiseAudio || ''; return f.startsWith('file:') || f.startsWith('local:') },
    noiseVolumePct () { return Math.round((Number(this.st.whiteNoiseVolume) || 0) * 100) },
    customAudioLabel () {
      const f = this.st.whiteNoiseAudio
      if (f && f.startsWith('file:')) return decodeURIComponent(f.slice(5))
      if (f && f.startsWith('local:')) return this._customNoiseName || this.$t('statsE.SettingsModal.selectedCount')
      return ''
    },
    shortcutDirty () {
      return !!this.shortcutForm && this._shortcutSnapshot !== JSON.stringify(this.shortcutForm)
    }
  },
  created () {
    window.todoAPI.getSettings().then(c => {
      this.shortcutForm = Object.assign({ sync: '', toggleMainWindow: '', quickAddGlobal: '', addEvent: '', deleteEvent: '' }, c.shortcutKeySettings)
      this._shortcutSnapshot = JSON.stringify(this.shortcutForm)
    }).catch(e => console.error('[SettingsModal] getSettings', e))
  },
  beforeUnmount () {
    this._isDestroyed = true
    if (this._updUn) { this._updUn(); this._updUn = null }
    if (this._maskTimer) clearTimeout(this._maskTimer)
    document.removeEventListener('click', this.maskClickHide)
    this.stopCapture()
  },
  methods: {
    /* Replay onboarding: clear the ledger flag and re-run the today-page spotlight */
    replayOnboarding () {
      import('../utils/onboardingTours.js').then(m => {
        m.resetToursSeen()
        this.$store.commit('ui/toggleSettings', false)
        this.$router.push('/todo-list/today').catch(() => {})
        setTimeout(() => m.runJourney(true), 600)
      })
    },
    dfmt (ts) { return dayjs(ts).format(FMT.dateTime) },
    /* Settings search: filters setting rows across all tabs (aligned with the VS Code/TickTick settings-search convention).
       Implementation = DOM-level filtering: while searching, all tab panels are expanded and rows are matched on "label + control text + owning section";
       clearing restores the current tab view. */
    applySearchFilter () {
      const q = String(this.searchQ || '').trim().toLowerCase()
      this.searching = q.length > 0
      this.$nextTick(() => {
        const panels = document.querySelectorAll('.settings-modal-body .tab-panel')
        let totalHits = 0
        panels.forEach(p => {
          const kids: any[] = [...p.querySelectorAll('.form-item, .form-label, .hr')]
          // First pass: a form-item hits if "its owning section title + its own text" matches
          let sectionText = ''
          const kind = kids.map(function (el) {
            if (el.classList.contains('form-label')) { sectionText = el.textContent.trim(); return 'label' }
            if (el.classList.contains('hr')) return 'hr'
            return (sectionText + ' ' + el.textContent).toLowerCase().indexOf(q) >= 0 ? 'hit' : 'miss'
          })
          // Second pass: a section title is visible only if a hit exists between it and the next title
          kids.forEach(function (el, idx) {
            if (kind[idx] === 'label') {
              let has = false
              for (let j = idx + 1; j < kids.length && kind[j] !== 'label'; j++) if (kind[j] === 'hit') { has = true; break }
              el.style.display = has ? '' : 'none'
            } else if (kind[idx] === 'hr') {
              el.style.display = 'none'
            } else {
              el.style.display = kind[idx] === 'hit' ? '' : 'none'
              if (kind[idx] === 'hit') totalHits++
            }
          })
          // Third pass: a form shell with no visible rows left collapses too (otherwise search leaves empty card strips behind)
          p.querySelectorAll(':scope > .form').forEach(function (shell: any) {
            const any = [...shell.querySelectorAll('.form-item, .form-label')].some((el: any) => el.style.display !== 'none')
            shell.style.display = any ? '' : 'none'
          })
        })
        this.searchEmpty = this.searching && totalHits === 0
      })
    },
    clearSearch () {
      this.searchQ = ''
      this.searching = false
      this.applySearchFilter()
    },
    close () {
      if (this.shortcutDirty) {
        this.$confirm(this.$t('statsE.SettingsModal.scDiscardConfirm'), this.$t('statsH.SettingsModal.tabShortcuts'), { type: 'warning' })
          .then(() => {
            this.shortcutForm = JSON.parse(this._shortcutSnapshot)
            this.$store.commit('ui/toggleSettings', false)
          }).catch(() => {})
        return
      }
      this.$store.commit('ui/toggleSettings', false)
    },
    maskClickHide (e) {
      if (e.target && e.target.classList &&
          (e.target.classList.contains('modal-container') || e.target.classList.contains('modal-tablecloth'))) this.close()
    },
    bindMaskOnce () { this._maskTimer = setTimeout(() => { this._maskTimer = null; if (this._isDestroyed) return; document.addEventListener('click', this.maskClickHide) }, 300) },
    saveName () {
      if (!String(this.nameDraft || '').trim()) this.nameDraft = this.userName // empty input does not save; echo the original name back
      this.renameUser(this.nameDraft)
    },
    set (patch) {
      this.$store.dispatch('settings/update', patch) // goes through the action to sync to the main process config.json (otherwise toggles like launch-at-startup/hardware acceleration would not take effect)
      // Pomodoro duration / rest duration / daily target are dual-store ledgers (the panel reads the tomato store) — the settings page must mirror after editing,
      // otherwise it doesn't take effect within the session and only gets backfilled by init after restart (confirmed via release walkthrough: set 30, panel still showed 25:00)
      const tomatoKeys = ['tomatoTime', 'restTime', 'dailyTomatoTarget']
      const tp = {}
      for (const k of tomatoKeys) if (k in patch && patch[k] != null) tp[k] = patch[k]
      if (Object.keys(tp).length) this.$store.commit('tomato/patch', tp)
    },
    getLocale,
    async loadUpdStatus () {
      try {
        const r = await window.todoAPI.updaterStatus()
        this.updActive = r.active !== false
        this.updVersion = r.version
        if (r.status) this.applyUpdStatus(r)
      } catch (e) { /* browser host has no such channel */ }
    },
    applyUpdStatus (r) {
      this.updStatus = r.status
      if (r.status === 'checking') this.updPercent = 0
      if (r.info && r.info.percent != null) this.updPercent = r.info.percent
      if (r.info && r.info.version) this.updNewVersion = r.info.version
    },
    async checkUpdate () {
      if (this.updStatus === 'checking' || this.updStatus === 'downloading') return
      // 点击即给过程反馈:网络慢时检查可能耗时数秒,不能让按钮看起来"没反应"
      this.updStatus = 'checking'
      this.$message.info(this.$t('update.checking'))
      try {
        const r = await window.todoAPI.checkForUpdates()
        if (r) this.applyUpdStatus(r)
        if (r && r.active === false) this.$message.info(this.$t('update.devEnv'))
        if (r && r.status === 'uptodate') this.$message.success(this.$t('update.upToDate'))
        if (r && r.status === 'error') this.$message.error(this.$t('update.failedReason', { msg: String((r.info && r.info.message) || '').slice(0, 120) }))
      } catch (e) { this.updStatus = 'idle'; this.$message.info(this.$t('update.devEnv')) }
    },
    async restartToUpdate () {
      const okq = await window.todoAPI.quitAndInstall()
      if (!okq) this.$message.error(this.$t('update.failed'))
    },
    async downloadNow () {
      const ok = await window.todoAPI.downloadUpdate()
      if (!ok) this.$message.error(this.$t('update.failed'))
    },
    openReleases () {
      if (window.todoAPI.openExternal) window.todoAPI.openExternal('https://github.com/ardss/pickdone/releases/latest')
    },
    openOfficialSite () {
      if (window.todoAPI.openExternal) window.todoAPI.openExternal('https://pickdone.app')
    },
    onLangChange (locale) {
      setLocale(locale)
      this.$message.success(this.$t(locale === 'en-US' ? 'update.switchedToEn' : 'statsH.SettingsModal.switchedToZh'))
    },
    renameUser (v) {
      const name = String(v || '').trim()
      if (!name) return
      this.$store.commit('auth/patchUser', { userName: name, userNameDefault: false, userRenamed: true })
      this.$message.success(this.$t('statsE.SettingsModal.usernameUpdatedMsg'))
    },
    onCityPick (v) {
      this.set({ weatherCity: Array.isArray(v) ? v[v.length - 1] : '' })
    },
    async saveLockPassword (v) {
      // When encryption is unavailable the main process refuses — never fall back to storing plaintext (the old catch once wrote plaintext into config.json); the feature stays off
      try { const enc = await window.todoAPI.encryptSecret(v); this.set({ securityLockPassword: enc }) } catch (e) { console.error('[Settings] secure encryption unavailable, lock password not saved', e) }
    },
    setLockTest () {
      // Real lock: the main process hides the main window and shows the lock screen (validation happens in the main process)
      this.set({})
      this.$store.commit('ui/toggleSettings', false)
      window.todoAPI.lockApp()
    },
    async setTomatoNoti (v) { this.$store.commit('tomato/patch', { enableNotification: v }) },
    /** Desktop float window toggle: writes the setting and immediately opens/closes the independent window (browser debugging has no todoAPI, only the setting is stored) */
    async setTomatoFloat (v) {
      this.set({ enableTomatoFloating: v })
      if (window.todoAPI) { v ? window.todoAPI.showTomatoFloat() : window.todoAPI.hideTomatoFloat() }
    },
    pickCustomAudio () {
      window.todoAPI.pickAudioFile().then(r => {
        if (!r) return
        if (typeof r === 'string') { // Legacy main process only returned absolute paths (not servable by protocol, unplayable during focus): kept for compatibility only
          this.set({ whiteNoiseAudio: 'file:' + encodeURIComponent(r) })
          this._customNoiseName = r
          this.$message.success(this.$t('statsE.SettingsModal.selectedPrefix') + r)
          return
        }
        // New contract: the main process copies the file into userData/files and returns {name,key} → 'local:<key>' is servable by the local:// protocol (Range)
        this.set({ whiteNoiseAudio: 'local:' + r.key })
        this._customNoiseName = r.name
        this.$message.success(this.$t('statsE.SettingsModal.selectedPrefix') + r.name)
      })
    },
    // -- Shortcut capture (control-ized: click to enter listening state, document capture phase takes over the keyboard) --
    startCapture (key) {
      if (this.capturing === key) { this.stopCapture(); return } // clicking again cancels
      this.stopCapture()
      this.capturing = key
      this._docKeyHandler = e => this.handleCaptureKey(e, key)
      document.addEventListener('keydown', this._docKeyHandler, true) // capture: true
    },
    stopCapture () {
      if (this._docKeyHandler) { document.removeEventListener('keydown', this._docKeyHandler, true); this._docKeyHandler = null }
      this.capturing = null
    },
    cancelCapture () { this.stopCapture() },
    handleCaptureKey (e, key) {
      if (this.capturing !== key) return
      e.preventDefault()
      e.stopPropagation()
      const k = (e.key || '').toLowerCase()
      if (k === 'escape') { this.stopCapture(); return } // Esc = cancel capture
      if (!k || k === 'control' || k === 'alt' || k === 'shift' || k === 'meta') return // do not commit when only modifier keys are pressed
      const parts = []
      if (e.ctrlKey) parts.push('ctrl')
      if (e.altKey) parts.push('alt')
      if (e.shiftKey) parts.push('shift')
      const map = { ' ': 'space', delete: 'delete' }
      const main = map[k] || k
      const combo = parts.concat(main).join('+')
      // Conflict detection: if it duplicates another shortcut, warn and do not write
      if (this.shortcutDefs.some(d => d.key !== key && this.shortcutForm[d.key] === combo)) {
        this.$message.warning(this.$t('statsE.SettingsModal.shortcutConflictTitle') + '：' + combo)
        this.stopCapture()
        return
      }
      this.shortcutForm[key] = combo
      this.stopCapture()
    },
    onCaptureBlur () { this.stopCapture() },
    hasConflict (key) {
      if (!this.shortcutForm) return false // the template renders before created's async response arrives
      const val = this.shortcutForm[key]
      if (!val) return false
      return this.shortcutDefs.some(d => d.key !== key && this.shortcutForm[d.key] === val)
    },
    formatShortcut (v) { return v || this.$t('statsE.SettingsModal.scEmpty') },
    resetShortcuts () {
      this.shortcutForm = { sync: 'ctrl+s', addEvent: 'ctrl+n', deleteEvent: 'ctrl+d', toggleMainWindow: 'ctrl+alt+t', quickAddGlobal: 'alt+shift+t', pinEvent: 'ctrl+p', unpinEvent: 'ctrl+shift+p', toggleAllSubtasks: 'ctrl+shift+s', startPomodoro: 'ctrl+alt+p', switchToDaytodo: 'ctrl+1', switchToRecentTodos: 'ctrl+2', switchToSchedule: 'ctrl+3', switchToInbox: 'ctrl+4' }
    },
    saveShortcuts () {
      this.set({})
      window.todoAPI.updateSettings({ shortcutKeySettings: JSON.parse(JSON.stringify(this.shortcutForm)) })
      this._shortcutSnapshot = JSON.stringify(this.shortcutForm)
      this.$message.success(this.$t('statsE.SettingsModal.shortcutSavedMsg'))
      if (this.$announce) this.$announce(this.$t('statsE.SettingsModal.shortcutSavedMsg'))
    },
    previewCompleteSound () {
      const st = this.$store.state.settings
      // Preview sound = the actual completion sound (settings.completeSound); the previously hardcoded, nonexistent tomato_ok.mp3 was always silent
      let src = confirmUrl(st.completeSound)
      if (st.whiteNoiseAudio && st.whiteNoiseAudio.startsWith('file:')) src = st.whiteNoiseAudio
      try { new Audio(src).play().catch(() => {}) } catch (e) { /* no-op */ }
    },
    /** Unified double confirmation for dangerous operations: a regular confirm first, then an irreversible final confirm */
    async confirmDanger (msg, title, type) {
      await this.$confirm(msg, title, { type: type || 'warning' })
      await this.$confirm(this.$t('statsE.SettingsModal.panelSyncHint'), title, { type: 'error', confirmButtonText: this.$t('statsE.SettingsModal.breakLengthLabel') })
    },
    // CSV one-click migration (other todo apps → Pickdone): main process picks file + preview, executes on confirm; repeating tasks deduped by engine fingerprint
    async importFromCsv () {
      if (this.importing) return
      this.importing = true
      try {
        const picked = await window.todoAPI.importCsvPickPreview()
        if (!picked) return // user canceled the file dialog
        const r = picked.report
        const msg = this.$t('statsE.SettingsModal.importPreviewMsg', { f: r.format, n: r.wouldImport, d: r.duplicates, s: r.skipped })
        try { await this.$confirm(msg, this.$t('statsH.SettingsModal.importTitle'), { type: 'info' }) } catch { return }
        const done = await window.todoAPI.importCsvRun(picked.file)
        await this.$store.dispatch('_rt/refreshFromDb')
        this.$message.success(this.$t('statsH.SettingsModal.importDone', { n: done.imported, d: done.duplicates }))
      } catch (e) {
        this.$message.error(this.$t('statsE.SettingsModal.importFailedMsg') + (e && e.message ? e.message : String(e)))
      } finally { this.importing = false }
    },
    async pickBackupDir () {
      const dir = await window.todoAPI.pickBackupDir()
      if (!dir) return
      this.set({ backupDir: dir })
      this.loadBackupDirDisplay()
      this.$message.success(this.$t('statsE.SettingsModal.backupLocationUpdatedMsg'))
    },
    resetBackupDir () {
      this.set({ backupDir: '' })
      this.loadBackupDirDisplay()
    },
    async loadBackupDirDisplay () {
      this.autoBackupLastAt = loadRuntime().autoBackupLastAt || 0
      try {
        const def = await window.todoAPI.getDefaultBackupDir()
        this.backupDirDefault = def
        this.backupDirShown = this.st.backupDir || def
      } catch {}
    },
    async runAutoBackupNow () {
      const ok = await this.$store.dispatch('todo/writeAutoBackup')
      this.autoBackupLastAt = loadRuntime().autoBackupLastAt || Date.now()
      // Failures must be reported honestly (an unwritable backupDir / an offline disk once silently faked success for a long time)
      ok === false ? this.$message.error(this.$t('statsE.SettingsModal.backupFail')) : this.$message.success(this.$t('statsE.SettingsModal.autoBackupWrittenMsg'))
    },
    async exportXlsx () {
      if (this.exporting) return
      this.exporting = true
      try {
        // Export active tasks only: recycle bin rows mixed in would lack the deleted marker (and would inevitably revive on a future import)
        const list = this.$store.state.todo.todoList
        if (!list.length) return this.$message.info(this.$t('statsE.SettingsModal.noDataYet'))
        const catName = id => (this.$store.state.category.list.find(c => c.categoryId === id) || {}).categoryName || ''
        const rows = list.map(t => [
          t.taskId,
          t.dayStart ? dayjs(t.dayStart).format(FMT.date) : '',
          catName(t.categoryId),
          t.taskContent, t.taskDescribe || '',
          (JSON.parse(t.subtasks || '[]')).map(s => (s.checked ? '[x] ' : '[ ] ') + s.text).join('\n'),
          t.complete ? this.$t('statsE.SettingsModal.yesLabel') : this.$t('statsH.SettingsModal.exportNo'),
          String(t.estimate || 0),
          t.reminderTime ? dayjs(t.reminderTime).format(FMT.dateTime) : '',
          (t.reminderOffsets || []).join(','),
          t.repeatId || '',
          t.deadlineTs ? dayjs(t.deadlineTs).format(FMT.date) : '',
          t.important === 1 || t.important === true ? 'Y' : 'N',
          t.urgent === 1 || t.urgent === true ? 'Y' : 'N',
          t.todoDifficultyLevel || 0
        ])
        const r = await window.todoAPI.exportXlsx({ fileName: this.$t('statsH.SettingsModal.exportFileName', { ts: dayjs().format('YYYYMMDD_HHmmss') }), rows })
        if (!r.canceled && !r.error) this.$message.success(this.$t('statsE.SettingsModal.exportedPrefix') + r.filePath)
        else if (r.error) this.$message.error(r.error)
      } finally { this.exporting = false }
    },
    writeBackupNow () {
      // Trigger a critical-state backup immediately and point out its location
      this.$store.dispatch('todo/writeCriticalBackup')
      setTimeout(() => {
        window.todoAPI.readCriticalStateBackup().then(txt => {
          this.$message.success(txt ? this.$t('statsE.SettingsModal.criticalBackupWrittenMsg') : this.$t('statsH.SettingsModal.backupFailed'))
        }).catch(() => { this.$message.error(this.$t('statsH.SettingsModal.backupFailed')) })
      }, 1200)
    },
    async loadAutoBackupList () {
      try {
        this.autoBackupFiles = (await window.todoAPI.listAutoBackups(this.st.backupDir || '')) || []
        if (!this.autoBackupPick && this.autoBackupFiles.length) this.autoBackupPick = this.autoBackupFiles[0]
      } catch { this.autoBackupFiles = [] }
    },
    async restoreFromAutoBackup () {
      if (!this.autoBackupPick) return this.$message.info(this.$t('statsE.SettingsModal.autoRestoreEmpty'))
      await this.confirmDanger(this.$t('statsE.SettingsModal.autoRestoreConfirm', { f: this.autoBackupPick }), this.$t('statsH.SettingsModal.restoreTitle'), 'warning')
        .then(async () => {
          try {
            const txt = await window.todoAPI.readAutoBackup(this.st.backupDir || '', this.autoBackupPick)
            if (!txt) return this.$message.error(this.$t('statsE.SettingsModal.backupFileNotFoundMsg'))
            const d = JSON.parse(txt); const b = d.backup || {}
            await this.$store.dispatch('todo/writeEventBackup', 'restore')
            const rows = []
            if (b.todoState) { const td = this.parseTodoState(b.todoState); (td.todoList || []).forEach(r => rows.push(r)); (td.recycleList || []).forEach(r => rows.push(r)) }
            if (rows.length) await window.todoAPI.dbCall('upsertMany', rows)
            // 字段级对齐 critical 恢复:分类与专注账本同份同回,否则"恢复"后分类消失/专注账全丢(二轮深审 P1-2)
            if (b.categoryState) { const c = JSON.parse(b.categoryState); if (c.list) this.$store.commit('category/setList', c.list) }
            await this.restoreTomatoLedger(b)
            this.$store.dispatch('_rt/refreshFromDb')
            this.$store.dispatch('tomato/recordsReload')
            this.$message.success(this.$t('statsH.SettingsModal.restoredCount', { n: rows.length }))
          } catch (e) { this.$message.error(this.$t('statsE.SettingsModal.backupParseFailedMsg') + e.message) }
        }).catch(() => {})
    },
    // dump.todoState 解析 + 版本守卫:schemaV 高于本版支持的备份静默误读=降级导入事故,显式报错
    parseTodoState (raw) {
      const td = typeof raw === 'string' ? JSON.parse(raw) : raw
      if (td && Number(td.schemaV) > 1) throw new Error('schemaV ' + td.schemaV + ' > 1 (backup from a newer app version)')
      return td || {}
    },
    // 账本回灌:行表幂等 UPSERT,缺 tomatoId/endTime 的行跳过不拖批(与主进程 dbRecovery 同规则)
    async restoreTomatoLedger (b) {
      if (!b.tomatoRecords) return
      const recs = typeof b.tomatoRecords === 'string' ? JSON.parse(b.tomatoRecords) : b.tomatoRecords
      const ok = (Array.isArray(recs) ? recs : []).filter(r => r && r.tomatoId && r.endTime)
      if (ok.length) await window.todoAPI.dbCall('tomatoAppendMany', ok)
    },
    restoreFromBackup () {
      this.confirmDanger(this.$t('statsE.SettingsModal.criticalRestoreConfirmMsg'), this.$t('statsH.SettingsModal.restoreTitle'), 'warning').then(async () => {
        this.$store.dispatch('todo/writeEventBackup', 'restore')
        let txt = null
        try { txt = await window.todoAPI.readCriticalStateBackup() } catch (e) { return this.$message.error(this.$t('statsE.SettingsModal.backupParseFailedMsg') + e.message) }
        if (!txt) return this.$message.error(this.$t('statsE.SettingsModal.backupFileNotFoundMsg'))
        try {
          const d = JSON.parse(txt); const b = d.backup || {}
          if (b.settingsState) this.$store.commit('settings/restore', JSON.parse(b.settingsState))
          if (b.categoryState) { const c = JSON.parse(b.categoryState); if (c.list) this.$store.commit('category/setList', c.list) }
          if (b.habitsState) {
            try {
              const hb = JSON.parse(b.habitsState)
              if (hb && Array.isArray(hb.habits)) {
                // Single writer via the store only: replaceAll already dual-writes LS+meta; writing LS directly from the component would create a second writer (dual-write ledger discipline)
                this.$store.commit('habits/replaceAll', hb)
              }
            } catch {}
          }
          const rows = []
          if (b.todoState) { const td = this.parseTodoState(b.todoState); (td.todoList || []).forEach(r => rows.push(r)); (td.recycleList || []).forEach(r => rows.push(r)) }
          if (rows.length) await window.todoAPI.dbCall('upsertMany', rows)
          // 回收站行与专注账本同份同回(此前 UI 恢复只进 todoList,同一份 dump 走启动灾备却能全回——两端语义割裂)
          await this.restoreTomatoLedger(b)
          this.$store.dispatch('_rt/refreshFromDb')
          this.$store.dispatch('tomato/recordsReload')
          this.$message.success(this.$t('statsH.SettingsModal.restoredCount', { n: rows.length }))
        } catch (e) { this.$message.error(this.$t('statsE.SettingsModal.backupParseFailedMsg') + e.message) }
      }).catch(() => {})
    },
    purgeRecycle () {
      const n = this.$store.state.todo.recycleList.length
      // Same strength as the recycle bin page: unified triple confirm confirmRecycleClear (previously only single confirm, inconsistent protection)
      confirmRecycleClear(this, n).then(() => {
        this.$store.dispatch('todo/purgeAllRecycle')
        this.$message.success(this.$t('statsC.RecycleBin.cleared', { n }))
      }).catch(() => {})
    },
    async purgeSeed () {
      try {
        const n = await window.todoAPI.dbCall('countSeedTodos')
        if (!n) return this.$message.info(this.$t('statsE.SettingsModal.noDemoDataMsg'))
        await this.confirmDanger(this.$t('statsH.SettingsModal.purgeSeedConfirm', { n }), this.$t('statsE.SettingsModal.clearDemoDataMsg'), 'warning')
        await window.todoAPI.purgeSeedTodos()
        this.$store.dispatch('tomato/removeRecordsByIdPrefix', 'seed_')
        this.$store.dispatch('_rt/refreshFromDb')
        this.$message.success(this.$t('statsE.SettingsModal.demoDataClearedMsg'))
      } catch (e) { /* cancelled */ }
    },
    feedback () {
      if (window.todoAPI.openExternal) window.todoAPI.openExternal('https://github.com/ardss/pickdone/issues')
    },
    openLogsDir () {
      if (window.todoAPI && typeof window.todoAPI.openLogsDir === 'function') window.todoAPI.openLogsDir()
    }
  },
  mounted () {
    this.bindMaskOnce(); this.loadBackupDirDisplay()
    this.loadUpdStatus()
    if (window.todoAPI.onUpdaterEvent) this._updUn = window.todoAPI.onUpdaterEvent(d => this.applyUpdStatus({ status: d.status, info: d.info }))
  },

}
</script>
<style>
/* ===== 迁移自全局沉积文件(scripts/css-move.mjs):以下规则随组件生灭 ===== */
/* ==================== 3. 设置中心（全屏 base-modal + setting_tabs + form） ==================== */
/* 设计稿设置 = 全屏弹窗：header 为 el-tabs 页签，body 内 .tab-panel>.form>.form-label+.form-item */
.setting_tabs { height: 100%; width: 100%; }
.setting_tabs .el-tabs__header { margin: 0 !important; }
/* EP 的下划线 translateX 按 nav 内 offsetLeft 计算，nav 不能再加 padding（会双重偏移）；内缩改到 header 上 */
/* 下划线已改为页签自绘 ::after，nav 内边距不再影响对齐，安全 */
.setting_tabs .el-tabs__nav { padding-left: 20px !important; }
/* 去掉打开设置时活动标签自带的焦点高亮（element-ui 的蓝色内发光 + 浏览器 outline），激活态由下划线表达 */
.setting_tabs .el-tabs__item:focus,
.setting_tabs .el-tabs__item:focus-visible,
.setting_tabs .el-tabs__item:focus.is-active.is-focus:not(:active) { outline: none !important; box-shadow: none !important; }
/* EP 下划线由内联 transform 自动对齐页签，无需 element-ui 时代的 left 偏移 */
/* EP 默认会去掉第 2 个页签的左 padding（nth-child(2)）和最后 1 个页签的右 padding（last-child），
   导致页签内边距不均匀、自绘下划线除第一个页签外全部错位——设置弹窗内恢复均匀 20px，
   配合下方对称 ::after（left/right 各 20px），下划线宽度恒等于文字宽度 */
.setting_tabs .el-tabs__item:nth-child(2) { padding-left: 20px !important; }
.setting_tabs .el-tabs__item:last-child { padding-right: 20px !important; }
.setting_tabs .el-tabs__item.is-active,
.setting_tabs .el-tabs__item:hover { color: var(--brand-dark); }
/* EP 的活动条 translateX 计算在本布局下恒定偏右 20px（JS 内部测量），弃用之；
   改用活动页签自身 ::after 画下划线 */
.setting_tabs .el-tabs__active-bar { display: none !important; }
.setting_tabs .el-tabs__item { position: relative; }
.setting_tabs .el-tabs__item.is-active::after {
  content: ''; position: absolute; left: 20px; right: 20px; bottom: 0;
  height: 2px; background: var(--brand-dark); border-radius: var(--radius-xs);
}
.form-item {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-4);
  margin-bottom: 16px;
}
/* 标签左对齐自然宽度：原 180px 定宽+右对齐使短标签悬在列中间，观感割裂 */
.form-item__label {
  flex: 0 1 auto;
  min-width: 0;
  color: var(--text-1);
  font-weight: 500;
  font-size: var(--fs-md);
  line-height: 1.5;
  text-align: left;
}
.form-item__control {
  display: flex;
  margin-left: auto;
  min-width: 0;
  max-width: 60%;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  justify-content: flex-end;
}
.form-item__control input, .form-item__control select {
  display: block;
  height: 24px;
  padding: 0 10px;
  font-size: var(--fs-base, 14px);
  line-height: 1;
  border: 1px solid var(--line-strong, #e4e7ed);
  border-radius: var(--radius-sm, 4px);
  background: transparent;
  color: inherit;
}
.form-item__control input:focus, .form-item__control select:focus {
  border-color: var(--brand);
  outline: 0;
  box-shadow: 0 0 0 3px var(--brand-focus-ring, rgba(15, 157, 143, .15));
}
.form-item__control__append {
  flex-shrink: 0;
  margin-left: 8px;
  color: var(--text-3);
  font-weight: 400;
  font-size: var(--fs-base, 14px);
  line-height: 1.4;
}
.form-item__tip {
  width: 100%;
  margin-top: 8px;
  margin-left: 0;
  color: var(--text-3);
  font-size: var(--fs-sm, 12px);
  line-height: 1.5;
  word-break: break-word;
}
/* —— 设置卡片标签行紧凑化（卡片弹窗形态）：行高 50→44、与内容齐平，
      去掉 Element 默认灰底线改用发丝线分隔。需 !important 压过上方全屏版规则 —— */
.modal--settings .setting_tabs .el-tabs__nav { height: 44px !important; }
.modal--settings .setting_tabs .el-tabs__item { height: 44px !important; line-height: 44px !important; }
.modal--settings .setting_tabs .el-tabs__nav-wrap::after { display: none; }
.modal--settings .setting_tabs .el-tabs__header { border-bottom: 1px solid #f3f3f3; }
.setting_tabs .el-tabs__item { height: 40px; line-height: 40px; text-align: left; padding: 0 18px !important; }
.setting_tabs .el-tabs__item:nth-child(2) { padding-left: 18px !important; }
.setting_tabs .el-tabs__item:last-child { padding-right: 18px !important; }
.setting_tabs .el-tabs__nav { padding-left: 6px !important; }
.setting_tabs .el-tabs__nav-wrap::after { display: none !important; }
.setting_tabs .el-tabs__item.is-active::after { left: 0 !important; right: auto !important; top: 9px; bottom: 9px; width: 2px; height: auto; }
.setting_tabs .el-tabs__active-bar { display: none !important; }
html[data-theme="dark"] .form-item__label { color: var(--text-1); }
html[data-theme="dark"] .form-item__control input,
html[data-theme="dark"] .form-item__control select {
  background: var(--gray-bg); border-color: var(--line-strong); color: var(--text-1);
}
html[data-theme="dark"] .form-item__tip { color: var(--text-3); }
/* 页签底部分隔线：亮色硬编码 #f3f3f3 在暗色下是刺眼亮白线 */
html[data-theme="dark"] .modal--settings .setting_tabs .el-tabs__header { border-bottom-color: var(--line); }

/* ===== 迁移自全局沉积文件(scripts/css-move.mjs):以下规则随组件生灭 ===== */
.tab-panel { padding: var(--space-5) var(--space-4); }
/* 分组卡片:每张卡一个设置组(Notion/Linear 式),替代长列表堆叠 */
.tab-panel .form {
  background: var(--panel, #fff);
  border: 1px solid var(--line-strong, #e4e7ed);
  border-radius: var(--radius-lg, 10px);
  padding: 6px 18px 14px;
  margin-bottom: 16px;
}
/* 分区标题：节奏走 spacing token（16/12），去掉与 .hr 的双重叠加 */
.tab-panel .form-label { margin: var(--space-4) 0 var(--space-3); color: var(--brand); font-weight: 500; font-size: var(--fs-base, 14px); }
/* 快捷键捕获按钮 */
.sc-capture {
  min-width: 120px; height: 28px; border: 1px solid var(--line, #ddd); border-radius: var(--radius-sm);
  background: var(--gray-bg, #f5f5f5); color: var(--text-1); cursor: pointer;
  display: inline-flex; align-items: center; justify-content: center;
  font-size: var(--fs-sm); transition: border-color .15s, background .15s;
}
.sc-capture:hover { border-color: var(--brand, #008d8e); }
.sc-capture.listening { border-color: var(--brand, #008d8e); background: var(--brand-light, #e7f7f7); color: var(--brand); }
.sc-capture.listening .sc-kbd { animation: scBlink 1s infinite; }
.sc-capture.conflict { border-color: #f56c6c; }
html[data-theme="dark"] .el-cascader-node { color: var(--text-2); }
html[data-theme="dark"] .el-cascader-node:hover,
html[data-theme="dark"] .el-cascader-node:focus { background: #2a3038; }
html[data-theme="dark"] .el-cascader-node.is-active { color: var(--brand); }
html[data-theme="dark"] .el-cascader-node.in-active-path { color: var(--text-1); }
html[data-theme="dark"] .el-cascader-node:hover, html[data-theme="dark"] .el-cascader-node:focus { background: var(--el-fill-color-light); }
html[data-theme="dark"] .el-cascader-node.is-active { color: var(--el-color-primary); }
/* 关闭按钮：化石的灰圆点 background-image 已删——它盖住 ::after 的 ✕，导致静止态只见圆点不见叉；
   ✕ 文字色经 html[data-theme="dark"] .modal__close 已适配主题，悬停仅加底色 */
/* 分组小标题：品牌青暗色提亮 */
html[data-theme="dark"] .tab-panel .form-label { color: #35c2ae; }
.sc { border-radius: var(--radius-xl); padding: 30px 32px; color: #fff; overflow: hidden; }
.settings-modal-body { color: var(--text-1); }
/* 控件宽度档位（设置页统一三档，替代原 8 档内联 px） */
.ctl-sm { width: 110px; }
.ctl-md { width: 160px; }
.ctl-lg { width: 260px; }
.tip { color: var(--text-3); font-size: var(--fs-sm, 12px); word-break: break-word; }
/* —— 控件高度档位统一（全局）：.mini/.mini-lg/.danger-btn 收敛到 24px 档。
      base.css 不便改动，此处后加载覆盖生效；全局生效属预期（统一档位正是目的） —— */
.mini { padding: var(--space-1) var(--space-3); }
.mini-lg { padding: var(--space-1) var(--space-4); }
.danger-btn { padding: var(--space-1) var(--space-3); background: var(--danger-soft, #fef0f0); }
/* ===== 设置页软件更新区块 ===== */
.upd-version { font-size: var(--fs-sm); color: var(--text-2); }
.upd-hint { margin-left: var(--space-2, 8px); font-size: var(--fs-sm); color: var(--text-3); }
.sc-kbd { font-family: monospace; font-size: var(--fs-sm); letter-spacing: 1px; }
/* ============ 设置搜索（跨页签过滤） ============ */
.settings-search {
  display: flex; align-items: center; gap: 8px;
  margin: 0 0 var(--space-4); padding: 7px 12px;
  /* 右侧让出关闭钮(close 锚在弹窗右上角,竖直方向与搜索行同高):整条输入带右缩 40px,不钻到钮底下 */
  margin-right: 40px;
  background: var(--gray-bg, #f8f8f8); border-radius: var(--radius-md);
}
.settings-search .app-icon { color: var(--text-3); flex-shrink: 0; }
.settings-search__input {
  flex: 1; border: 0; background: none; outline: none;
  color: var(--text-1); font-size: var(--fs-md); line-height: 1.5;
}
.settings-search__input::placeholder { color: var(--text-3); }
.settings-search__clear {
  border: 0; background: none; color: var(--text-3); cursor: pointer;
  font-size: var(--fs-sm); padding: 2px 6px; border-radius: var(--radius-sm);
}
.settings-search__clear:hover { color: var(--text-1); background: var(--hover-bg, rgba(0,0,0,.05)); }
.settings-search-empty { text-align: center; color: var(--text-3); font-size: var(--fs-md); padding: 40px 0; }
</style>
