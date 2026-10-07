import { expect, test, type Locator, type Page } from '@playwright/test';
import { pngBefore } from '../apps/playground/src/media-fixtures';

const surface = (page: Page) => page.getByTestId('media-surface');
const group = (page: Page, side: 'primary' | 'secondary' = 'primary') => page.locator(`section[data-group="${side}"]`);
async function imageReady(image: Locator, width: number, height: number) {
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate(node => {
    const image = node as HTMLImageElement;
    return image.complete ? [image.naturalWidth, image.naturalHeight] : null;
  })).toEqual([width, height]);
}
async function chooseCommit(page: Page, id: string, path: string) {
  await page.evaluate(id => window.commitPreview.selectFile(id), id);
  await expect(surface(page)).toHaveAttribute('data-path', path);
}
async function groupAction(page: Page, action: string, index = 1) {
  await page.getByRole('button', { name: `Editor group ${index} options`, exact: true }).click();
  await page.getByRole('menuitem', { name: action, exact: true }).click();
}

test('project image previews decode real pixels and expose fit, actual size, zoom and transparency controls', async ({ page }) => {
  await page.goto('/?view=project&path=artifacts/sample.png');
  await expect(surface(page)).toHaveAttribute('data-comparison', 'false');
  await imageReady(surface(page).getByRole('img'), 480, 280);
  await expect(surface(page).getByTestId('media-metadata')).toContainText('480 × 280');
  await expect(page.locator('.monaco-editor')).toHaveCount(0);
  await expect(surface(page).getByTestId('image-zoom')).toHaveText('Fit');
  await surface(page).getByRole('button', { name: 'Actual image size', exact: true }).click();
  await expect(surface(page).getByTestId('image-zoom')).toHaveText('100%');
  await surface(page).getByRole('button', { name: 'Zoom in', exact: true }).click();
  await expect.poll(async () => Number((await surface(page).getByTestId('image-zoom').innerText()).replace('%', ''))).toBeGreaterThan(100);
  await surface(page).getByRole('button', { name: 'Zoom out', exact: true }).click();
  await expect(surface(page).getByTestId('image-zoom')).toHaveText('100%');
  const checkerboard = surface(page).getByRole('button', { name: 'Show checkerboard', exact: true });
  const initial = await checkerboard.getAttribute('aria-pressed');
  await checkerboard.click();
  await expect(checkerboard).toHaveAttribute('aria-pressed', String(initial !== 'true'));
  await surface(page).getByRole('button', { name: 'Fit image', exact: true }).click();
  await expect(surface(page).getByTestId('image-zoom')).toHaveText('Fit');
  await page.setViewportSize({ width: 760, height: 560 });
  await imageReady(surface(page).getByRole('img'), 480, 280);
  await expect.poll(() => surface(page).getByRole('img').evaluate(node => {
    const bounds = node.getBoundingClientRect();
    return bounds.right <= innerWidth + 1 && bounds.bottom <= innerHeight + 1;
  })).toBe(true);
  await page.screenshot({ path: 'test-results/media-project-image.png' });
});

