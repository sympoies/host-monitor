// What the browser acceptance expects the dashboard to render for one host's resources.
// It mirrors public/app.ts: a snapshot whose `resources` is 'external' (macOS; resource
// metrics owned by Beszel, fleet-infra decision 0002) shows a pointer instead of metrics,
// and any other snapshot, including one from before the optional field existed, is collected.
export const EXTERNAL_RESOURCE_TEXT='Beszel';

export type ResourceExpectation=
 |{resources:'collected',metrics:4,diskRows:true}
 |{resources:'external',metrics:2,diskRows:false,text:typeof EXTERNAL_RESOURCE_TEXT};

export function resourceExpectation(snapshot:{resources?:unknown}|null|undefined):ResourceExpectation{
 if(!snapshot)throw Error('host has no snapshot');
 return snapshot.resources==='external'
  ?{resources:'external',metrics:2,diskRows:false,text:EXTERNAL_RESOURCE_TEXT}
  :{resources:'collected',metrics:4,diskRows:true};
}
