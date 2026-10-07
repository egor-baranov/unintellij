import { describe, expect, it, vi } from 'vitest';
import { boundaryInViewport, boundaryTop, captureAnchor, hunkSideGeometry, lineToY, restoreAnchor, yToLine, type CodeEditor } from './geometry';

/** Reproduces public Monaco geometry: hidden lines project onto the final
 * wrapped row preceding the hidden range; view zones contribute no model row. */
function geometryEditor(options: { count?: number; hidden?: [number,number]; wrappedLine?: number; zoneAfter?: number; zoneHeight?: number; viewportHeight?: number; scrollTop?: number } = {}) {
  const {count=60,hidden,wrappedLine,zoneAfter,zoneHeight=26,viewportHeight=145,scrollTop=0}=options;
  const top: number[] = [],bottom:number[]=[];
  let cursor=8,previous=1;
  const isHidden = (line:number) => hidden ? line >= hidden[0] && line <= hidden[1] : false;
  for(let line=1;line<=count;line++) {
    if(isHidden(line)) {top[line]=bottom[previous]-21;bottom[line]=bottom[previous];continue;}
    top[line]=cursor;
    bottom[line]=cursor+(line===wrappedLine?63:21);
    cursor=bottom[line]+(line===zoneAfter?zoneHeight:0);
    previous=line;
  }
  const setScrollPosition=vi.fn();
  const instance = {
    getModel:()=>({getLineCount:()=>count}),
    getTopForLineNumber:(line:number)=>top[line],
    getBottomForLineNumber:(line:number)=>bottom[line],
    getLineHeightForPosition:({lineNumber}:{lineNumber:number})=>isHidden(lineNumber)?0:21,
    getLayoutInfo:()=>({height:viewportHeight}),
    getScrollTop:()=>scrollTop,
    getScrollLeft:()=>12,
    setScrollPosition,
  } as unknown as CodeEditor;
  return {instance,setScrollPosition};
}

describe('rendered geometry anchors',()=> {
  it('uses the complete rendered height of a wrapped model line',()=> {
    const {instance}=geometryEditor({wrappedLine:3});
    expect(lineToY(instance,3.5)).toBe(81.5);
    expect(yToLine(instance,81.5)).toBe(3.5);
  });

  it('does not choose a hidden model line when its previous visible row is the anchor',()=> {
    const {instance}=geometryEditor({hidden:[4,50],zoneAfter:3});
    expect(yToLine(instance,58)).toBeCloseTo(3+8/21);
    expect(yToLine(instance,97)).toBe(51);
    expect(lineToY(instance,25.5)).toBe(50);
  });

  it('finds the preceding wrapped line before a plateau of hidden positions',()=> {
    const {instance}=geometryEditor({hidden:[4,50],zoneAfter:3,wrappedLine:3});
    expect(yToLine(instance,100)).toBeCloseTo(3+50/63);
  });

  it('keeps a visible anchor on the same screen pixel when expanding an omission',()=> {
    const folded=geometryEditor({hidden:[4,50],zoneAfter:3,viewportHeight:200});
    const state=captureAnchor(folded.instance);
    expect(state.line).toBeGreaterThan(3);
    expect(state.line).toBeLessThan(4);
    const expanded=geometryEditor();
    restoreAnchor(expanded.instance,state);
    expect(expanded.setScrollPosition.mock.calls[0][0].scrollTop).toBeCloseTo(0);
    expect(state.scrollLeft).toBe(12);
  });

  it('clamps top and bottom boundaries and maps EOF after the final rendered row',()=> {
    const {instance}=geometryEditor({count:3,wrappedLine:3});
    expect(yToLine(instance,-100)).toBe(1);
    expect(yToLine(instance,9999)).toBe(4);
    expect(boundaryTop(instance,4)).toBe(113);
    expect(lineToY(instance,99)).toBe(113);
  });

  it('retains an empty boundary after the complete wrapped row without inflating it',()=> {
    const {instance}=geometryEditor({count:4,wrappedLine:2,scrollTop:20});
    expect(hunkSideGeometry(instance,{start:3,end:3})).toEqual({kind:'boundary',top:72,bottom:72});
    expect(hunkSideGeometry(instance,{start:2,end:3})).toEqual({kind:'block',top:9,bottom:72});
  });

  it('anchors at BOF, the following row after an intervening zone, and actual EOF',()=> {
    const {instance}=geometryEditor({count:3,zoneAfter:1,zoneHeight:80});
    expect(hunkSideGeometry(instance,{start:1,end:1})).toEqual({kind:'boundary',top:8,bottom:8});
    expect(hunkSideGeometry(instance,{start:2,end:2})).toEqual({kind:'boundary',top:109,bottom:109});
    expect(hunkSideGeometry(instance,{start:4,end:4})).toEqual({kind:'boundary',top:151,bottom:151});
    const empty=geometryEditor({count:1});
    expect(hunkSideGeometry(empty.instance,{start:1,end:1})).toEqual({kind:'boundary',top:8,bottom:8});
  });

  it('never classifies hidden or offscreen nonempty ranges as absent',()=> {
    const {instance}=geometryEditor({hidden:[4,50],scrollTop:1000});
    expect(hunkSideGeometry(instance,{start:4,end:6}).kind).toBe('block');
    expect(hunkSideGeometry(instance,{start:2,end:3}).kind).toBe('block');
    expect(hunkSideGeometry(instance,{start:51,end:51}).kind).toBe('boundary');
  });

  it('keeps zero-height markers on both viewport edges and culls only outside the buffer',()=> {
    expect(boundaryInViewport(0,500)).toBe(true);
    expect(boundaryInViewport(500,500)).toBe(true);
    expect(boundaryInViewport(-.01,500)).toBe(false);
    expect(boundaryInViewport(500.01,500)).toBe(false);
    expect(boundaryInViewport(-70,500,70)).toBe(true);
    expect(boundaryInViewport(570,500,70)).toBe(true);
    expect(boundaryInViewport(-71,500,70)).toBe(false);
  });
});
