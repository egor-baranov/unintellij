import { expect, test, type Page } from '@playwright/test';

interface LifecycleCounts {
  workersCreated: number;
  workersTerminated: number;
  activeWorkers: number;
  observersCreated: number;
  observersDisconnected: number;
  activeObservers: number;
}
declare global { interface Window { smartDiffLifecycle: LifecycleCounts } }

async function settled(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}
async function ready(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => window.playground?.viewer?.getState().status)).toMatch(/^(ready|empty)$/);
}
async function scrolls(page: Page): Promise<number[]> {
  return page.evaluate(() => { const editors=window.playground.viewer!.getEditors(); return [editors.original.getScrollTop(),editors.modified.getScrollTop()]; });
}

test('mount cycles terminate owned diff workers and disconnect viewer resize observers',async ({page})=> {
  await page.addInitScript(()=> {
    const counts: LifecycleCounts={workersCreated:0,workersTerminated:0,activeWorkers:0,observersCreated:0,observersDisconnected:0,activeObservers:0};
    window.smartDiffLifecycle=counts;
    const BrowserWorker=window.Worker;
    window.Worker=class extends BrowserWorker {
      private tracked: boolean;
      private terminated=false;
      constructor(scriptURL: string|URL,options?: WorkerOptions) {
        super(scriptURL,options);
        this.tracked=options?.name==='smart-diff';
        if(this.tracked){counts.workersCreated++;counts.activeWorkers++;}
      }
      override terminate(): void {
        if(this.tracked&&!this.terminated){this.terminated=true;counts.workersTerminated++;counts.activeWorkers--;}
        super.terminate();
      }
    };
    const BrowserResizeObserver=window.ResizeObserver;
    window.ResizeObserver=class extends BrowserResizeObserver {
      private tracksViewer=false;
      override observe(target:Element,options?:ResizeObserverOptions):void {
        super.observe(target,options);
        if(target.classList.contains('diff-surface')&&!this.tracksViewer){this.tracksViewer=true;counts.observersCreated++;counts.activeObservers++;}
      }
      override disconnect():void {
        if(this.tracksViewer){this.tracksViewer=false;counts.observersDisconnected++;counts.activeObservers--;}
        super.disconnect();
      }
    };
  });
  await page.goto('/?fixture=nearby');await ready(page);
  for(let cycle=0;cycle<4;cycle++) {
    // Identical remounts may be served by the bounded comparison cache without
    // creating a worker. Use fresh source text to exercise disposal each cycle.
    await page.evaluate(cycle => {
      const editors = window.playground.viewer!.getEditors();
      const marker = `\n// lifecycle cycle ${cycle}`;
      window.playground.setContents(editors.original.getValue() + marker, editors.modified.getValue() + marker);
    }, cycle);
    await ready(page);
    await expect.poll(()=>page.evaluate(()=>window.smartDiffLifecycle.activeWorkers)).toBe(1);
    await expect.poll(()=>page.evaluate(()=>window.smartDiffLifecycle.activeObservers)).toBe(1);
    await page.evaluate(()=>window.playground.setMounted(false));
    await expect(page.locator('.smart-diff')).toHaveCount(0);
    await expect.poll(()=>page.evaluate(()=>window.smartDiffLifecycle.activeWorkers)).toBe(0);
    await expect.poll(()=>page.evaluate(()=>window.smartDiffLifecycle.activeObservers)).toBe(0);
    const counts=await page.evaluate(()=>window.smartDiffLifecycle);
    expect(counts.workersTerminated).toBe(counts.workersCreated);
    expect(counts.observersDisconnected).toBe(counts.observersCreated);
    if(cycle<3){await page.evaluate(()=>window.playground.setMounted(true));await ready(page);}
  }
  const final=await page.evaluate(()=>window.smartDiffLifecycle);
  expect(final.workersCreated).toBeGreaterThanOrEqual(4);
  expect(final.observersCreated).toBeGreaterThanOrEqual(4);
});

