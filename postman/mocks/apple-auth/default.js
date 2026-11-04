// Local contract simulation. Keys are ephemeral test keys, never Apple credentials.
const http = require('http');
const crypto = require('crypto');
const pair = crypto.generateKeyPairSync('rsa', {modulusLength:2048});
const jwk = {...pair.publicKey.export({format:'jwk'}),kid:'simulation-key',alg:'RS256',use:'sig'};
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
http.createServer(async(req,res)=>{
  const send=(status,body)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(body));};
  if(req.url==='/auth/keys'&&req.method==='GET')return send(200,{keys:[jwk]});
  if(req.url==='/auth/revoke'&&req.method==='POST')return send(200,{});
  if(req.url==='/auth/token'&&req.method==='POST'){
    let body=req.body;
    if(!body){let raw='';for await(const chunk of req)raw+=chunk;body=Object.fromEntries(new URLSearchParams(raw));}
    if(typeof body==='string')body=Object.fromEntries(new URLSearchParams(body));
    if(!body.client_secret||!body.client_id||body.grant_type!=='authorization_code')return send(400,{error:'invalid_request'});
    if(body.code==='invalid-grant')return send(400,{error:'invalid_grant'});
    if(body.code==='server-error')return send(503,{error:'temporarily_unavailable'});
    try{
      const fixture=JSON.parse(Buffer.from(body.code,'base64url').toString());
      const timestamp=Math.floor(Date.now()/1000);
      const claims={iss:fixture.issuer||'https://appleid.apple.com',aud:fixture.aud||body.client_id,iat:timestamp,exp:timestamp+(fixture.exp_offset??300),sub:fixture.sub||'test-apple-user',nonce:fixture.nonce,email:'apple@example.test'};
      const payload=encode({alg:'RS256',kid:'simulation-key'})+'.'+encode(claims);
      let signature=crypto.sign('RSA-SHA256',Buffer.from(payload),pair.privateKey).toString('base64url');
      if(fixture.bad_signature)signature='invalid';
      return send(200,{access_token:'simulation-access',refresh_token:'simulation-refresh',token_type:'Bearer',expires_in:3600,id_token:payload+'.'+signature});
    }catch{return send(400,{error:'invalid_grant'});}
  }
  send(501,{error:'Endpoint not modeled by this contract simulation'});
}).listen(process.env.PORT||4901);
