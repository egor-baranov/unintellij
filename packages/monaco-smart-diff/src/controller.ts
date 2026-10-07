import type * as Monaco from 'monaco-editor/esm/vs/editor/editor.api.js';
import type { Comparison, Side } from './diff/model';
import { DiffWorkerClient } from './diff/client';
import type { SmartDiff, SmartDiffOptions, UpdateOptions, ViewState, ViewerState, UnchangedRegionOptions } from './types';
import { Gutter } from './rendering/gutter';
import { decorations } from './rendering/decorations';
import { captureAnchor, restoreAnchor, type CodeEditor } from './rendering/geometry';
import { ScrollSynchronizer } from './scrolling/synchronizer';
import { FoldingController } from './folding/controller';
import { deriveCollapsedRegions } from './folding/regions';
import { Alignment } from './rendering/alignment';
import { SplitDivider } from './rendering/divider';
import { InlineController } from './inline/controller';

const sides = ['original','modified'] as const;
export function createSmartDiff(container: HTMLElement, options: SmartDiffOptions): SmartDiff {
  return options.viewMode === 'inline' ? new InlineController(container, options) : new Controller(container,options);
}
class Controller implements SmartDiff {
  private root = document.createElement('div');
  private statusNode = document.createElement('div');
  private editors: Record<Side, CodeEditor>;
  private collections: Record<Side,Monaco.editor.IEditorDecorationsCollection>;
  private gutter: Gutter;
  private divider: SplitDivider;
  private scrolling: ScrollSynchronizer;
  private folding: FoldingController;
  private alignment: Alignment;
  private worker: DiffWorkerClient;
  private observer: ResizeObserver;
  private listeners: Monaco.IDisposable[] = [];
  private modelListeners: Monaco.IDisposable[] = [];
  private comparison?: Comparison;
  private requestId=0;
  private disposed=false;
  private structuring=false;
  private frame=0;
  private debounce: ReturnType<typeof setTimeout> | undefined;
  private pendingRestore?: ViewState;
  private pendingBulkExpansion?: boolean;
  private pendingContentChange=false;
  private state: ViewerState = {status:'loading',changeCount:0,currentChange:-1};
  private settings: {modifiedEditable:boolean;layout:'compact'|'aligned';synchronizeScrolling:boolean;ignoreTrimWhitespace:boolean;unchangedRegions:UnchangedRegionOptions;maxComputationTimeMs:number};

