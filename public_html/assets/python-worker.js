import { loadPyodide } from 'https://cdn.jsdelivr.net/pyodide/v314.0.7/full/pyodide.mjs';

const indexURL='https://cdn.jsdelivr.net/pyodide/v314.0.7/full/';
let runtimePromise;
async function runtime(){
  if(!runtimePromise)runtimePromise=loadPyodide({indexURL});
  return runtimePromise;
}
self.onmessage=async event=>{
  if(event.data?.type!=='run')return;
  try{
    const pyodide=await runtime();
    pyodide.setStdout({batched:value=>self.postMessage({type:'stdout',value:value+'\n'})});
    pyodide.setStderr({batched:value=>self.postMessage({type:'stderr',value:value+'\n'})});
    const workspace='/home/pyodide/workspace';
    pyodide.FS.mkdirTree(workspace);
    const cleanPath=value=>String(value||'').replace(/\\/g,'/').split('/').filter(part=>part&&part!=='.'&&part!=='..').join('/');
    for(const file of Array.isArray(event.data.files)?event.data.files:[]){const relative=cleanPath(file.path);if(!relative)continue;const parts=relative.split('/');parts.pop();if(parts.length)pyodide.FS.mkdirTree(workspace+'/'+parts.join('/'));pyodide.FS.writeFile(workspace+'/'+relative,String(file.content||''),{encoding:'utf8'});}
    const mainPath=cleanPath(event.data.filename)||'main.py',mainParts=mainPath.split('/'),mainName=mainParts.pop()||'main.py',mainDirectory=workspace+(mainParts.length?'/'+mainParts.join('/'):'');
    pyodide.FS.mkdirTree(mainDirectory);pyodide.FS.writeFile(mainDirectory+'/'+mainName,String(event.data.code||''),{encoding:'utf8'});pyodide.FS.chdir(mainDirectory);
    pyodide.globals.set('__kourage_stdin',String(event.data.stdin||''));
    await pyodide.runPythonAsync("import io, sys\nsys.stdin = io.StringIO(__kourage_stdin)\n");
    await pyodide.loadPackagesFromImports(String(event.data.code||''));
    await pyodide.runPythonAsync(String(event.data.code||''),{filename:mainName});
    self.postMessage({type:'done'});
  }catch(error){self.postMessage({type:'error',value:String(error?.message||error)});}
};
