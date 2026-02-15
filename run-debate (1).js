const API = 'https://botxchange.ai';

async function run() {
  // Login
  const auth = await fetch(API + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'harrison@exchange.com', password: 'test123' })
  }).then(r => r.json());
  
  const h = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + auth.token };

  // Step 1: Pause work loop
  console.log('1. Pausing work loop...');
  const pause = await fetch(API + '/api/system/pause-work-loop', { method: 'POST', headers: h }).then(r => r.json());
  console.log('   ', pause.message || pause.error);

  // Step 2: Wait 10 seconds for any in-progress work to finish
  console.log('2. Waiting 10s for rate limits to cool...');
  await new Promise(r => setTimeout(r, 10000));

  // Step 3: Trigger debate
  console.log('3. Starting strategic debate...');
  const debate = await fetch(API + '/api/debate/run', { method: 'POST', headers: h, body: JSON.stringify({}) }).then(r => r.json());
  console.log('   ', debate.message || debate.error);

  // Step 4: Poll for results
  console.log('4. Waiting for debate to complete (checking every 30s)...');
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 30000));
    const result = await fetch(API + '/api/debate/latest', { headers: { 'Authorization': 'Bearer ' + auth.token } }).then(r => r.json());
    
    if (result.found) {
      console.log('\n✅ DEBATE COMPLETE!\n');
      
      if (result.portfolio && result.portfolio.portfolio) {
        result.portfolio.portfolio.forEach(v => {
          console.log(`[${v.tier.toUpperCase()}] ${v.name}`);
          console.log(`  Revenue: ${v.revenueModel}`);
          console.log(`  Projection: ${JSON.stringify(v.revenueProjection)}`);
          console.log(`  Risk: ${v.riskLevel}`);
          console.log('');
        });
      }

      if (result.setupTemplates) {
        console.log('HUMAN SETUP NEEDED:');
        result.setupTemplates.forEach(t => {
          console.log(`\n${t.ventureName} (~${t.totalHumanTimeMinutes} min):`);
          t.steps.forEach(s => console.log(`  ${s.stepNumber}. ${s.action}`));
        });
      }

      // Resume work loop
      console.log('\n5. Resuming work loop...');
      await fetch(API + '/api/system/resume-work-loop', { method: 'POST', headers: h });
      console.log('   Done!');
      return;
    }
    
    console.log(`   Check ${i+1}/20 — still running...`);
  }

  console.log('Timed out. Check Railway logs.');
  // Resume work loop anyway
  await fetch(API + '/api/system/resume-work-loop', { method: 'POST', headers: h });
}

run().catch(console.error);
