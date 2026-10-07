import { computeComparison } from '../packages/monaco-smart-diff/src/diff/engine';

// Engine-only benchmark; excludes worker startup, transport and Monaco layout.
// Run with `npx tsx scripts/benchmark.ts`. No timing threshold is a test assertion.
const original=Array.from({length:20_000},(_,i)=>`export const value_${i} = ${i};`);
const modified=original.map((line,i)=>i%83===0?line.replace(`= ${i};`,`= ${i+1}; // updated`):line);
const rows=Array.from({length:5},(_,requestId)=> {
  const comparison=computeComparison({requestId,originalVersion:1,modifiedVersion:1,original:original.join('\n'),modified:modified.join('\n'),ignoreTrimWhitespace:false,maxComputationTimeMs:5_000});
  return {run:requestId+1,lines:comparison.originalLineCount,changes:comparison.changes.length,status:comparison.status,durationMs:Number(comparison.durationMs.toFixed(1))};
});
console.table(rows);
