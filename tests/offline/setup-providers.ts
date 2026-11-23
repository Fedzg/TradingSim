// Only loaded by the isolated container audit.
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url=new URL(String(input));
  if (url.hostname==="api.twelvedata.com" && url.pathname==="/time_series")
    return Response.json({meta:{symbol:"EUR/USD",interval:"15min"},values:[{datetime:"2026-11-23 11:00:00",open:"1",high:"1",low:"1",close:"1"}]});
  if (url.hostname==="goldapi.dev")
    return Response.json({metal:"XAU",currency:"USD",price:100,updatedAt:"2026-11-23T11:00:00Z"});
  if (url.hostname==="api.telegram.org" && url.pathname.endsWith("/getChat"))
    return Response.json({ok:true,result:{id:123}});
  throw new Error("Richiesta inattesa nella fixture");
}) as typeof fetch;
