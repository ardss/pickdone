/** Route table — names and paths aligned with the project baseline (main app area fully functional)
 *  vue-router 4: createRouter + createWebHashHistory (replaces the Vue2 new Router({mode:'hash'}), no Vue.use needed) */
const VueRouter = window.VueRouter

import AppLayout from './layout.vue'
import AppShell from './app-root.vue'
import TodayView from './views/TodayView.vue'
import TodayXView from './views/TodayXView.vue'
import TodoBoxView from './views/TodoBoxView.vue'
import CalendarView from './views/CalendarView.vue'
import SearchView from './views/SearchView.vue'
import StatisticsView from './views/StatisticsView.vue'
import CompletedView from './views/CompletedView.vue'
import RecycleBinView from './views/RecycleBinView.vue'
import CategoryView from './views/CategoryView.vue'
import ProjectView from './views/ProjectView.vue'
import ProjectOverviewView from './views/ProjectOverviewView.vue'
import HabitView from './views/HabitView.vue'
import TagView from './views/TagView.vue'
import TagAllView from './views/TagAllView.vue'
import TomatoFloatPage from './views/TomatoFloatPage.vue'
import QuickAddPage from './views/QuickAddPage.vue'
import FilterView from './views/FilterView.vue'

const router = VueRouter.createRouter({
  history: VueRouter.createWebHashHistory(),
  routes: [
    { path: '/__tomato-float', name: '__tomato-float', component: TomatoFloatPage },
    { path: '/__quick-add', name: '__quick-add', component: QuickAddPage },
    {
      path: '/',
      component: AppLayout,
      children: [
        { path: '', name: 'index', redirect: '/todo-list/today' },
        {
          path: '/todo-list',
          name: 'todo-list',
          component: AppShell,
          children: [
            { path: 'today', name: 'todo-list-today', component: TodayView },
            { path: 'today-x', name: 'todo-list-today-x', component: TodayXView },
            { path: 'todo-box', name: 'todo-list-todo-box', component: TodoBoxView },
            { path: 'statistics', name: 'todo-list-statistics', component: StatisticsView },
            { path: 'search', name: 'todo-list-search', component: SearchView },
            { path: 'calendar', name: 'todo-list-calendar', component: CalendarView },
            { path: 'completed', name: 'todo-list-completed', component: CompletedView },
            { path: 'recycle-bin', name: 'todo-list-recycle-bin', component: RecycleBinView },
            { path: 'category/:id', name: 'todo-list-category', component: CategoryView },
            { path: 'projects', name: 'todo-list-projects', component: ProjectOverviewView },
            { path: 'habit', name: 'todo-list-habit', component: HabitView },
            { path: 'project/:id', name: 'todo-list-project', component: ProjectView },
            { path: 'tag/:id', name: 'todo-list-tag', component: TagView },
            { path: 'all-tags', name: 'todo-list-all-tags', component: TagAllView },
            { path: 'filter/:id', name: 'todo-list-filter', component: FilterView },
            // catch-all: unknown/malformed hash (cold-start session restore, hand-edited URL) falls back to today view, otherwise AppLayout renders nothing
            { path: '/:pathMatch(.*)*', redirect: '/todo-list/today' }
          ]
        }
      ]
    }
  ]
})

export default router
