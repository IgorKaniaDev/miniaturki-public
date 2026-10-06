// Deterministic end-to-end test: real local API and renderer, synthetic source images.
// Setup: npm install --prefix .cache/browser playwright
const {chromium} = require('../.cache/browser/node_modules/playwright');
const {spawn} = require('node:child_process');
const {once} = require('node:events');
const assert = require('node:assert/strict');
const path = require('node:path');
const serverCode = `
import app
from io import BytesIO
from pathlib import Path
from tempfile import TemporaryDirectory
from PIL import Image, ImageDraw
images = {}
for name, color in [('red', '#be2544'), ('blue', '#2544be')]:
    im = Image.new('RGB', (240, 360), 'white')
    ImageDraw.Draw(im).rectangle((50, 30, 190, 330), fill=color)
    buf = BytesIO(); im.save(buf, 'PNG'); images['https://example.test/' + name] = buf.getvalue()
app.fetch_image = lambda url: images[url]
with TemporaryDirectory(prefix='browser-', dir=app.ROOT / '.cache') as directory:
    app.OUTPUT = Path(directory)
    server = app.ThreadingHTTPServer(('127.0.0.1', 0), app.Handler)
    print(server.server_address[1], flush=True)
    server.serve_forever()
`;
const xml = `<offer><products>${['101','102'].map(id=>`<product id="${id}"><description><name>Produkt ${id}</name></description><images><originals><image url="https://example.test/red"/><image url="https://example.test/blue"/></originals></images></product>`).join('')}</products></offer>`;
(async()=>{
 const server=spawn('python',['-u','-c',serverCode],{cwd:path.join(__dirname,'..')});
 let browser;
 try {
  const port=await new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>reject(Error('Server start timeout')),15000);
   server.stdout.once('data',data=>{clearTimeout(timer);resolve(Number(data.toString().trim()));});
   server.once('error',reject);
   server.once('exit',code=>{clearTimeout(timer);reject(Error(`Server exited ${code}`));});
  });
  server.stderr.on('data',()=>{});
  browser=await chromium.launch({executablePath:process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:1100}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const requests=[];page.on('request',r=>{if(r.url().endsWith('/api/preview'))requests.push(r.postDataJSON());});
  await page.goto(`http://127.0.0.1:${port}`);
  await page.locator('#file').setInputFiles({name:'test.xml',mimeType:'text/xml',buffer:Buffer.from(xml)});
  await page.locator('.card').first().waitFor();
  assert.equal(await page.locator('#count').textContent(),'2');
  const ready=()=>page.locator('#preview:not([hidden])').waitFor({timeout:30000});
  const pick=async id=>{await page.locator(`.card[data-id="${id}"]`).click();await page.locator('.photo').nth(0).click();await page.locator('.photo').nth(1).click();await ready();};
  await pick('101');
  const leftFrame=await page.locator('.frame-trigger.left').boundingBox();
  const rightFrame=await page.locator('.frame-trigger.right').boundingBox();
  assert(Math.abs(leftFrame.x+leftFrame.width-rightFrame.x)<1,'preview frames should touch at center');
  await page.locator('.frame-trigger.left').click();
  await page.locator('#cropImage').waitFor({state:'visible'});
  await page.waitForFunction(()=>document.querySelector('#cropImage').naturalWidth>0);
  await page.locator('#cropZoom').evaluate(input=>{input.value='2';input.dispatchEvent(new Event('input',{bubbles:true}));});
  const frameBox=await page.locator('#cropFrame').boundingBox();
  await page.mouse.move(frameBox.x+frameBox.width/2,frameBox.y+frameBox.height/2);
  await page.mouse.down();await page.mouse.move(frameBox.x+frameBox.width/2-70,frameBox.y+frameBox.height/2-70,{steps:8});await page.mouse.up();
  const covered=await page.evaluate(()=>{const frame=document.querySelector('#cropFrame').getBoundingClientRect(),image=document.querySelector('#cropImage').getBoundingClientRect();return image.left<=frame.left+.5 && image.top<=frame.top+.5 && image.right>=frame.right-.5 && image.bottom>=frame.bottom-.5;});
  assert(covered,'drag exposed empty frame area');
  await page.locator('#cropDone').click();await ready();
  const position=requests.at(-1).items[0].frames[0];
  assert(position.x>.5 && position.y>.5 && position.x<=1 && position.y<=1,`drag position: ${JSON.stringify(position)}`);
  assert(position.zoom>1);
  await page.locator('.frame-trigger.left').click();
  await page.waitForFunction(()=>document.querySelector('#cropImage').naturalWidth>0);
  assert.equal(Number(await page.locator('#cropZoom').inputValue()),position.zoom);
  await page.locator('#editorName').click();await ready();
  assert.deepEqual(requests.at(-1).items[0].frames[0],position);
  assert.equal(requests.at(-1).items[0].removeBg,true);
  await page.locator('#removeBg').uncheck();await ready();
  assert.equal(requests.at(-1).items[0].removeBg,false);
  await page.locator('#swapPhotos').click();await ready();
  assert.deepEqual(requests.at(-1).items[0].images,[1,0]);
  await pick('102');
  assert.equal(await page.locator('#removeBg').isChecked(),true);
  await page.locator('#modeChoice input[value="single"]').check();await ready();
  assert.equal(await page.locator('.frame-trigger.right').isHidden(),true);
  assert.deepEqual(requests.at(-1).items[0].images,[0]);
  assert.equal(requests.at(-1).items[0].mode,'single');
  const singleBox=await page.locator('.frame-trigger.left').boundingBox();
  assert(singleBox.width>leftFrame.width*1.9);
  await page.locator('.frame-trigger.left').click();
  await page.waitForFunction(()=>document.querySelector('#cropImage').naturalWidth>0);
  assert.equal(Number(await page.locator('#cropZoom').inputValue()),1);
  await page.mouse.move(singleBox.x+singleBox.width/2,singleBox.y+singleBox.height/2);
  await page.mouse.down();await page.mouse.move(singleBox.x+singleBox.width/2+45,singleBox.y+singleBox.height/2,{steps:6});await page.mouse.up();
  await page.locator('#cropDone').click();await ready();
  const singlePosition=requests.at(-1).items[0].frames[0];
  assert(singlePosition.x>.5 && singlePosition.zoom===1,`single image position: ${JSON.stringify(singlePosition)}`);
  await page.locator('#modeChoice input[value="double"]').check();await ready();
  assert.deepEqual(requests.at(-1).items[0].images,[0,1]);
  await page.locator('#modeChoice input[value="single"]').check();await ready();
  assert.deepEqual(requests.at(-1).items[0].frames[0],singlePosition);
  await page.locator('.card[data-id="101"]').click();await ready();
  assert.equal(await page.locator('#removeBg').isChecked(),false);
  assert.deepEqual(requests.at(-1).items[0].images,[1,0]);
  // Delay a response, change products, then release it after the current preview.
  let releaseOld, oldArrived;
  const oldSeen=new Promise(resolve=>oldArrived=resolve);
  const oldGate=new Promise(resolve=>releaseOld=resolve);
  let first=true;
  await page.route('**/api/preview',async route=>{
   if(first){first=false;const response=await route.fetch();oldArrived();await oldGate;await route.fulfill({response}).catch(()=>{});}
   else await route.continue();
  });
  await page.locator('#makePreview').click();await oldSeen;
  await page.locator('.card[data-id="102"]').click();await ready();
  const currentSrc=await page.locator('#preview').getAttribute('src');
  releaseOld();await page.waitForTimeout(500);
  assert.equal(await page.locator('#preview').getAttribute('src'),currentSrc);
  assert.equal(await page.locator('#editorId').textContent(),'#102');
  await page.unroute('**/api/preview');
  // Error state can be retried without reselecting images.
  await page.route('**/api/preview',route=>route.fulfill({status:400,contentType:'application/json',body:JSON.stringify({error:'Testowy błąd zdjęcia'})}));
  await page.locator('#makePreview').click();
  await page.waitForFunction(()=>document.querySelector('#previewHint').textContent.includes('Nie udało'));
  assert.equal(await page.locator('#makePreview').isEnabled(),true);
  await page.unroute('**/api/preview');
  await page.locator('#makePreview').click();await ready();
  await page.screenshot({path:path.join(__dirname,'../.cache/v02-desktop.png'),fullPage:true});
  const generation=page.waitForRequest('**/api/generate');
  await page.locator('#generate').click();
  assert.deepEqual((await generation).postDataJSON().items,[{id:'101',mode:'double',images:[1,0],removeBg:false,frames:[{x:.5,y:.5,zoom:1},position]},{id:'102',mode:'single',images:[0],removeBg:true,frames:[singlePosition]}]);
  await page.locator('#download:not([hidden])').waitFor({timeout:30000});
  const response=await page.request.get(new URL(await page.locator('#download').getAttribute('href'),page.url()).href);
  assert.equal(response.ok(),true);assert.equal((await response.body()).subarray(0,2).toString(),'PK');
  await page.setViewportSize({width:390,height:844});
  await page.locator('.card[data-id="101"]').click();await ready();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.screenshot({path:path.join(__dirname,'../.cache/v02-mobile.png'),fullPage:true});
  await page.locator('#search').fill('NO_MATCH_123');
  assert.equal(await page.locator('.card').count(),0);
  const singleXml='<offer><products><product id="103"><description><name>Jeden obraz</name></description><images><originals><image url="https://example.test/red"/></originals></images></product></products></offer>';
  await page.locator('#file').setInputFiles({name:'single.xml',mimeType:'text/xml',buffer:Buffer.from(singleXml)});
  await page.locator('.card[data-id="103"]').click();
  assert.equal(await page.locator('#modeChoice input[value="single"]').isChecked(),true);
  await page.locator('.photo').first().click();await ready();
  const oneGeneration=page.waitForRequest('**/api/generate');
  await page.locator('#generate').click();
  assert.deepEqual((await oneGeneration).postDataJSON().items[0].images,[0]);
  await page.locator('#download:not([hidden])').waitFor({timeout:30000});
  assert.deepEqual(errors,[]);
  console.log('PASS: XML import, one/two-photo modes, centering and reposition, restored settings, stale-response protection, retry, mixed batch, ZIP, mobile layout, filtering, no JS errors.');
 }finally{if(browser)await browser.close();server.kill();await once(server,'exit').catch(()=>{});}
})().catch(e=>{console.error(e);process.exitCode=1;});
