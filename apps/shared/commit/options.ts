export interface CommitOptions {
  /** Blank uses the repository's configured author. */
  author: string;
  signOff: boolean;
  checkWhitespace: boolean;
  checkTodo: boolean;
}

export const defaultCommitOptions: CommitOptions = {
  author: '', signOff: false, checkWhitespace: false, checkTodo: false,
};

export interface CommitSubmission {
  message: string;
  changeIds: string[];
  options: CommitOptions;
  pushAfterCommit: boolean;
}
