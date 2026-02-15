const API = 'https://botxchange.ai';

async function run() {
  // Wait for work loop to finish
  console.log('Waiting for work loop to finish...');
  for (let i = 0; i < 10; i++) {
    const status = await fetch(API + '/api/system/status').then(r => r.json());
    if (status.workLoop.isRunningWork === false) {
      console.log('Work loop idle. Launching pipeline...');
      break;
    }
    console.log('Still running... waiting 15s');
    await new Promise(r => setTimeout(r, 15000));
  }

  const auth = await fetch(API + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'harrison@exchange.com', password: 'test123' })
  }).then(r => r.json());

  const h = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + auth.token };

  console.log('Triggering deployment pipeline...');
  const trigger = await fetch(API + '/api/deploy/full-pipeline', { method: 'POST', headers: h, body: JSON.stringify({}) }).then(r => r.json());
  console.log(trigger);

  // Check every 30s
  for (let i = 0; i < 8; i++) {
    await new Promise(r => setTimeout(r, 30000));
    const products = await fetch(API + '/api/products').then(r => r.json());
    const activity = await fetch(API + '/api/activity/recent', { headers: h }).then(r => r.json());
    const latest = activity[0] ? (activity[0].action || activity[0].title) : 'none';
    console.log('Check ' + (i + 1) + ': ' + products.length + ' products | Latest: ' + latest);
    if (products.length > 0) {
      products.forEach(p => console.log('  > ' + p.title + ' -> /products/' + p.slug));
      break;
    }
  }
}

run().catch(e => console.error(e));
