/**
 * `test()` 注册器 + 运行器：让「源码锚点断言」从单测池里迁出来后仍然保持原样的写法。
 *
 * 背景（2026-11-21 冗余清理）：`tests/unit/**` 里有一批用例只做一件事——读一个源文件，用正则断言
 * 里面某段代码还在。它们没有任何运行时行为，却和真正的行为用例一样按「一个文件一个进程」被
 * `node --test` 拉起（983 文件 = 983 次进程启动 + 983 次 setup.mjs 引导）。这类断言本质是静态
 * 门禁，属于 cli/check-*：单进程一次跑完，红了直接指出「哪个文件哪段代码被改掉了」。
 *
 * 迁移方式刻意做成「零改写的重命名」：
 *   - 文件从 `*.test.mjs` 改名为 `*.contracts.mjs`（run-all 只发现 `.test.mjs`，因此自动退出单测池，
 *     不需要在发现逻辑里维护白名单——少一处会漂移的清单）；
 *   - 文件里 `import { test } from 'node:test'` 换成 `import { test } from '#contracts'`（package.json
 *     的 imports 映射指到这里），断言体一个字都不动。
 *
 * 只支持 `test(name, fn)`：describe/beforeEach/after/skip 这类需要 runner 生命周期的写法不走这条
 * 通道（有钩子就说明它有跨用例状态，那本来就是行为测试，应该留在单测池）。
 */
const cases = []

export function test (name, fn) {
  if (typeof name !== 'string' || !name.trim()) throw new Error('[contracts] test() needs a non-empty name — a blank name makes a red unidentifiable')
  if (typeof fn !== 'function') throw new Error(`[contracts] test(${JSON.stringify(name)}) needs a function body`)
  cases.push({ name, fn })
}

/** 取走当前已注册的用例（CLI 每导入一个文件后就取一次，避免跨文件混批）。 */
export function takeCases () {
  return cases.splice(0, cases.length)
}

/** `import test from 'node:test'` is the same function as the named export — several migrated
 *  files used the default-import form, so both spellings must resolve here. */
export default test
