import type { editor, IRange } from 'monaco-editor';
import type { LineRange } from '../diff/model';

/** Monaco 0.55.1 CodeEditorWidget.setHiddenAreas is intentionally private.
 * Verified in esm/vs/editor/browser/widget/codeEditor/codeEditorWidget.js.
 * No generated DOM or internal view model is accessed. Runtime checks keep
 * ordinary viewing usable if consumers supply an incompatible Monaco runtime.
 */
interface HiddenAreaEditor { setHiddenAreas(ranges: IRange[], source?: unknown, forceUpdate?: boolean): void }
function supportsHiddenAreas(value: object): value is object & HiddenAreaEditor {
  return 'setHiddenAreas' in value && typeof value.setHiddenAreas === 'function';
}
export class HiddenAreasAdapter {
  private readonly source = {};
  available: boolean;
  constructor(private readonly editor: editor.IStandaloneCodeEditor) {
    this.available = supportsHiddenAreas(editor);
  }
  set(ranges: LineRange[]): boolean {
    if (!this.available || !supportsHiddenAreas(this.editor)) return false;
    try {
      this.editor.setHiddenAreas(ranges.map(r => ({startLineNumber:r.start,startColumn:1,endLineNumber:r.end-1,endColumn:1})), this.source, true);
      const candidate = ranges.find(r => r.start > 1 && r.end > r.start);
      if (candidate && this.editor.getLineHeightForPosition({lineNumber:candidate.start,column:1}) !== 0) {
        throw new Error('Hidden range was not applied');
      }
      return true;
    } catch {
      this.available = false;
      try { this.editor.setHiddenAreas([], this.source, true); } catch { /* Capability unavailable. */ }
      return false;
    }
  }
  clear(): void {
    if (supportsHiddenAreas(this.editor)) {
      try { this.editor.setHiddenAreas([], this.source, true); } catch { this.available = false; }
    }
  }
}
