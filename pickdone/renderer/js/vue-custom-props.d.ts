/**
 * Vue 组件实例自定义属性声明 —— 全局注入面(vendor 全局构建形态):
 * vue-i18n 的 $t/$te、vuex 的 $store、vue-router 的 $route/$router 均由
 * index.html 经典脚本 + app.use() 挂到全局属性,模板/选项式 API 里直接可用。
 * 注意:不放索引签名逃生口([key:string]:any)——它会把任意拼写错误静音,
 * 类型层的守门价值就没了;缺什么属性就显式声明什么。
 */
import 'vue'

declare module 'vue' {
  interface ComponentCustomProperties {
    $t: (key: string, params?: any) => any
    $te: (key: string) => boolean
    $store: any
    $route: any
    $router: any
    $el: any
    $refs: Record<string, any>
    $nextTick: (cb?: () => void) => Promise<void>
    // SFC 编译后的 render 闭包可见模块级 dayjs/FMT,模板直接引用它们(vue-tsc 无法建模此通道,显式声明)
    dayjs: any
    FMT: any
  }
}

// 模板内联事件表达式里对 $event.target 的成员访问(无 as 断言通道)——按 DOM 事实放宽
declare global {
  interface EventTarget {
    checked?: boolean
    classList?: DOMTokenList
    value?: string
  }
}

export {}
