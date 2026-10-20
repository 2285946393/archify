import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {captureAtomicOutput,captureRegularFileBinding,publishRegularFileBinding,releaseRegularFileBinding,removeOwnedRegularFile,quarantineRemoveRegularFileBinding} from '../renderers/shared/atomic-output.mjs';

export function writeStoryOutput(file,content,guard=()=>{},{createOnly=false}={}){
  const failure=result=>{throw Object.assign(new Error('Story output could not be published: '+(result.reason?.code||result.status)),{archifyDiagnostics:[{code:'story/output-publication',severity:'error',message:'The output changed or could not be published safely.',subject:{output:file},evidence:{reason:result.reason||result.status},supportedFixes:['Check the output location and retry with a distinct writable path.']}]});};
  guard();fs.mkdirSync(path.dirname(file),{recursive:true});
  const output=captureAtomicOutput(file);if(output.status!=='captured')failure(output);
  if(createOnly&&output.snapshot.target.kind!=='absent')throw Error('Draft output already exists; choose a new brief path.');
  const temporary=path.join(path.dirname(output.commitPath),'.archify-story-'+randomUUID()+'.tmp');
  const bytes=Buffer.byteLength(content),sha256=createHash('sha256').update(content).digest('hex');
  let descriptor,identity,binding;
  try{
    descriptor=fs.openSync(temporary,'wx',output.mode??0o666);const stat=fs.fstatSync(descriptor,{bigint:true});identity={device:stat.dev,inode:stat.ino};
    fs.writeFileSync(descriptor,content);if(output.mode!==null)fs.fchmodSync(descriptor,output.mode);fs.closeSync(descriptor);descriptor=undefined;
    guard();
    const candidate=captureRegularFileBinding(temporary,{subject:'story-candidate',expectedIdentity:identity,expectedBytes:bytes,expectedSha256:sha256});
    if(candidate.status!=='captured')failure(candidate);binding=candidate.binding;
    const published=publishRegularFileBinding(binding,temporary,output.snapshot,{subject:'story-candidate'});
    if(!['committed','committed-with-warning'].includes(published.status))failure(published);
  }finally{
    if(descriptor!==undefined)fs.closeSync(descriptor);
    let released,removed;
    try{if(binding)released=releaseRegularFileBinding(binding);}
    finally{if(identity)removed=removeOwnedRegularFile(temporary,identity,{subject:'story-candidate'});}
    if(released&&released.status!=='released')failure(released);
    if(removed&&!['removed','absent','preserved'].includes(removed.status))failure(removed);
  }
  return {file:output.commitPath,identity,bytes,sha256};
}

export function rollbackStoryOutput(output){
  const owned=captureRegularFileBinding(output.file,{subject:'story-companion',expectedIdentity:output.identity,expectedBytes:output.bytes,expectedSha256:output.sha256});
  if(owned.status!=='captured')return {status:owned.reason?.systemCode==='ENOENT'?'absent':['different','unsupported'].includes(owned.status)?'preserved':owned.status};
  try{return quarantineRemoveRegularFileBinding(owned.binding,output.file,{subject:'story-companion'});}
  finally{if(releaseRegularFileBinding(owned.binding).status!=='released')throw Error('The source map rollback handle could not be released.');}
}
