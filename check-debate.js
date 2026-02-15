const API = 'https://botxchange.ai';
async function run() {
  const auth = await fetch(API + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'harrison@exchange.com', password: 'test123' }) }).then(r => r.json());
  const h = { 'Authorization': 'Bearer ' + auth.token };
  const r = await fetch(API + '/api/debate/latest', { headers: h }).then(r => r.json());
  console.log(JSON.stringify(r, null, 2));
}
run();