test('keyboard page scrolling transfers ownership when focus switches panes',async ({page})=> {
  await page.goto('/?fixture=nearby');await ready(page);
  await page.evaluate(()=>window.playground.setPreferences({collapse:false,sync:true}));await settled(page);
  await page.evaluate(()=> {
    const editor=window.playground.viewer!.getEditors().original;
    editor.setPosition({lineNumber:1,column:1});editor.focus();
  });
  await page.keyboard.press('PageDown');
  await page.keyboard.press('PageDown');
  await expect.poll(async()=>(await scrolls(page))[0]).toBeGreaterThan(150);
  await expect.poll(async()=>{const [a,b]=await scrolls(page);return Math.abs(a-b);}).toBeLessThan(35);
  const first=await scrolls(page);
  await page.evaluate(()=> {
    const editor=window.playground.viewer!.getEditors().modified;
    const bottom=editor.getVisibleRanges().at(-1)!.endLineNumber;
    editor.setPosition({lineNumber:Math.max(1,bottom-2),column:1});editor.focus();
  });
  await page.keyboard.press('PageDown');
  await expect.poll(async()=>(await scrolls(page))[0]).toBeGreaterThan(first[0]+150);
  await expect.poll(async()=>{const [a,b]=await scrolls(page);return Math.abs(a-b);}).toBeLessThan(35);
  const end=await scrolls(page);await settled(page);
  const stable=await scrolls(page);
  expect(Math.abs(stable[0]-end[0])).toBeLessThan(2);
  expect(Math.abs(stable[1]-end[1])).toBeLessThan(2);
});

test('horizontal-only wheel input does not trigger a vertical follower correction',async ({page})=> {
  await page.goto('/?fixture=wrapping');await ready(page);
  await page.evaluate(()=>window.playground.setPreferences({collapse:false,sync:true,wrap:false}));await settled(page);
  await page.evaluate(()=>window.playground.viewer!.getEditors().original.setScrollTop(250));await settled(page);
  // An API scroll on the follower intentionally leaves different vertical
  // positions. A horizontal event must not silently reconcile this difference.
  await page.evaluate(()=>window.playground.viewer!.getEditors().modified.setScrollTop(600));await settled(page);
  const before=await scrolls(page);
  expect(before[1]-before[0]).toBeGreaterThan(200);
  // Monaco measures long visible line widths after its render pass.
  await expect.poll(()=>page.evaluate(()=>window.playground.viewer!.getEditors().original.getScrollWidth())).toBeGreaterThan(1000);
  await page.locator('[data-side="original"]').hover();
  for(let tick=0;tick<3;tick++){await page.mouse.wheel(120,0);await settled(page);}
  await expect.poll(()=>page.evaluate(()=>window.playground.viewer!.getEditors().original.getScrollLeft())).toBeGreaterThan(50);
  await settled(page);
  const after=await scrolls(page);
  expect(Math.abs(after[0]-before[0])).toBeLessThan(2);
  expect(Math.abs(after[1]-before[1])).toBeLessThan(2);
});

test('rapid setModels keeps only the latest comparison and never disposes supplied models',async ({page})=> {
  await page.goto('/');await ready(page);
  await page.evaluate(()=> {
    const viewer=window.playground.viewer!, monaco=window.playground.monaco;
    const old=viewer.getEditors();const original=old.original.getModel()!,modified=old.modified.getModel()!;
    for(let i=0;i<8;i++) {
      const a=monaco.editor.createModel(`const original = ${i};\n`,'typescript');
      const b=monaco.editor.createModel(`const modified = ${i};\n`,'typescript');
      viewer.setModels({original:a,modified:b});
      if(i<7){viewer.setModels({original,modified});a.dispose();b.dispose();}
    }
  });
  await ready(page);
  expect(await page.evaluate(()=>window.playground.viewer!.getEditors().modified.getModel()!.getValue())).toContain('modified = 7');
  expect(await page.evaluate(()=>window.playground.viewer!.getComparison()?.changes.length)).toBe(1);
  const modelsSurvive=await page.evaluate(()=> {
    const viewer=window.playground.viewer!,editors=viewer.getEditors();
    const a=editors.original.getModel()!,b=editors.modified.getModel()!;
    viewer.dispose();const survive=!a.isDisposed()&&!b.isDisposed();a.dispose();b.dispose();return survive;
  });
  expect(modelsSurvive).toBe(true);
});
