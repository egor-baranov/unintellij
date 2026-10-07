/** Measurements cover Electron-owned processes across all app windows. */
export interface ProfilerProcess {
  pid: number;
  createdAt: number;
  type: string;
  name: string;
  cpuPercent: number | null;
  memoryBytes: number | null;
}

export interface ProfilerSnapshot {
  timestamp: number;
  uptimeSeconds: number;
  cpuPercent: number | null;
  memoryBytes: number | null;
  processes: ProfilerProcess[];
  heapUsedBytes: number;
  heapTotalBytes: number;
  /** Main-process active event-loop fraction, 0–1; null on first sample. */
  eventLoopUtilization: number | null;
  /** Delay beyond a short main-process timer's requested deadline. */
  eventLoopDelayMs: number | null;
  systemMemory: { totalBytes: number; freeBytes: number };
  disk: {
    bytes: number | null;
    sampledAt: number | null;
    status: 'measuring' | 'ready' | 'partial' | 'unavailable';
    files: number;
    reason?: string;
  };
  gpu: {
    status: string;
    device: string | null;
    /** Host RAM of the GPU process, not dedicated video memory. */
    processMemoryBytes: number | null;
    cpuPercent: number | null;
    utilizationPercent: null;
    reason: string;
  };
}

export interface ProfilerClient {
  readProfilerSnapshot(): Promise<ProfilerSnapshot>;
  /** Shared bounded history collected by the main process since app startup. */
  readProfilerHistory(): Promise<ProfilerSnapshot[]>;
  /** Clears recorded history for every window; sampling continues. */
  clearProfilerHistory(): Promise<void>;
}
