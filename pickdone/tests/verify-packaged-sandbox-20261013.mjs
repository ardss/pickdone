/**
 * Isolated smoke for the locally unpacked Windows app.
 * Runs on a local NTFS temp directory with normal Chromium sandbox enabled.
 * Never opens or writes the user's production Todo userData.
 */
import { promises as fs } from 'node:fs'
import { existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const root = dirname(dirname(fileURLToPath(import.meta.url)))
if (!process.argv[2]) { console.error('Usage: node tests/verify-packaged-sandbox-20261013.mjs dist/<build>/win-unpacked'); process.exit(2) }
const buildDir = join(root,process.argv[2]) // Explicit build: never silently test an older artifact
const temp = await fs.mkdtemp(join(tmpdir(), 'pickdone-packaged-smoke-'))
const app = join(temp, 'app')
const userData = join(temp,'userData')
const reportFile = join(root, 'tests/.artifacts/packaged-normal-sandbox-smoke.log')
const sleep = ms => new Promise(r=>setTimeout(r,ms))
const logs = []
let child, ws, seq=1
const pending=new Map()
const trace = message => { console.log(message); logs.push(message) }
const portFree=async()=>{
 const server=createServer()
 await new Promise((resolve,reject)=>server.once('error',reject).listen(0,'127.0.0.1',resolve))
 const n=server.address().port
 await new Promise(resolve=>server.close(resolve))
 return n
}
let port=0
async function launch(){
 port=await portFree()
 child=spawn(join(app, existsSync(join(app,'PickDone.exe'))?'PickDone.exe':'electron.exe'),
   ['--no-focus','--remote-debugging-address=127.0.0.1','--remote-debugging-port='+port],{
     cwd:app, windowsHide:true, shell:false,
     env:{...process.env, TODO_USER_DATA_DIR:userData, PICKDONE_MULTI:'1'},
     stdio:['ignore','pipe','pipe']
   })
 child.stdout.on('data', b=>logs.push('STDOUT '+String(b).slice(-450)))
 child.stderr.on('data', b=>logs.push('STDERR '+String(b).slice(-450)))
 child.on('error', e=>logs.push('CHILD_ERROR '+e.message))
 let target
 let lastTargets='unreachable'
 for(let i=0;i<110;i++){
   if(child.exitCode!==null)break
   await sleep(500)
   try{
     const resp=await fetch('http://127.0.0.1:'+port+'/json/list',{signal:AbortSignal.timeout(900)})
     const arr=await resp.json()
     lastTargets=arr.map(x=>x.type+':'+String(x.url).slice(0,130)).join(' | ') || 'CDP connected; no targets'
     target=arr.find(x=>x.type==='page' && /app:\/\//.test(x.url))
     if(target)break
   }catch{}
 }
 if(!target)throw Error('normal-sandbox packaged Electron did not expose app:// CDP; exit='+child.exitCode+'; targets='+lastTargets+'; output='+logs.slice(-8).join(' '))
 ws=new WebSocket(target.webSocketDebuggerUrl)
 await Promise.race([new Promise((resolve,reject)=>{ws.onopen=resolve; ws.onerror=reject}),sleep(7000).then(()=>{throw Error('CDP websocket timeout')})])
 ws.onmessage=e=>{const x=JSON.parse(e.data);if(x.id&&pending.has(x.id)){pending.get(x.id)(x);pending.delete(x.id)}}
 for(let i=0;i<80;i++){
   try {if(await evalCDP("!!document.querySelector('.app-shell') && !!document.querySelector('.qa-input')"))return}
   catch{}
   await sleep(500)
 }
 throw Error('normal-sandbox app page opened but Vue shell not ready')
}
function evalCDP(expression){
 if(!ws || ws.readyState!==WebSocket.OPEN)throw Error('WebSocket disconnected')
 const id=seq++
 const p=new Promise((resolve,reject)=>pending.set(id, x=>{
   if(x.error||x.result?.exceptionDetails)reject(Error(JSON.stringify(x.error||x.result.exceptionDetails)))
   else {try{resolve(JSON.parse(x.result?.result?.value||'null'))}catch(e){reject(e)}}
 }))
 ws.send(JSON.stringify({id,method:'Runtime.evaluate',params:{
   expression:'(async()=>JSON.stringify(await ('+expression+')))()',awaitPromise:true,returnByValue:true}}))
 return Promise.race([p,sleep(10000).then(()=>{throw Error('CDP eval timeout')})])
}
async function stop(){
 try{ws?.close()}catch{}
 ws=null
 if(child?.pid && child.exitCode===null){
  const killer=spawn('taskkill',['/PID',String(child.pid),'/T','/F'],{stdio:'ignore',windowsHide:true})
  await Promise.race([new Promise(resolve=>killer.once('close',resolve)),sleep(7000)])
 }
 child=null
 await sleep(1000)
}
let passed=false
try{
 if((!existsSync(join(buildDir,'electron.exe')) && !existsSync(join(buildDir,'PickDone.exe')))||!existsSync(join(buildDir,'resources/app.asar')))
   throw Error('unpacked output incomplete: missing Electron binary or app.asar')
 trace('COPY '+buildDir+' into isolated local TEMP; normal sandbox enabled')
 await fs.cp(buildDir,app,{recursive:true,force:true})
 await fs.mkdir(userData,{recursive:true})
 await launch()
 const first=await evalCDP("({url:location.href,hasAPI:!!window.todoAPI,vueErr:window.__lastVueErr?.msg||null})")
 trace('BOOT '+JSON.stringify(first))
 if(!first.hasAPI||first.vueErr)throw Error('renderer API error: '+JSON.stringify(first))
 const created=await evalCDP(`(()=>{let el=document.querySelector('.qa-input');el.focus();el.value='合成打包测试20261013';el.dispatchEvent(new Event('input',{bubbles:true}));let e=new KeyboardEvent('keyup',{key:'Enter',keyCode:13,bubbles:true});Object.defineProperty(e,'isComposing',{value:false});el.dispatchEvent(e);return true})()`)
 await sleep(1600)
 const found=await evalCDP(`(await window.todoAPI.dbCall('getAll',{})).some(x=>x.taskContent==='合成打包测试20261013')`)
 trace('QUICK_ADD '+JSON.stringify({created,found}))
 if(!found)throw Error('packaged quick-add did not persist')
 await stop()
 await launch()
 const after=await evalCDP(`(await window.todoAPI.dbCall('getAll',{})).some(x=>x.taskContent==='合成打包测试20261013')`)
 trace('RESTART '+JSON.stringify({persistent:after}))
 if(!after)throw Error('packaged data disappeared after relaunch')
 const screen = await new Promise((resolve,reject)=>{
   const id=seq++;pending.set(id,x=>x.result?.data?resolve(x.result.data):reject(Error('CDP screenshot unavailable')))
   ws.send(JSON.stringify({id,method:'Page.captureScreenshot',params:{format:'png'}}))
 })
 mkdirSync(join(root,'tests/.artifacts'),{recursive:true})
 await fs.writeFile(join(root,'tests/.artifacts/packaged-normal-sandbox-smoke.png'),Buffer.from(screen,'base64'))
 passed=true
 trace('PASS: packaged normal-sandbox startup, synthetic quick-add, process-restart persistence')
}catch(e){
 trace('FAIL '+(e.stack||String(e)))
 process.exitCode=1
}finally{
 await stop()
 mkdirSync(join(root,'tests/.artifacts'),{recursive:true})
 await fs.writeFile(reportFile,logs.join('\n'))
 // Windows can hold executable handles briefly after taskkill closes the tree.
 // Retry ONLY this test run's isolated TEMP path, never production userData.
 await fs.rm(temp,{recursive:true,force:true,maxRetries:12,retryDelay:500})
   .catch(e=>trace('CLEANUP_WARN '+e.message))
}
if(!passed)process.exitCode=1
