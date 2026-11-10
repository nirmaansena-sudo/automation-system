import fs from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { audit } from '../core/base.js';
import { exportInventory, prepareBusinessExport, cleanupStaleExports } from '../domain/exports.js';

export function registerExports(r) {
  const allowed={auth:'any',roles:['owner','manager']};
  cleanupStaleExports();
  r.get('/api/exports/inventory',allowed,()=>exportInventory());
  const download=format=>async ctx=>{
    const ac=new AbortController();let report;
    const disconnected=()=>{if(!ctx.res.writableFinished)ac.abort();};ctx.res.once('close',disconnected);
    try{
      audit(`user:${ctx.user.id}`,'data.business_export_requested','export',null,{format});
      report=await prepareBusinessExport(format,{signal:ac.signal});
      if(ctx.res.destroyed)return;
      ctx.res.writeHead(200,{'Content-Type':format==='zip'?'application/zip':'application/json; charset=utf-8','Content-Disposition':`attachment; filename="${report.filename}"`,'Content-Length':report.size,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Export-SHA256':report.sha256});
      ctx.headersSent=true;
      await pipeline(fs.createReadStream(report.file),ctx.res,{signal:ac.signal});
    }catch(error){if(!ctx.res.destroyed)throw error;}
    finally{ctx.res.removeListener('close',disconnected);report?.cleanup();}
  };
  r.get('/api/exports/business.json',allowed,download('json'));
  r.get('/api/exports/business.zip',allowed,download('zip'));
}
