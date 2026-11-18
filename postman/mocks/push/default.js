// Local provider contract fixtures. No real provider keys or device tokens.
const http = require('http');
const counts = new Map();
http.createServer(async (req, res) => {
  const send = (status, body) => { res.writeHead(status, {'content-type':'application/json'}); res.end(body ? JSON.stringify(body) : ''); };
  if(req.method !== 'POST') return send(501, {error:'Endpoint not modeled'});
  if(req.url.startsWith('/3/device/')) {
    const token = req.url.split('/').pop();
    if(!req.headers.authorization?.startsWith('bearer ') || !req.headers['apns-topic']) return send(400, {reason:'MissingTopic'});
    let body = req.body;
    if(!body) { let raw=''; for await(const chunk of req)raw+=chunk; try {body=JSON.parse(raw);} catch{} }
    if(typeof body === 'string') { try {body=JSON.parse(body);} catch{} }
    const aps = body?.aps || {};
    if(req.headers['apns-push-type'] === 'background') {
      // Background pushes must be low priority and carry nothing the user would see.
      if(req.headers['apns-priority'] !== '5' || JSON.stringify(aps) !== '{"content-available":1}' || !body.sync) return send(400, {reason:'BadPriority'});
      return send(200);
    }
    if(req.headers['apns-push-type'] !== 'alert' || !['5','10'].includes(req.headers['apns-priority'])) return send(400, {reason:'InvalidPushType'});
    if(!aps.alert?.body || !aps['thread-id'] || !aps.category) return send(400, {reason:'PayloadEmpty'});
    if(!['passive','active','time-sensitive'].includes(aps['interruption-level'])) return send(400, {reason:'BadInterruptionLevel'});
    if(!(aps['relevance-score'] >= 0 && aps['relevance-score'] <= 1)) return send(400, {reason:'BadRelevanceScore'});
    if(token.startsWith('ee')) return send(410, {reason:'Unregistered', timestamp:Date.now()});
    if(token.startsWith('bb')) return send(403, {reason:'InvalidProviderToken'});
    if(token.startsWith('ff')) {
      const count = counts.get(token) || 0; counts.set(token, count+1);
      if(count === 0) return send(503, {reason:'ServiceUnavailable'});
    }
    return send(200);
  }
  if(req.url.startsWith('/web/')) {
    if(req.headers['content-encoding'] !== 'aes128gcm' || !req.headers.authorization?.startsWith('vapid ') || !req.headers.ttl) return send(400, {error:'Missing Web Push headers'});
    return send(201);
  }
  send(501, {error:'Endpoint not modeled'});
}).listen(process.env.PORT || 4903);