  constructor(container: HTMLElement, private options: SmartDiffOptions) {
    this.settings={modifiedEditable:options.modifiedEditable??false,layout:options.layout??'compact',synchronizeScrolling:options.synchronizeScrolling??true,ignoreTrimWhitespace:options.ignoreTrimWhitespace??false,unchangedRegions:{collapse:true,contextLines:3,minimumHiddenLines:6,...options.unchangedRegions},maxComputationTimeMs:options.maxComputationTimeMs??1500};
    this.root.className='smart-diff';this.root.dataset.viewMode='side-by-side';
    const original=document.createElement('div'),modified=document.createElement('div');
    original.className='smart-diff-pane';modified.className='smart-diff-pane';
    original.dataset.side='original';modified.dataset.side='modified';
    this.root.append(original,modified);
    container.append(this.root);
    const editorOptions: Monaco.editor.IStandaloneEditorConstructionOptions = {
      fontSize:16,lineHeight:23,fontWeight:'400',letterSpacing:0,fontFamily:'"JetBrains Mono", Menlo, Consolas, "Liberation Mono", monospace',
      minimap:{enabled:false},stickyScroll:{enabled:false},scrollBeyondLastLine:false,automaticLayout:false,folding:false,
      glyphMargin:false,renderLineHighlight:'none',overviewRulerLanes:0,
      hideCursorInOverviewRuler:true,padding:{top:0,bottom:0},guides:{indentation:false,bracketPairs:false},
      wordWrap:'off',smoothScrolling:false,contextmenu:true,renderWhitespace:'selection',
      scrollbar:{verticalScrollbarSize:6,horizontalScrollbarSize:6,alwaysConsumeMouseWheel:false,useShadows:false},
      ...options.editorOptions,readOnly:true,domReadOnly:true,lineNumbers:'off',lineDecorationsWidth:0,
    };
    this.editors={original:options.monaco.editor.create(original,{...editorOptions,model:options.original,ariaLabel:'Original comparison pane'}),modified:options.monaco.editor.create(modified,{...editorOptions,readOnly:!this.settings.modifiedEditable,domReadOnly:!this.settings.modifiedEditable,model:options.modified,ariaLabel:'Modified comparison pane'})};
    this.collections={original:this.editors.original.createDecorationsCollection(),modified:this.editors.modified.createDecorationsCollection()};
    this.gutter=new Gutter(this.editors,options.monaco);original.after(this.gutter.element);this.root.append(this.gutter.connectors);
    this.divider=new SplitDivider(this.root,options.splitRatio??.5,ratio=>this.options.onSplitRatioChange?.(ratio),()=>this.layout());
    this.statusNode.className='smart-diff-status';this.statusNode.setAttribute('role','status');this.root.append(this.statusNode);
    this.scrolling=new ScrollSynchronizer(this.editors,this.gutter.schedule);
    this.gutter.setBeforeDraw(()=>this.scrolling.flush());
    this.scrolling.setEnabled(this.settings.synchronizeScrolling);
    this.folding=new FoldingController(this.editors,options.monaco,id=>this.expandRegion(id),this.gutter.schedule);
    this.gutter.setOmissionProvider(()=>this.folding.measure());
    this.alignment=new Alignment(this.editors);
    this.worker=new DiffWorkerClient({workerFactory:options.workerFactory,onResult:result=>this.accept(result),onError:message=>this.emit({status:'error',message,changeCount:0,currentChange:-1}),onTimeout:()=>this.emit({status:'timeout',message:'Comparison timed out. Increase the computation limit or choose a smaller file.',changeCount:0,currentChange:-1})});
    for (const side of sides) {
      // Content-size events also arrive asynchronously after our own zone writes.
      // They invalidate drawing, never rebuild zones (which would cause a loop).
      this.listeners.push(this.editors[side].onDidContentSizeChange(this.gutter.schedule),this.editors[side].onDidLayoutChange(this.gutter.schedule),this.editors[side].onDidChangeConfiguration(()=>{if(!this.structuring)this.scheduleLayout();}));
    }
    this.observer=new ResizeObserver(()=>this.scheduleLayout());this.observer.observe(container);
    this.bindModels();this.layout();this.compute();
  }
  private emit(state: ViewerState): void {
    if(this.disposed)return;
    this.state={...state,featureUnavailable:this.folding.available?[]:['Unchanged-region folding is unavailable with this Monaco runtime.']};
    this.root.dataset.status=state.status;
    this.statusNode.textContent=state.message??(state.status==='loading'?'Computing differences…':state.status==='empty'?'No differences':'');
    this.statusNode.hidden=!this.statusNode.textContent;
    this.options.onStateChange?.({...this.state});
  }
  private bindModels(): void {
    this.modelListeners.forEach(s=>s.dispose());this.modelListeners=[];
    for (const side of sides) {
      this.modelListeners.push(this.options[side].onDidChangeContent(()=>{
        const saved=this.saveViewState();
        this.pendingRestore=saved;
        this.pendingContentChange=true;
        this.worker.invalidate();this.comparison=undefined;this.scrolling.setComparison();this.gutter.update();
        this.scrolling.suspend(()=>{
          this.structuring=true;this.alignment.clear();this.folding.clear();this.structuring=false;
          for(const pane of sides)restoreAnchor(this.editors[pane],saved[pane].anchor);
        });
        this.collections.original.clear();this.collections.modified.clear();
        this.emit({status:'loading',changeCount:0,currentChange:-1});
        clearTimeout(this.debounce);this.debounce=setTimeout(()=>this.compute(),45);
      }));
    }
  }
  private compute(): void {
    if(this.disposed)return;
    this.emit({status:'loading',changeCount:0,currentChange:-1});
    this.worker.compute({requestId:++this.requestId,originalVersion:this.options.original.getVersionId(),modifiedVersion:this.options.modified.getVersionId(),original:this.options.original.getValue(),modified:this.options.modified.getValue(),ignoreTrimWhitespace:this.settings.ignoreTrimWhitespace,maxComputationTimeMs:this.settings.maxComputationTimeMs});
  }
  private accept(comparison: Comparison): void {
    if(this.disposed || comparison.requestId!==this.requestId || comparison.originalVersion!==this.options.original.getVersionId() || comparison.modifiedVersion!==this.options.modified.getVersionId())return;
    const anchor=this.pendingRestore??this.saveViewState();
    // Model content events can precede Monaco's cursor update. Reapplying their
    // saved selection after a worker response would move the caret backwards
    // while typing, or undo a selection made while the comparison was pending.
    if(this.pendingContentChange)for(const side of sides)anchor[side]={...anchor[side],selections:this.editors[side].getSelections()};
    this.pendingContentChange=false;
    this.comparison=comparison;
    if(this.pendingBulkExpansion!==undefined){
      anchor.expandedRegions=this.pendingBulkExpansion?deriveCollapsedRegions(comparison,this.settings.unchangedRegions).map(region=>region.id):[];
      this.pendingBulkExpansion=undefined;
    }
    this.scrolling.setComparison(comparison);
    this.emit({status:comparison.status==='timeout'?'timeout':comparison.changes.length?'ready':'empty',message:comparison.status==='timeout'?'Computation limit reached; the displayed comparison is incomplete.':undefined,changeCount:comparison.changes.length,currentChange:comparison.changes.length?0:-1});
    this.restoreViewState(anchor);this.pendingRestore=undefined;this.paint();
  }
  private paint(): void {
    const active=this.comparison?.changes[this.state.currentChange]?.id;
    for(const side of sides)this.collections[side].set(this.comparison?decorations(this.options.monaco,this.options[side],this.comparison,side,active):[]);
    this.gutter.update(this.comparison,active);
  }
  private structure(): void {
    this.structuring=true;
    try {
      this.alignment.clear();
      this.folding.apply(this.comparison,this.settings.unchangedRegions);
      if(this.settings.layout==='aligned')this.alignment.apply(this.comparison);
    } finally {this.structuring=false;}
    if(!this.folding.available && !this.state.featureUnavailable?.length)this.emit({...this.state});
    this.gutter.schedule();
  }
  private scheduleLayout(): void { if(!this.frame && !this.disposed)this.frame=requestAnimationFrame(()=>{this.frame=0;this.layout();}); }
  layout(): void {
    if(this.disposed)return;
    const anchors={original:captureAnchor(this.editors.original),modified:captureAnchor(this.editors.modified)};
    this.scrolling.suspend(()=>{
      this.structuring=true;
      this.divider.layout();
      for(const side of sides)this.editors[side].layout(undefined,true);
      this.structuring=false;
      this.structure();
      for(const side of sides)restoreAnchor(this.editors[side],anchors[side]);
    });
    this.gutter.flush();
  }
  updateOptions(options: UpdateOptions): void {
    if(this.disposed)return;
    // Preserve a consumer's requested restoration while the first worker result
    // is pending. A live snapshot cannot yet contain its active change ID.
    const anchor={...(this.pendingRestore??this.saveViewState())};
    const contentPending=this.pendingContentChange;
    if(contentPending)for(const side of sides)anchor[side]={...anchor[side],selections:this.editors[side].getSelections()};
    if('onSplitRatioChange' in options)this.options.onSplitRatioChange=options.onSplitRatioChange;
    if(options.splitRatio!==undefined)anchor.splitRatio=options.splitRatio;
    const recompute=options.ignoreTrimWhitespace!==undefined&&options.ignoreTrimWhitespace!==this.settings.ignoreTrimWhitespace || options.maxComputationTimeMs!==undefined&&options.maxComputationTimeMs!==this.settings.maxComputationTimeMs;
    this.settings={...this.settings,...options,unchangedRegions:{...this.settings.unchangedRegions,...options.unchangedRegions}};
    if(options.editorOptions||options.modifiedEditable!==undefined){this.structuring=true;for(const side of sides){const readOnly=side==='original'||!this.settings.modifiedEditable;this.editors[side].updateOptions({...options.editorOptions,readOnly,domReadOnly:readOnly,folding:false,lineNumbers:'off',lineDecorationsWidth:0});}this.structuring=false;}
    this.restoreViewState(anchor);
    this.pendingContentChange=contentPending;
    this.scrolling.setEnabled(this.settings.synchronizeScrolling);
    if(recompute){this.worker.invalidate();this.compute();}
  }
  setModels(models: Pick<SmartDiffOptions,'original'|'modified'>): void {
    if(this.disposed)return;
    clearTimeout(this.debounce);this.worker.invalidate();this.comparison=undefined;this.pendingRestore=undefined;this.pendingBulkExpansion=undefined;this.pendingContentChange=false;
    this.scrolling.setComparison();
    this.scrolling.suspend(()=>{
      this.structuring=true;this.alignment.clear();this.folding.clear();this.folding.setExpanded([]);
      for(const side of sides){this.collections[side].clear();this.editors[side].setModel(models[side]);}
      this.structuring=false;
    });
    this.options={...this.options,...models};this.gutter.update();this.bindModels();this.compute();
  }
  saveViewState(): ViewState {
    return {original:{anchor:captureAnchor(this.editors.original),selections:this.editors.original.getSelections()},modified:{anchor:captureAnchor(this.editors.modified),selections:this.editors.modified.getSelections()},expandedRegions:this.folding.getExpanded(),currentChangeId:this.comparison?.changes[this.state.currentChange]?.id,splitRatio:this.divider.ratio};
  }
  restoreViewState(state: ViewState): void {
    if(this.disposed)return;
    if(!this.comparison){this.pendingRestore=state;this.pendingContentChange=false;}
    this.folding.setExpanded(state.expandedRegions);
    this.scrolling.suspend(()=>{
      this.structuring=true;
      if(state.splitRatio!==undefined)this.divider.setRatio(state.splitRatio);
      this.divider.layout();
      for(const side of sides)this.editors[side].layout(undefined,true);
      this.structuring=false;
      this.structure();
      for(const side of sides){if(state[side].selections?.length)this.editors[side].setSelections(state[side].selections!);restoreAnchor(this.editors[side],state[side].anchor);}
    });
    const index=this.comparison?.changes.findIndex(c=>c.id===state.currentChangeId)??-1;
    if(index>=0)this.emit({...this.state,currentChange:index});
    this.paint();
  }
  expandRegion(id: string): void {
    if(this.disposed)return;
    const state=this.saveViewState();state.expandedRegions.push(id);this.restoreViewState(state);
  }
  expandAllRegions(): void { this.setAllRegionsExpanded(true); }
  collapseAllRegions(): void { this.setAllRegionsExpanded(false); }
  private setAllRegionsExpanded(expanded: boolean): void {
    if(this.disposed)return;
    const state={...(this.pendingRestore??this.saveViewState())};
    this.settings.unchangedRegions={...this.settings.unchangedRegions,collapse:true};
    state.expandedRegions=expanded&&this.comparison?deriveCollapsedRegions(this.comparison,this.settings.unchangedRegions).map(region=>region.id):[];
    this.pendingBulkExpansion=this.comparison?undefined:expanded;
    const contentPending=this.pendingContentChange;
    this.restoreViewState(state);
    this.pendingContentChange=contentPending;
  }
  goToChange(id: string): void {
    const index=this.comparison?.changes.findIndex(c=>c.id===id)??-1;
    if(index<0||!this.comparison)return;
    this.emit({...this.state,currentChange:index});this.paint();
    const change=this.comparison.changes[index];
    this.scrolling.suspend(()=>{for(const side of sides)this.editors[side].revealLineInCenter(Math.min(this.options[side].getLineCount(),change[side].start),1);});
    this.gutter.schedule();
  }
  nextChange(): void { const changes=this.comparison?.changes;if(changes?.length)this.goToChange(changes[(this.state.currentChange+1)%changes.length].id); }
  previousChange(): void { const changes=this.comparison?.changes;if(changes?.length)this.goToChange(changes[(this.state.currentChange-1+changes.length)%changes.length].id); }
  getEditors(): Record<Side,CodeEditor> {return this.editors;}
  getComparison(): Comparison | undefined {return this.comparison;}
  getState(): ViewerState {return {...this.state};}
  dispose(): void {
    if(this.disposed)return;this.disposed=true;
    clearTimeout(this.debounce);cancelAnimationFrame(this.frame);this.observer.disconnect();this.worker.dispose();
    this.modelListeners.forEach(s=>s.dispose());this.listeners.forEach(s=>s.dispose());this.scrolling.dispose();
    this.folding.dispose();this.alignment.dispose();this.divider.dispose();this.gutter.dispose();
    for(const side of sides){this.collections[side].clear();this.editors[side].dispose();}
    this.root.remove();
  }
}
