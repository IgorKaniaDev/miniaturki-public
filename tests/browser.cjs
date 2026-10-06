// Optional browser smoke test: npm install --prefix .cache/browser playwright
const {chromium} = require('../.cache/browser/node_modules/playwright');
const path = require('path');
(async()=>{
 const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 try {
  const page=await browser.newPage({viewport:{width:1440,height:1100}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:8765');
  await page.locator('#sample').click();
  await page.locator('.card').first().waitFor();
  if(await page.locator('#count').textContent()!=='44')throw Error('Import count');
  await page.locator('.card').first().click();
  await page.locator('.photo').nth(0).click();
  await page.locator('.photo').nth(1).click();
  await page.locator('#makePreview').click();
  await page.locator('#preview:not([hidden])').waitFor({timeout:60000});
  await page.screenshot({path:path.join(__dirname,'../.cache/studio-desktop.png'),fullPage:true});
  await page.locator('#generate').click();
  await page.locator('#download:not([hidden])').waitFor({timeout:60000});
  const response=await page.request.get(new URL(await page.locator('#download').getAttribute('href'),page.url()).href);
  if(!response.ok()||(await response.body()).subarray(0,2).toString()!=='PK')throw Error('ZIP download failed');
  await page.locator('#search').fill('NO_MATCH_123');
  if(await page.locator('.card').count())throw Error('Search filtering');
  await page.setViewportSize({width:390,height:844});
  if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw Error('Mobile overflow');
  if(errors.length)throw Error(errors.join('\n'));
  console.log('PASS: import, image selection, preview, batch generation, ZIP, search, mobile width, no JS errors.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exit(1);});
