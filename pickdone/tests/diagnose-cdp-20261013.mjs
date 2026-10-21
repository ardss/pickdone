/**
 * Isolated PickDone Electron startup/CDP diagnostic. NO production userData.
 * Run: node tests/diagnose-cdp-20261013.mjs
 * Only terminates the child process tree that this script creates.
 */
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import net from 'node:net'
const req = createRequire(import.meta.url)
const bin = req('electron')
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const home = mkdtempSync(join(tmpdir(), 'pickdone-diagnostic-'))
const log = []
const sleep = ms => new Promise(r => setTimeout(r, ms))
const server = net.createServer()
await new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(0, '127.0.0.1', resolve)
})
const port = server.address().port
await new Promise(resolve => server.close(resolve))
let child
let targetSeen = false
let target = null
console.log('DIAG_START', JSON.stringify({port, isolated:true, electronExists:existsSync(bin), testHomeCreated:true}))
try {
  child = spawn(bin, ['.', '--no-focus', '--disable-gpu', '--no-sandbox', '--remote-debugging-port=' + port], {
    cwd: root,
    env: {...process.env, TODO_USER_DATA_DIR:home},
    windowsHide:true,
    stdio:['ignore','pipe','pipe']
  })
  const read = data => {
    const s=data.toString()
    log.push(s)
    if (log.length>200) log.shift()
  }
  child.stdout.on('data',read)
  child.stderr.on('data',read)
  child.on('error',e=>log.push('SPAWN_ERROR '+e.message))
  child.on('exit',(code,signal)=>log.push('CHILD_EXIT '+JSON.stringify({code,signal})))
  for(let i=0;i<70;i++){
    await sleep(500)
    try{
      const r=await fetch('http://127.0.0.1:'+port+'/json/list',{signal:AbortSignal.timeout(900)})
      const arr=await r.json()
      if(arr.length){
        targetSeen=true
        target=arr.find(x=>x.type==='page')
        console.log('CDP_TARGETS', JSON.stringify(arr.map(({type,url,title})=>({type,url:String(url).slice(0,200),title:String(title).slice(0,80)}))))
        break
      }
    } catch {}
    if(child.exitCode!==null) break
  }
  if(!targetSeen)console.log('CDP_NOT_READY',JSON.stringify({port,childExitCode:child.exitCode}))
  if(target?.webSocketDebuggerUrl){
    try {
      const ws=new WebSocket(target.webSocketDebuggerUrl)
      await Promise.race([new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject}),sleep(5000).then(()=>{throw Error('websocket_timeout')})])
      const expression="JSON.stringify({url:location.href,ready:document.readyState,hasShell:!!document.querySelector('.app-shell'),hasTodoAPI:!!window.todoAPI,vueErr:window.__lastVueErr?.msg||null})"
      const result=new Promise((resolve,reject)=>{
        ws.onmessage=e=>{const msg=JSON.parse(e.data); if(msg.id===1)resolve(msg.result?.result?.value||msg.error||msg.result)}
        ws.onerror=reject
      })
      await sleep(2500)
      ws.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{expression,returnByValue:true}}))
      console.log('RENDERER_STATE',JSON.stringify(await Promise.race([result,sleep(8000).then(()=>({error:'eval timeout'}))])))
      ws.close()
    }catch(e){console.log('CDP_EVAL_ERROR',String(e.message||e))}
  }
  console.log('APP_LOG_TAIL',log.join('').slice(-7200))
} finally {
  if(child && child.pid){
    if(process.platform==='win32'){
      const killer=spawn('taskkill',['/PID',String(child.pid),'/T','/F'],{stdio:'ignore',windowsHide:true})
      await Promise.race([new Promise(resolve=>killer.on('close',resolve)), sleep(7000)])
    } else {try{child.kill('SIGTERM')}catch{}}
  }
  await sleep(1000)
  try{rmSync(home,{recursive:true,force:true})}catch(e){console.error('WARN_TEMP_CLEANUP',e.message)}
}
process.exitCode=targetSeen?0:1
