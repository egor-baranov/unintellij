import type { ElectronApplication, Page } from '@playwright/test';
import type { BrowserWindow } from 'electron';

/** Follow the chooser's new project window; existing projects stay open, while welcome closes. */
export async function openRepositoryWindow(application: ElectronApplication, choose: () => Promise<unknown>): Promise<Page> {
  const [page] = await Promise.all([application.waitForEvent('window'), choose()]);
  await hideWindow(application, page);
  await page.waitForLoadState('domcontentloaded');
  return page;
}

export async function hideWindow(application: ElectronApplication, page: Page): Promise<void> {
  const handle = await application.browserWindow(page);
  try {
    await handle.evaluate((window: BrowserWindow) => {
      window.webContents.setBackgroundThrottling(false);
      window.hide();
    });
  } finally { await handle.dispose(); }
}

/** Native capture keeps hidden macOS windows rendering without foregrounding them. */
export async function captureWindow(application: ElectronApplication, page: Page): Promise<Buffer> {
  const handle = await application.browserWindow(page);
  try {
    const png = await handle.evaluate(async (window: BrowserWindow) => {
      const image = await window.webContents.capturePage(undefined, { stayHidden: true });
      if (image.isEmpty()) throw new Error('Empty Electron screenshot');
      return image.toPNG().toString('base64');
    });
    return Buffer.from(png, 'base64');
  } finally { await handle.dispose(); }
}
