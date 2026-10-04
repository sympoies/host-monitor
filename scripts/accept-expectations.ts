// Resource assertions for installed-data acceptance. Fixture interaction is covered by accept-detail.ts.
export const EXTERNAL_RESOURCE_TEXT='Beszel';
export const AGENTLESS_TEXT='僅 ssh 基本資訊';
export type ResourceExpectation=
 |{resources:'collected';metrics:number;diskRows:boolean}
 |{resources:'external'|'agentless';metrics:number;diskRows:boolean;text:string};
interface BeszelReading{status:string;disks:unknown[];gpus?:unknown[]}
export function resourceExpectation(snapshot:{resources?:unknown;agentless?:unknown}|null|undefined,beszel?:BeszelReading):ResourceExpectation{
 if(!snapshot)throw Error('host has no snapshot');
 if(snapshot.resources==='external')return {resources:'external',metrics:3+(beszel?.status==='ok'&&beszel.gpus?.length?beszel.gpus.length:1),diskRows:beszel?.status==='ok'&&beszel.disks.length>0,text:EXTERNAL_RESOURCE_TEXT};
 if(snapshot.agentless===true)return {resources:'agentless',metrics:2,diskRows:false,text:AGENTLESS_TEXT};
 return {resources:'collected',metrics:4,diskRows:true};
}
