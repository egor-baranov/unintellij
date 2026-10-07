import type { Comparison, Side } from '../diff/model';
import { boundaryTop, type CodeEditor } from './geometry';

/** Spacer zones use measured wrapped/hidden geometry, never line counts. */
export class Alignment {
  private zones: Record<Side,string[]> = {original:[],modified:[]};
  constructor(private editors: Record<Side,CodeEditor>) {}
  clear(): void {
    for (const side of ['original','modified'] as const) {
      this.editors[side].changeViewZones(a=>this.zones[side].forEach(id=>a.removeZone(id)));
      this.zones[side]=[];
    }
  }
  apply(comparison?: Comparison): void {
    this.clear();
    if (!comparison) return;
    // Compute all base geometry before inserting zones to avoid read/write loops.
    const stops = comparison.changes.flatMap(c=>[{original:c.original.start,modified:c.modified.start},{original:c.original.end,modified:c.modified.end}]);
    const geometry = stops.map(stop=>({stop,original:boundaryTop(this.editors.original,stop.original),modified:boundaryTop(this.editors.modified,stop.modified)}));
    const offset: Record<Side,number> = {original:0,modified:0};
    const pending: Record<Side,{afterLineNumber:number;height:number}[]>={original:[],modified:[]};
    for (const g of geometry) {
      const difference = g.original+offset.original-g.modified-offset.modified;
      if (Math.abs(difference)<1) continue;
      const side: Side = difference<0?'original':'modified';
      const height=Math.abs(difference);
      pending[side].push({afterLineNumber:g.stop[side]-1,height});
      offset[side]+=height;
    }
    for (const side of ['original','modified'] as const) this.editors[side].changeViewZones(a=> {
      for (const item of pending[side]) {
        const node=document.createElement('div');node.className='smart-diff-spacer';
        this.zones[side].push(a.addZone({afterLineNumber:item.afterLineNumber,heightInPx:item.height,domNode:node,showInHiddenAreas:true}));
      }
    });
  }
  dispose(): void { this.clear(); }
}
