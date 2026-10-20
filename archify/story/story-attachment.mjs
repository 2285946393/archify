import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const here=path.dirname(fileURLToPath(import.meta.url));
export function attachStory(nativeHtml,storyHtml){
  if(/id=["']archify-story-payload["']/.test(nativeHtml))throw Error('This HTML already contains a story; use the original native HTML to rebuild.');
  if(!/<\/body\s*>/i.test(nativeHtml))throw Error('The native HTML needs a body element.');
  const payload=JSON.stringify({version:1,html:Buffer.from(storyHtml).toString('base64')});
  const addon='<style id="archify-story-attachment-style">'+fs.readFileSync(path.join(here,'story-attachment.css'),'utf8')+'</style><script id="archify-story-payload" type="application/json">'+payload+'</script><script>'+fs.readFileSync(path.join(here,'story-attachment.js'),'utf8')+'</script>';
  return nativeHtml.replace(/<\/body\s*>/i,closing=>addon+closing);
}
