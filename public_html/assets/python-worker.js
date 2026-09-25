'use strict';
const indexURL='https://cdn.jsdelivr.net/pyodide/v314.0.7/full/';
let runtimePromise;
async function runtime(){
  if(!runtimePromise)runtimePromise=(async()=>{importScripts(indexURL+'pyodide.js');return loadPyodide({indexURL});})();
  return runtimePromise;
}
self.onmessage=async event=>{
  if(event.data?.type!=='run')return;
  try{
    const pyodide=await runtime();
    pyodide.setStdout({batched:value=>self.postMessage({type:'stdout',value:value+'\n'})});
    pyodide.setStderr({batched:value=>self.postMessage({type:'stderr',value:value+'\n'})});
    pyodide.globals.set('__kourage_stdin',String(event.data.stdin||''));
    await pyodide.runPythonAsync("import io, sys\nsys.stdin = io.StringIO(__kourage_stdin)\n");
    await pyodide.loadPackagesFromImports(String(event.data.code||''));
    await pyodide.runPythonAsync(String(event.data.code||''),{filename:String(event.data.filename||'main.py')});
    self.postMessage({type:'done'});
  }catch(error){self.postMessage({type:'error',value:String(error?.message||error)});}
};