test('modified images preserve both sides while deleted and added images use one pane', async ({ page }) => {
  await page.goto('/?view=commit&file=image-modified');
  await expect(surface(page)).toHaveAttribute('data-comparison', 'true');
  const original = surface(page).locator('[data-media-side="original"]');
  const modified = surface(page).locator('[data-media-side="modified"]');
  await imageReady(original.getByRole('img'), 480, 280);
  await imageReady(modified.getByRole('img'), 480, 280);
  await expect(original).toContainText('HEAD');
  await expect(modified).toContainText('Working tree');
  const sources = await surface(page).getByRole('img').evaluateAll(nodes => nodes.map(node => (node as HTMLImageElement).src));
  expect(sources[0]).not.toBe(sources[1]);
  const colors = await surface(page).getByRole('img').evaluateAll(nodes => nodes.map(node => {
    const canvas = document.createElement('canvas'); canvas.width = 480; canvas.height = 280;
    const context = canvas.getContext('2d')!; context.drawImage(node as HTMLImageElement, 0, 0);
    return [...context.getImageData(100, 160, 1, 1).data];
  }));
  expect(colors).toEqual([[185, 136, 79, 255], [87, 171, 132, 255]]);
  await expect(page.locator('.smart-diff')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Next change', exact: true })).toHaveCount(0);
  await page.screenshot({ path: 'test-results/media-paired-images.png' });
  await chooseCommit(page, 'image-deleted', 'assets/removed.png');
  await expect(surface(page)).toHaveAttribute('data-comparison', 'false');
  await imageReady(original.getByRole('img'), 480, 280);
  await expect(modified).toHaveCount(0);
  await expect(surface(page).getByText('File does not exist', { exact: true })).toHaveCount(0);
  await expect(surface(page).getByRole('img')).toHaveCount(1);
  await chooseCommit(page, 'image-added', 'artifacts/sample.png');
  await expect(surface(page)).toHaveAttribute('data-comparison', 'false');
  await expect(surface(page).getByRole('img')).toHaveCount(1);
  await imageReady(surface(page).getByRole('img'), 480, 280);
});

test('passive SVG and animated GIF open as image media and corrupted bytes fail visibly', async ({ page }) => {
  await page.goto('/?view=project&path=assets/mark.svg');
  await imageReady(surface(page).getByRole('img'), 320, 180);
  await expect(surface(page).locator('iframe,object,embed')).toHaveCount(0);
  await expect(surface(page).getByRole('img')).toHaveAttribute('src', /^blob:/);
  await page.evaluate(() => window.projectPreview.selectFile('assets/pulse.gif'));
  await expect(surface(page)).toHaveAttribute('data-path', 'assets/pulse.gif');
  await imageReady(surface(page).getByRole('img'), 32, 32);
  await page.evaluate(() => window.projectPreview.selectFile('artifacts/corrupt.png'));
  await expect(surface(page)).toHaveAttribute('data-path', 'artifacts/corrupt.png');
  await expect(surface(page).getByRole('alert')).toBeVisible();
  await expect(surface(page).getByRole('alert')).toContainText(/cannot|could not|unable|decode|unsupported/i);
  await page.evaluate(() => window.projectPreview.selectFile('artifacts/sample.bin'));
  await expect(page.getByRole('heading', { name: 'Binary file', exact: true })).toBeVisible();
  await expect(surface(page)).toHaveCount(0);
  await page.evaluate(() => window.projectPreview.selectFile('README.md'));
  await expect(page.getByTestId('file-surface')).toHaveAttribute('data-path', 'README.md');
});

test('native audio and video players load local metadata without autoplay', async ({ page }) => {
  await page.goto('/?view=project&path=artifacts/tone.wav');
  const audio = surface(page).locator('audio');
  await expect(audio).toBeVisible();
  await expect(audio).toHaveAttribute('controls', '');
  await expect(audio).toHaveAttribute('preload', 'metadata');
  await expect.poll(() => audio.evaluate(node => (node as HTMLAudioElement).readyState)).toBeGreaterThanOrEqual(1);
  const audioState = await audio.evaluate(node => {
    const audio = node as HTMLAudioElement;
    return { duration: audio.duration, paused: audio.paused, autoplay: audio.autoplay, source: audio.currentSrc };
  });
  expect(audioState.duration).toBeCloseTo(0.5, 2);
  expect(audioState.paused).toBe(true); expect(audioState.autoplay).toBe(false); expect(audioState.source).toMatch(/^blob:/);
  await page.evaluate(() => window.projectPreview.selectFile('artifacts/demo.webm'));
  const video = surface(page).locator('video');
  await expect(video).toBeVisible();
  await expect(video).toHaveAttribute('controls', '');
  await expect.poll(() => video.evaluate(node => (node as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(1);
  const videoState = await video.evaluate(node => {
    const video = node as HTMLVideoElement;
    return { width: video.videoWidth, height: video.videoHeight, duration: video.duration, paused: video.paused, autoplay: video.autoplay, source: video.currentSrc };
  });
  expect(videoState.width).toBe(96); expect(videoState.height).toBe(64);
  expect(videoState.duration).toBeGreaterThan(0); expect(Number.isFinite(videoState.duration)).toBe(true);
  expect(videoState.paused).toBe(true); expect(videoState.autoplay).toBe(false); expect(videoState.source).toMatch(/^blob:/);
  await expect(page.locator('.monaco-editor')).toHaveCount(0);
});

test('switching, splitting and closing media tabs releases each owned object URL', async ({ page }) => {
  await page.addInitScript(() => {
    const state = { created: [] as string[], revoked: [] as string[], active: new Set<string>() };
    Object.assign(window, { mediaUrlAudit: state });
    const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = blob => {
      const url = create(blob);
      if (blob instanceof Blob && /^(image|audio|video)\//.test(blob.type)) { state.created.push(url); state.active.add(url); }
      return url;
    };
    URL.revokeObjectURL = url => { if (state.active.delete(url)) state.revoked.push(url); revoke(url); };
  });
  const activeCount = () => page.evaluate(() => (window as typeof window & { mediaUrlAudit: { active: Set<string> } }).mediaUrlAudit.active.size);
  await page.goto('/?view=project&path=artifacts/sample.png');
  await imageReady(surface(page).getByRole('img'), 480, 280);
  await expect.poll(activeCount).toBe(1);
  await groupAction(page, 'Split right');
  await expect(surface(page)).toHaveCount(2);
  await imageReady(group(page, 'secondary').getByTestId('media-surface').getByRole('img'), 480, 280);
  await expect.poll(activeCount).toBe(2);
  await group(page).getByRole('tab', { name: 'artifacts/sample.png', exact: true }).click();
  await page.evaluate(() => window.projectPreview.selectFile('README.md'));
  await expect(group(page).getByTestId('file-surface')).toHaveAttribute('data-path', 'README.md');
  await expect.poll(activeCount).toBe(1);
  await group(page).getByRole('tab', { name: 'artifacts/sample.png', exact: true }).click();
  await imageReady(group(page).getByTestId('media-surface').getByRole('img'), 480, 280);
  await expect.poll(activeCount).toBe(2);
  await group(page, 'secondary').getByRole('button', { name: 'Close artifacts/sample.png', exact: true }).click();
  await expect(group(page, 'secondary')).toHaveCount(0);
  await expect.poll(activeCount).toBe(1);
  await group(page).getByRole('button', { name: 'Close artifacts/sample.png', exact: true }).click();
  await expect(group(page).getByTestId('file-surface')).toHaveAttribute('data-path', 'README.md');
  await expect.poll(activeCount).toBe(0);
  const audit = await page.evaluate(() => {
    const audit = (window as typeof window & { mediaUrlAudit: { created: string[]; revoked: string[] } }).mediaUrlAudit;
    return { created: audit.created.length, revoked: audit.revoked.length };
  });
  expect(audit.created).toBeGreaterThanOrEqual(3); expect(audit.revoked).toBe(audit.created);
});

test('image zoom and pan survive tab switches and replacing bytes in the same mounted tab', async ({ page }) => {
  await page.goto('/?view=project&path=artifacts/sample.png');
  await imageReady(surface(page).getByRole('img'), 480, 280);
  await surface(page).getByRole('button', { name: 'Actual image size', exact: true }).click();
  for (let i = 0; i < 4; i++) await surface(page).getByRole('button', { name: 'Zoom in', exact: true }).click();
  await expect(surface(page).getByTestId('image-zoom')).toHaveText('400%');
  const position = await page.evaluate(() => {
    const viewport = document.querySelector<HTMLDivElement>('.media-viewport')!;
    viewport.scrollLeft = 211; viewport.scrollTop = 137;
    const position = { left: viewport.scrollLeft, top: viewport.scrollTop };
    // Switch within the same task, before the browser delivers queued scroll events.
    window.projectPreview.selectFile('README.md');
    return position;
  });
  expect(position.left).toBeGreaterThan(100); expect(position.top).toBeGreaterThan(100);
  await expect(page.getByTestId('file-surface')).toHaveAttribute('data-path', 'README.md');
  await group(page).getByRole('tab', { name: 'artifacts/sample.png', exact: true }).click();
  await imageReady(surface(page).getByRole('img'), 480, 280);
  await expect(surface(page).getByTestId('image-zoom')).toHaveText('400%');
  const panPosition = () => surface(page).locator('.media-viewport').evaluate(node => ({ left: node.scrollLeft, top: node.scrollTop }));
  await expect.poll(panPosition).toEqual(position);
  const previousSource = await surface(page).getByRole('img').getAttribute('src');
  await surface(page).evaluate(node => { node.setAttribute('data-mount-marker', 'same-instance'); });
  await page.evaluate(replacement => {
    const file = window.projectPreview.getState();
    if (!file?.media) throw new Error('Expected media fixture');
    file.media = { ...file.media, ...replacement };
    // Opening the active document updates its props while retaining its tab ID.
    window.projectPreview.selectFile('artifacts/sample.png');
  }, pngBefore);
  await expect(surface(page).getByRole('img')).not.toHaveAttribute('src', previousSource!);
  await imageReady(surface(page).getByRole('img'), 480, 280);
  await expect(surface(page)).toHaveAttribute('data-mount-marker', 'same-instance');
  await expect(surface(page).getByTestId('image-zoom')).toHaveText('400%');
  await expect.poll(panPosition).toEqual(position);
  await expect(surface(page).getByRole('alert')).toHaveCount(0);
});
