import {test,expect, type Page} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
const root='/projects/idea-e2e/idea';
async function chapter(page:Page,role='owner') {
 const seed=await (await page.request.get('/__idea-test/session')).json();
 await page.goto(`${root}/${seed.reviews[0]}?role=${role}`);
 await expect(page.getByRole('heading',{name:/Chapter review · version/})).toBeVisible();
 return seed;
}
async function generate(page:Page,mode?:string){
 if(mode) await page.getByRole('combobox',{name:'Crosswalk task',exact:true}).selectOption(mode);
 await page.getByRole('button',{name:'Save and estimate AI draft',exact:true}).click();
 await page.getByRole('checkbox',{name:/I agree to send/}).check();
 await page.getByRole('button',{name:'Request draft',exact:true}).click();
 await expect(page.getByRole('status').filter({hasText:/Run succeeded/})).toBeVisible({timeout:15000});
 await expect(page.getByText('scripted-browser-fixture',{exact:false})).toBeVisible();
}
test.beforeEach(async({page})=>{
 await page.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
});
test('chapter save, all task presentations, follow-up and independent ratings',async({page})=>{
 test.setTimeout(120000);
 await chapter(page);
 await expect(page.getByText('Model: gpt-5.6-luna, high reasoning.',{exact:true})).toBeVisible();
 await expect(page.getByText(/Ollama|GLM reliability/)).toHaveCount(0);
 await page.getByRole('textbox',{name:'Faculty summary',exact:true}).fill('Faculty text survives every machine draft.');
 await expect(page.getByRole('status').filter({hasText:/Saved version 2/})).toBeVisible();
 for(const mode of ['7.1','7.2','7.3','7.4','7.5','7.6','7.7','7.7.1','7.8','rubric','followup']){
  await generate(page,mode);
  await expect(page.getByRole('textbox',{name:'Faculty summary',exact:true})).toHaveValue('Faculty text survives every machine draft.');
  for(const rating of await page.getByLabel(/^Faculty rating for/).all()) await expect(rating).toHaveValue('not_rated');
 }
 await page.reload();
 await expect(page.getByRole('textbox',{name:'Faculty summary',exact:true})).toHaveValue('Faculty text survives every machine draft.');
});
test('ten faculty judgments, finish/reopen and saved export',async({page})=>{
 await chapter(page);
 await page.getByRole('textbox',{name:'Faculty summary',exact:true}).fill('Faculty text survives every machine draft.');
 await expect(page.getByRole('button',{name:'Finish faculty assessment'})).toBeDisabled();
 for(const rating of await page.getByLabel(/^Faculty rating for/).all()) await rating.selectOption('inclusive');
 await page.getByRole('button',{name:'Finish faculty assessment'}).click();
 await expect(page.getByRole('button',{name:'Reopen assessment'})).toBeVisible();
 await expect(page.getByRole('textbox',{name:'Faculty summary',exact:true})).toBeDisabled();
 const downloaded=page.waitForEvent('download');
 await page.getByRole('button',{name:'Export saved JSON'}).click();
 const stream=await (await downloaded).createReadStream();let text='';for await(const chunk of stream!)text+=chunk;
 expect(text).toContain('Faculty text survives every machine draft.');
 expect(text).toContain('inclusive');
 await page.getByRole('button',{name:'Reopen assessment'}).click();
 await expect(page.getByRole('textbox',{name:'Faculty summary',exact:true})).toBeEnabled();
});
test('synthesis selection, durable run, feedback and faculty finish',async({page})=>{
 await page.goto('/projects/idea-e2e/idea-syntheses');
 await page.getByRole('button',{name:'Select chapters for synthesis'}).click();
 const available=page.getByRole('group',{name:'Available chapter reviews',exact:true});
 await expect(available.getByRole('checkbox')).toHaveCount(2);
 for(const box of await available.getByRole('checkbox').all())await box.check();
 await page.getByLabel('Discipline',{exact:true}).fill('Environmental science');
 await page.getByRole('checkbox',{name:/I understand the selection/}).check();
 await page.getByRole('button',{name:'Create synthesis with these saved versions'}).click();
 await expect(page.getByText(/2 saved assessments across 2 chapter roots/)).toBeVisible();
 await generate(page);
 await page.getByRole('textbox',{name:'Faculty summary (required to finish)',exact:true}).fill('Compare transport assumptions with clinic scheduling.');
 await page.getByRole('button',{name:'Save feedback and synthesis disposition'}).click();
 await page.getByRole('button',{name:'Finish faculty synthesis'}).click();
 await expect(page.getByRole('button',{name:'Reopen synthesis'})).toBeVisible();
 await page.reload();
 await expect(page.getByRole('textbox',{name:'Faculty summary (required to finish)',exact:true})).toHaveValue('Compare transport assumptions with clinic scheduling.');
});
test('auditor is read-only, evidence focus returns and mobile accessibility',async({page})=>{
 await page.setViewportSize({width:390,height:844});
 await chapter(page,'auditor');
 await expect(page.getByRole('textbox',{name:'Faculty summary',exact:true})).toBeDisabled();
 await expect(page.getByRole('button',{name:'Save and estimate AI draft'})).toBeDisabled();
 const evidence=page.getByRole('button',{name:/Read captured Fictional chapter/}).first();
 await evidence.click();
 await expect(page.getByRole('region',{name:'Captured evidence',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Close evidence'}).click();
 await expect(page.getByRole('region',{name:'Captured evidence',exact:true})).toHaveCount(0);
 await expect(evidence).toBeFocused();
 const results=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
 expect(results.violations).toEqual([]);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
});
test('outsider sees no private faculty content',async({page})=>{
 const seed=await (await page.request.get('/__idea-test/session')).json();
 await page.goto(`${root}/${seed.reviews[0]}?role=outsider`);
 await expect(page.getByRole('alert')).toContainText('IDEA is private');
 await expect(page.getByRole('textbox',{name:'Faculty summary',exact:true})).toHaveCount(0);
});

test('public discovery, bounded capture and new assessment through real worker',async({page})=>{
 await page.goto(root);
 await page.getByRole('button',{name:'Start chapter review',exact:true}).click();
 await page.getByRole('textbox',{name:'Discipline',exact:true}).fill('Environmental science');
 await page.getByRole('checkbox',{name:/I am familiar with this chapter/}).check();
 await page.getByRole('button',{name:'Discover public chapter pages'}).click();
 await page.getByRole('combobox',{name:'Chapter root',exact:true}).selectOption('10');
 await page.getByRole('button',{name:'Capture selected pages'}).click();
 await expect(page.getByRole('status').filter({hasText:/Capture: succeeded/})).toBeVisible({timeout:15000});
 await expect(page.getByRole('button',{name:'Create faculty review',exact:true})).toBeDisabled();
 await page.getByRole('checkbox',{name:'I understand this review covers only successfully captured content.'}).check();
 await page.getByRole('button',{name:'Create faculty review',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Chapter review · version 1'})).toBeVisible();
 await expect(page.getByText(/Excluded pages: 11, 12/)).toBeVisible();
});
