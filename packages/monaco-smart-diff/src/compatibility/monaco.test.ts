import type { editor, IRange } from 'monaco-editor';
import { describe, expect, it, vi } from 'vitest';
import { HiddenAreasAdapter } from './monaco';

describe('Monaco hidden-area compatibility boundary',()=> {
  it('converts half-open ranges and uses a viewer-specific source owner',()=> {
    let active:IRange[]=[];
    const setHiddenAreas=vi.fn((ranges:IRange[])=>{active=ranges;});
    const instance={
      setHiddenAreas,
      getLineHeightForPosition:({lineNumber}:{lineNumber:number})=>active.some(r=>lineNumber>=r.startLineNumber&&lineNumber<=r.endLineNumber)?0:21,
    } as unknown as editor.IStandaloneCodeEditor;
    const first=new HiddenAreasAdapter(instance),second=new HiddenAreasAdapter(instance);
    expect(first.set([{start:4,end:20}])).toBe(true);
    expect(setHiddenAreas.mock.calls[0][0]).toEqual([{startLineNumber:4,startColumn:1,endLineNumber:19,endColumn:1}]);
    second.set([{start:25,end:30}]);
    const calls=vi.mocked(setHiddenAreas).mock.calls as unknown as [IRange[],object,boolean][];
    expect(calls[0][1]).not.toBe(calls[1][1]);
    first.clear();
    expect(calls[2][1]).toBe(calls[0][1]);
    expect(calls[2][2]).toBe(true);
  });

  it('disables only folding when the private capability is absent',()=> {
    const adapter=new HiddenAreasAdapter({} as editor.IStandaloneCodeEditor);
    expect(adapter.available).toBe(false);
    expect(adapter.set([{start:3,end:10}])).toBe(false);
    expect(()=>adapter.clear()).not.toThrow();
  });

  it('rejects an incompatible implementation that accepts calls but does not hide lines',()=> {
    const setHiddenAreas=vi.fn();
    const adapter=new HiddenAreasAdapter({setHiddenAreas,getLineHeightForPosition:()=>21} as unknown as editor.IStandaloneCodeEditor);
    expect(adapter.set([{start:3,end:10}])).toBe(false);
    expect(adapter.available).toBe(false);
    expect(setHiddenAreas.mock.lastCall?.[0]).toEqual([]);
  });

  it('recovers gracefully from a private API throwing at runtime',()=> {
    const adapter=new HiddenAreasAdapter({setHiddenAreas:()=>{throw new Error('incompatible runtime');}} as unknown as editor.IStandaloneCodeEditor);
    expect(adapter.set([{start:3,end:10}])).toBe(false);
    expect(adapter.available).toBe(false);
    expect(()=>adapter.clear()).not.toThrow();
  });
});
