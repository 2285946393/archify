import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {ChromeVisualBrowser,findChrome} from '../archify/bin/visual-check.mjs';

const skill=fileURLToPath(new URL('../archify/',import.meta.url)),chrome=process.env.ARCHIFY_CHROME?findChrome():null;
test('a public story attaches once, follows native appearance and retains source notes and exports',{
  skip:chrome?false:'Set ARCHIFY_CHROME for the real-browser story check.',
},async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'archify-story-browser-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const source=path.join(dir,'source.html'),plan=path.join(dir,'brief.json'),output=path.join(dir,'enhanced.html'),cli=path.join(skill,'bin/archify.mjs');
  execFileSync(process.execPath,[cli,'render','workflow',path.join(skill,'examples/agent-tool-call.workflow.json'),source]);
  const receipt=JSON.parse(execFileSync(process.execPath,[cli,'story','draft',source,plan,'--json'],{encoding:'utf8'})),facts=JSON.parse(fs.readFileSync(receipt.sourceMap,'utf8')),edge=facts.edges[0];
  fs.writeFileSync(plan,JSON.stringify({version:2,title:'Explain one source handoff',intro:'Establish its context.',outro:'Return to the complete graph.',scenes:[{title:'Read the selected relationship',points:[{anchor:edge.to,via:edge.id,title:'Follow this handoff',text:'The explanation uses the native relationship and its original endpoints.',figureCaption:'The original endpoints retain their direction.'}]}]}));
  execFileSync(process.execPath,[cli,'story','attach',source,plan,output,'--json']);
  const browser=new ChromeVisualBrowser(chrome);t.after(()=>browser.close());const session=await browser.sessionPromise,errors=[];
  browser.cdp.subscribe(event=>{if(event.method==='Runtime.exceptionThrown')errors.push(event.params.exceptionDetails.exception?.description||event.params.exceptionDetails.text);});
  const send=(method,params={})=>browser.cdp.send(method,params,session,30000);
  async function evaluate(expression,awaitPromise=false){const result=await send('Runtime.evaluate',{expression,awaitPromise,returnByValue:true,userGesture:true});assert.equal(result.exceptionDetails,undefined,result.exceptionDetails?.exception?.description);return result.result?.value;}
  await send('Network.enable');await send('Network.setBlockedURLs',{urls:['http://*','https://*','ws://*','wss://*']});
  await send('Emulation.setDeviceMetricsOverride',{width:981,height:815,deviceScaleFactor:1,mobile:false});
  const loaded=browser.cdp.waitFor('Page.loadEventFired',session);await send('Page.navigate',{url:pathToFileURL(output).href});await loaded;
  await evaluate('document.fonts.ready',true);
  const snapshot='[...document.querySelectorAll(".diagram-container > svg [data-node-id],.diagram-container > svg [data-edge-from]")].map(node=>[node.dataset.nodeId,node.dataset.edgeId,node.dataset.edgeFrom,node.dataset.edgeTo])';
  const original=await evaluate(snapshot);assert.equal(await evaluate('document.querySelectorAll("iframe").length'),0);
  const exportsBefore=await evaluate('[...document.querySelectorAll("#export-menu [data-format]")].map(button=>[button.dataset.format,button.textContent,button.hidden,button.disabled])');
  await evaluate('window.nativeNotes=document.querySelector("#reader-rail > .cards");Archify.story.setView("live")',true);
  await evaluate('document.querySelector("#btn-motion").click()');assert.equal(await evaluate('Archify.motionGovernor.mode()'),'still');
  const loadingControls=await evaluate('document.querySelector("#btn-motion").click();[...document.querySelectorAll(".story-panel-controls button,.story-panel-controls input")].map(control=>control.disabled)');
  assert.ok(loadingControls.every(Boolean),'playback controls wait until the story is ready');
  await evaluate('(async()=>{for(let i=0;i<300&&!document.querySelector(".story-panel iframe")?.contentWindow?.storyReady;i++)await new Promise(resolve=>setTimeout(resolve,20));if(!document.querySelector(".story-panel iframe")?.contentWindow?.storyReady)throw Error("Story did not initialize");Archify.story.setSound(false);Archify.story.seek(8);})()',true);
  assert.equal(await evaluate('document.querySelector(".story-notes")===window.nativeNotes'),true);
  assert.equal(await evaluate('[...document.querySelectorAll(".story-panel-controls button,.story-panel-controls input")].some(control=>control.disabled)'),false);
  assert.equal(await evaluate('document.querySelector(".story-panel iframe").contentDocument.querySelector(".figure-caption").textContent'),'The original endpoints retain their direction.');
  for(const preset of ['classic','signal-flow','blueprint','editorial'])for(const theme of ['light','dark']){
    await evaluate(`document.querySelector('[data-preset-value="${preset}"]').click();if(document.documentElement.dataset.theme!==${JSON.stringify(theme)})document.querySelector('#btn-theme').click();`);
    await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))',true);
    const state=await evaluate('(()=>{const win=document.querySelector(".story-panel iframe").contentWindow,doc=win.document,shape=win.getComputedStyle(doc.querySelector(".note-diagram [data-figure-node-id]")),id=doc.querySelector(".note-diagram [data-figure-node-id]").dataset.figureNodeId,native=getComputedStyle(document.querySelector(`.diagram-container > svg [data-node-id="${id}"] rect[data-animate="node"]`));return {preset:doc.documentElement.dataset.preset,theme:doc.documentElement.dataset.theme,time:win.Story.metrics().audioTime,source:[native.fill,native.stroke],figure:[shape.fill,shape.stroke]};})()');
    assert.equal(state.preset,preset);assert.equal(state.theme,theme);assert.equal(state.time,8);assert.deepEqual(state.source,state.figure);
  }
  const scrub=await evaluate('(()=>{const range=document.querySelector(".story-panel input");range.dispatchEvent(new Event("pointerdown"));range.value=9;range.dispatchEvent(new Event("input"));range.dispatchEvent(new Event("change"));return Archify.story.state().time;})()');assert.equal(scrub,9);
  const png=await evaluate('(async()=>{const task=Archify.story.exportPNG({time:9});document.querySelector("[data-preset-value=classic]").click();if(document.documentElement.dataset.theme!=="light")document.querySelector("#btn-theme").click();const image=await createImageBitmap(await task),canvas=document.createElement("canvas");canvas.width=canvas.height=1;canvas.getContext("2d").drawImage(image,0,0);const pixel=[...canvas.getContext("2d").getImageData(0,0,1,1).data];return {width:image.width,height:image.height,pixel};})()',true);
  assert.equal(png.width,1920);assert.equal(png.height,1080);assert.ok(Math.max(...png.pixel.slice(0,3))<70,'export retains the dark appearance selected when it started');
  const video=await evaluate(`(async()=>{
    const blob=await Archify.story.exportVideo({start:0,seconds:.5}),url=URL.createObjectURL(blob),video=document.createElement('video');
    try{
      video.muted=true;video.src=url;
      await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Story video decode timed out')),5000);video.onloadeddata=()=>{clearTimeout(timer);resolve();};video.onerror=()=>{clearTimeout(timer);reject(Error('Story video could not be decoded'));};});
      const stream=video.captureStream(),audioTracks=stream.getAudioTracks().length;
      for(const track of stream.getTracks())track.stop();
      const bytes=new Uint8Array(await blob.arrayBuffer());let binary='';
      for(let at=0;at<bytes.length;at+=32768)binary+=String.fromCharCode(...bytes.subarray(at,at+32768));
      return {width:video.videoWidth,height:video.videoHeight,duration:video.duration,audioTracks,base64:btoa(binary)};
    }finally{video.removeAttribute('src');video.load();URL.revokeObjectURL(url);}
  })()`,true);
  assert.equal(video.width,1920);assert.equal(video.height,1080);assert.ok(Math.abs(video.duration-.5)<.05,'export contains the requested video interval');
  assert.equal(video.audioTracks,1,'the playable video retains its audio track');
  if(process.env.ARCHIFY_FFMPEG){
    const file=path.join(dir,'story.webm');fs.writeFileSync(file,Buffer.from(video.base64,'base64'));
    const decoded=spawnSync(process.env.ARCHIFY_FFMPEG,['-v','error','-i',file,'-map','0:a:0','-f','f32le','-ac','2','-ar','48000','-'],{timeout:15000});
    assert.equal(decoded.status,0,decoded.stderr?.toString());assert.equal(decoded.stderr.toString(),'','the audio timeline decodes without timestamp errors');const sound=decoded.stdout;
    assert.ok(Math.abs(sound.length/(48000*2*4)-.5)<.05,'the exported stereo audio decodes for the requested interval');
    assert.ok(sound.some(byte=>byte!==0),'the exported soundtrack contains sound');
  }
  await evaluate('Archify.exportMenu.run("svg")',true);assert.equal(await evaluate('document.documentElement.dataset.lastExportCanonical'),'true');
  assert.deepEqual(await evaluate('[...document.querySelectorAll("#export-menu [data-format]")].map(button=>[button.dataset.format,button.textContent,button.hidden,button.disabled])'),exportsBefore);
  assert.equal(await evaluate('[...document.querySelectorAll("#export-menu button")].at(-1).dataset.action'),'story-video');
  await evaluate('Archify.story.setView("live")',true);assert.deepEqual(await evaluate(snapshot),original);assert.equal(await evaluate('document.querySelector("#reader-rail > .cards")===window.nativeNotes'),true);
  await evaluate('Promise.all([Archify.story.setView("story"),Archify.story.setView("still")])',true);assert.equal(await evaluate('Archify.story.state().view'),'native');
  await evaluate('Promise.all([Archify.story.play(),Archify.story.setView("still")])',true);
  assert.equal(await evaluate('Archify.story.state().view'),'native');assert.equal(await evaluate('Archify.story.state().playing'),false,'switching away cancels a pending play request');
  assert.deepEqual(errors,[]);
});
