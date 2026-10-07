import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import type { BranchOperation, BranchSnapshot, GitBranch } from './types';
import { Select, UiIcon } from '../ui';
import type { CommitSubmission } from '../commit/options';

export type BranchDialogRequest =
  | { kind: 'create'; branch?: GitBranch }
  | { kind: 'rename' | 'delete' | 'merge' | 'rebase' | 'checkout'; branch: GitBranch }
  | { kind: 'checkout-rebase' | 'checkout-update'; branch: GitBranch }
  | { kind: 'checkout-revision' }
  | ({ kind: 'commit' } & Partial<CommitSubmission>)
  | { kind: 'abort' }
  | { kind: 'update' | 'push'; branch?: GitBranch; afterCommit?: boolean };

export function BranchDialog({ request, snapshot, repositoryName, preview, busy, error, reviewChanged, onReviewLatest, onCancel, onSubmit }: {
  request: BranchDialogRequest; snapshot: BranchSnapshot; repositoryName: string; preview?: boolean;
  busy: boolean; error?: string; onCancel: () => void; onSubmit: (operation: BranchOperation) => void;
  reviewChanged: boolean; onReviewLatest: () => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const branch = 'branch' in request ? request.branch : undefined;
  const [name, setName] = useState(request.kind === 'rename' ? branch?.name ?? '' : request.kind === 'commit' ? request.message ?? '' : '');
  const [checkout, setCheckout] = useState(true);
  const [force, setForce] = useState(false);
  const [amend, setAmend] = useState(false);
  const [smart, setSmart] = useState(false);
  const [method, setMethod] = useState<'merge' | 'rebase' | 'ff-only'>('ff-only');
  const [remote, setRemote] = useState(branch?.kind === 'remote' ? branch.name.split('/')[0] : snapshot.remotes[0] ?? '');
  const [setUpstream, setSetUpstream] = useState(!branch?.upstream);
  const [unsetUpstream, setUnsetUpstream] = useState(false);
  const current = snapshot.current?.replace(/^refs\/heads\//, '') ?? (snapshot.unborn ? 'unborn HEAD' : `detached HEAD ${snapshot.head?.slice(0, 8) ?? ''}`);
  const selectedCommit = request.kind === 'commit' && request.changeIds !== undefined;
  const selectedUnavailable = selectedCommit && !snapshot.selectedCommitSupported;
  const commitCount = request.kind === 'commit' ? request.changeIds?.length ?? snapshot.stagedCount : 0;
  const titles: Record<BranchDialogRequest['kind'], string> = {
    create: 'New Branch', rename: 'Rename Branch', delete: 'Delete Branch', merge: 'Merge Branch', rebase: 'Rebase Current Branch',
    checkout: 'Checkout Branch', 'checkout-rebase': 'Checkout and Rebase', 'checkout-update': 'Checkout and Update',
    'checkout-revision': 'Checkout Tag or Revision', commit: selectedCommit ? 'Commit Selected Changes' : 'Commit Staged Changes', update: 'Update Project', push: branch?.kind === 'tag' ? 'Push Tag' : 'Push Branch', abort: `Abort ${snapshot.operation === 'merge' ? 'Merge' : 'Rebase'}`,
  };
  const buttons: Record<BranchDialogRequest['kind'], string> = {
    create: 'Create', rename: 'Rename', delete: 'Delete', merge: 'Merge', rebase: 'Rebase', checkout: 'Checkout',
    'checkout-rebase': 'Checkout and Rebase', 'checkout-update': 'Checkout and Update', 'checkout-revision': 'Checkout',
    commit: request.kind === 'commit' && request.pushAfterCommit ? 'Commit and Continue to Push' : amend ? 'Amend Commit' : 'Commit', update: 'Update', push: 'Push', abort: 'Abort',
  };
  const hasName = ['create', 'rename', 'checkout-revision', 'commit'].includes(request.kind);
  useEffect(() => {
    const previous = document.activeElement;
    const initial = panel.current?.querySelector<HTMLElement>('input:not([type="checkbox"]):not([type="radio"]),textarea,[role="combobox"]')
      ?? panel.current?.querySelector<HTMLElement>('footer button');
    initial?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || reviewChanged || selectedUnavailable || (hasName && !name.trim()) || (request.kind === 'push' && !remote)) return;
    let operation: BranchOperation;
    switch (request.kind) {
      case 'create': operation = { kind: 'create', name: name.trim(), startRef: branch?.ref, checkout }; break;
      case 'rename': operation = { kind: 'rename', ref: request.branch.ref, name: name.trim(), unsetUpstream }; break;
      case 'delete': operation = { kind: 'delete', ref: request.branch.ref, force }; break;
      case 'checkout-revision': operation = { kind: 'checkout-revision', revision: name.trim() }; break;
      case 'commit': operation = { kind: 'commit', message: name, amend, changeIds: request.changeIds, options: request.options }; break;
      case 'abort': operation = { kind: 'abort' }; break;
      case 'checkout': operation = { kind: 'checkout', ref: request.branch.ref, smart }; break;
      case 'merge': operation = { kind: 'merge', ref: request.branch.ref }; break;
      case 'rebase': operation = { kind: 'rebase', ref: request.branch.ref }; break;
      case 'checkout-rebase': operation = { kind: 'rebase', ref: request.branch.ref, checkout: true }; break;
      case 'checkout-update': operation = { kind: 'checkout-update', ref: request.branch.ref, method }; break;
      case 'update': operation = { kind: 'update', ref: branch?.ref, method }; break;
      case 'push': operation = { kind: 'push', ref: branch?.ref, remote, setUpstream: branch?.kind === 'tag' ? false : setUpstream }; break;
    }
    onSubmit(operation);
  }
  return createPortal(<div className="branch-modal-shade" onPointerDown={event => { if (event.target === event.currentTarget && !busy) onCancel(); }}>
    <div className="branch-dialog" ref={panel} role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={event => {
      if (event.defaultPrevented) return;
      if (event.key === 'Escape') { event.stopPropagation(); if (!busy) onCancel(); }
      if (event.key !== 'Tab') return;
      const focusable = [...(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),[tabindex="0"]') ?? [])];
      if (!focusable.length) { event.preventDefault(); return; }
      const index = focusable.indexOf(document.activeElement as HTMLElement);
      if (event.shiftKey && index <= 0) { event.preventDefault(); focusable.at(-1)?.focus(); }
      else if (!event.shiftKey && (index < 0 || index === focusable.length - 1)) { event.preventDefault(); focusable[0]?.focus(); }
    }}>
      <form onSubmit={submit}>
        <header><h2 id={titleId}>{titles[request.kind]}</h2><button type="button" className="ui-toolbar-icon" aria-label="Close dialog" disabled={busy} onClick={onCancel}><UiIcon name="close" /></button></header>
        <div className="branch-dialog-body">
          <p className="branch-dialog-context">{repositoryName} <span>·</span> {current}</p>
          {preview && <p className="branch-dialog-hint">Interactive preview — changes apply to the sample repository only.</p>}
          {request.kind === 'create' && <><p>Create from <strong>{branch?.name ?? current}</strong>.</p><label>Branch name<input autoComplete="off" value={name} onChange={event => setName(event.target.value)} required /></label><label className="branch-check"><input type="checkbox" checked={checkout} onChange={event => setCheckout(event.target.checked)} />Checkout branch</label></>}
          {request.kind === 'rename' && <><p>Rename <strong>{branch?.name}</strong>. Existing commits are preserved.</p><label>New branch name<input autoComplete="off" value={name} onChange={event => setName(event.target.value)} required /></label>{branch?.upstream && <label className="branch-check"><input type="checkbox" checked={unsetUpstream} onChange={event => setUnsetUpstream(event.target.checked)} />Unset upstream tracking ({branch.upstream})</label>}</>}
          {request.kind === 'checkout-revision' && <><p>Enter a tag, branch, or commit ID. Tags and commit IDs open a detached HEAD.</p><label>Tag or revision<input autoComplete="off" value={name} onChange={event => setName(event.target.value)} required /></label></>}
          {request.kind === 'checkout' && <><p>Switch from <strong>{current}</strong> to <strong>{branch?.name}</strong>.</p>{snapshot.dirty && <><p className="branch-dialog-hint">This repository has local changes. Git will refuse checkout if it would overwrite them.</p><label className="branch-check"><input type="checkbox" checked={smart} onChange={event => setSmart(event.target.checked)} />Smart checkout: shelve local changes and restore them after checkout</label><p className="branch-dialog-hint">If restoration conflicts, your changes remain saved in Git's stash.</p></>}</>}
          {request.kind === 'delete' && <><p>Delete {branch?.kind === 'remote' ? 'remote branch' : branch?.kind === 'tag' ? 'tag' : 'local branch'} <strong>{branch?.name}</strong>?</p>{branch?.kind === 'remote' ? <p className="branch-dialog-hint">This removes the branch from the remote repository for everyone.</p> : branch?.kind === 'local' && <><p className="branch-dialog-hint">Git checks that the branch is merged before deleting it.</p><label className="branch-check"><input type="checkbox" checked={force} onChange={event => setForce(event.target.checked)} />Force delete even if unmerged</label></>}</>}
          {request.kind === 'merge' && <p>Merge <strong>{branch?.name}</strong> into <strong>{current}</strong>. Git may create a merge commit.</p>}
          {request.kind === 'rebase' && <p>Replay commits from <strong>{current}</strong> on top of <strong>{branch?.name}</strong>. This rewrites those commits.</p>}
          {request.kind === 'checkout-rebase' && <p>Check out <strong>{branch?.name}</strong> and replay its commits on top of <strong>{current}</strong>. This rewrites those commits.</p>}
          {(request.kind === 'update' || request.kind === 'checkout-update') && <><p>{request.kind === 'checkout-update' ? 'Check out and update' : 'Fetch and update'} <strong>{branch?.name ?? current}</strong> from its upstream.</p><fieldset><legend>Update method</legend>{(['ff-only', 'merge', 'rebase'] as const).map(value => <label className="branch-check" key={value}><input type="radio" name="update-method" value={value} checked={method === value} onChange={() => setMethod(value)} />{value === 'ff-only' ? 'Fast-forward only' : value === 'merge' ? 'Merge incoming changes' : 'Rebase local commits'}</label>)}</fieldset></>}
          {request.kind === 'push' && <>{request.afterCommit && <p role="status">Commit created. Choose where to push it.</p>}{!snapshot.remotes.length && <p className="branch-dialog-hint">No remotes are configured. The commit is saved locally.</p>}{!snapshot.current && request.afterCommit && <p className="branch-dialog-hint">Create a branch for this detached commit before pushing.</p>}<p>Push <strong>{branch?.name ?? current}</strong> to the selected remote. Force pushing is disabled.</p><div className="branch-dialog-field"><span>Remote</span><Select label="Remote" value={remote} onChange={setRemote} options={snapshot.remotes.map(value => ({ value, label: value }))} /></div>{branch?.kind !== 'tag' && <label className="branch-check"><input type="checkbox" checked={setUpstream} onChange={event => setSetUpstream(event.target.checked)} />Set upstream tracking</label>}</>}
          {request.kind === 'abort' && <p>Abort the {snapshot.operation} and restore the branch to its state before the operation. Uncommitted edits made while resolving conflicts may be lost.</p>}
          {request.kind === 'commit' && <><p><strong>{commitCount} {selectedCommit ? 'selected' : 'staged'} {commitCount === 1 ? 'file' : 'files'}</strong> will be committed. {selectedCommit ? 'Unchecked changes are preserved. Selecting both versions of a file commits its working copy.' : 'Unstaged and untracked changes are excluded.'}</p>{request.options && <dl className="commit-review-options"><dt>Author</dt><dd>{request.options.author.trim() || 'Repository default'}</dd><dt>Sign-off</dt><dd>{request.options.signOff ? 'Yes' : 'No'}</dd><dt>Checks</dt><dd>{[request.options.checkWhitespace && 'Whitespace', request.options.checkTodo && 'New TODOs'].filter(Boolean).join(', ') || 'None'}</dd></dl>}<label>Commit message<textarea rows={4} value={name} onChange={event => setName(event.target.value)} required /></label><label className="branch-check"><input type="checkbox" checked={amend} disabled={snapshot.unborn} onChange={event => setAmend(event.target.checked)} />Amend the last commit</label>{amend && <p className="branch-dialog-hint">Amending replaces the previous commit with a new commit ID.</p>}</>}
          {['merge', 'rebase', 'checkout-rebase', 'update', 'checkout-update'].includes(request.kind) && snapshot.dirty && <p className="branch-dialog-hint">Commit or stash local changes first if Git cannot apply this operation cleanly. You can abort an interrupted merge or rebase from the branch popup.</p>}
          {error && <p role="alert" className="branch-error">{error}</p>}
          {selectedUnavailable && <p role="alert" className="branch-error">Restart unintellij to load selected-file commit support.</p>}
          {reviewChanged && <p className="branch-dialog-hint" role="status">The repository changed after this review opened. Refresh the review to check the latest branch and staged changes before continuing.</p>}
        </div>
        <footer><button type="button" onClick={onCancel} disabled={busy}>Cancel</button>{reviewChanged && <button type="button" onClick={onReviewLatest} disabled={busy}>Review Latest State</button>}<button className={request.kind === 'delete' || request.kind === 'abort' ? 'branch-danger' : 'branch-primary'} type="submit" disabled={busy || reviewChanged || selectedUnavailable || (hasName && !name.trim()) || (request.kind === 'push' && !remote) || (request.kind === 'commit' && !commitCount && !amend) || (request.kind === 'push' && request.afterCommit === true && !snapshot.current)}>{busy ? 'Working…' : buttons[request.kind]}</button></footer>
      </form>
    </div>
  </div>, document.body);
}
