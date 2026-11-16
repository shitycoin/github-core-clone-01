let d=0,r=0; export const nextDatabaseId=()=>++d; export const nextRequestId=()=>`req-${++r}`;
/** Standard base64 is used for GraphQL global ids. */ export const globalId=(t:string,id:number|string)=>Buffer.from(`${t}:${id}`).toString('base64');
export function decodeGlobalId(g:string){try{const s=Buffer.from(g,'base64').toString(),i=s.indexOf(':');return i>0?{type:s.slice(0,i),id:s.slice(i+1)}:null;}catch{return null;}}
