import { useEffect, useId, useRef, useState } from 'react';
import type { ProfilerClient, ProfilerSnapshot } from './types';
import { formatProfilerBytes, formatProfilerMilliseconds, formatProfilerPercent, measuredValue, profilerAxisMaximum, profilerChartSegments, PROFILER_SAMPLE_MS } from './model';
import './profiler.css';

interface Metric {
  id: string;
  label: string;
  graphLabel: string;
  unit: 'bytes' | 'percent' | 'milliseconds';
  read: (snapshot: ProfilerSnapshot) => number | null;
}

const metrics: Metric[] = [
  { id: 'cpu', label: 'CPU · all processes', graphLabel: 'CPU history', unit: 'percent', read: snapshot => snapshot.cpuPercent },
  { id: 'memory', label: 'RAM · working sets', graphLabel: 'Memory history', unit: 'bytes', read: snapshot => snapshot.memoryBytes },
  { id: 'disk', label: 'App storage', graphLabel: 'App storage history', unit: 'bytes', read: snapshot => snapshot.disk.bytes },
  { id: 'gpu', label: 'GPU process · host RAM', graphLabel: 'GPU process memory history', unit: 'bytes', read: snapshot => snapshot.gpu.processMemoryBytes },
  { id: 'heap', label: 'Main-process heap', graphLabel: 'Main-process heap history', unit: 'bytes', read: snapshot => snapshot.heapUsedBytes },
  { id: 'event-loop', label: 'Main loop delay', graphLabel: 'Main loop delay history', unit: 'milliseconds', read: snapshot => snapshot.eventLoopDelayMs },
];

function MetricGraph({ metric, history, latest }: { metric: Metric; history: readonly ProfilerSnapshot[]; latest?: ProfilerSnapshot }) {
  const descriptionId = useId();
  const format = metric.unit === 'bytes' ? formatProfilerBytes : metric.unit === 'milliseconds' ? formatProfilerMilliseconds : formatProfilerPercent;
  const samples = history.map(snapshot => ({ timestamp: snapshot.timestamp, value: metric.read(snapshot) }));
  const maximum = profilerAxisMaximum(samples.map(sample => sample.value), metric.unit);
  const segments = profilerChartSegments(samples, history[history.length - 1]?.timestamp ?? 0, maximum);
  const value = latest ? metric.read(latest) : null;
  const partial = metric.id === 'disk' && latest?.disk.status === 'partial';
  const note = metric.id === 'cpu' ? '100% = one CPU core'
    : metric.id === 'memory' ? 'Sum across Electron processes'
    : metric.id === 'disk' ? `Data + cache on disk · ${latest?.disk.status === 'measuring' ? 'measuring…' : latest?.disk.status === 'partial' ? 'partial scan' : latest?.disk.status === 'unavailable' ? 'unavailable' : 'refreshed every 30 s'}`
    : metric.id === 'gpu' ? 'System RAM, not VRAM'
    : metric.id === 'heap' ? latest ? `Used · ${formatProfilerBytes(latest.heapTotalBytes)} allocated` : 'Used JavaScript heap'
    : 'Delay beyond a 20 ms timer deadline';
  const noteDetail = metric.id === 'disk' ? latest?.disk.reason
    : metric.id === 'memory' ? 'Sum of process working sets. Shared memory pages may be counted in more than one process.'
    : metric.id === 'event-loop' ? 'One main-process timer probe per sample. Measures delay beyond its requested 20 ms deadline, not a continuous histogram.'
    : undefined;
  return <section className="profiler-metric" data-metric={metric.id}>
    <div className="profiler-metric-heading"><h3>{metric.label}</h3><span className="profiler-value">{partial && measuredValue(value) !== null ? '≥ ' : ''}{format(value)}</span></div>
    <p id={descriptionId} className="profiler-metric-note" title={noteDetail}>{note}</p>
    <svg className="profiler-chart" viewBox="0 0 320 90" role="img" aria-label={metric.graphLabel} aria-describedby={descriptionId}>
      <title>{metric.label}: {format(value)}. Range zero to {format(maximum)} over the last 120 seconds. Gaps indicate unavailable or missed measurements.</title>
      <path className="profiler-chart-grid" d="M53 8H312 M53 40H312 M53 72H312" />
      <text className="profiler-chart-axis" x="48" y="12" textAnchor="end">{format(maximum)}</text>
      <text className="profiler-chart-axis" x="48" y="75" textAnchor="end">0</text>
      <text className="profiler-chart-axis" x="53" y="87">−120 s</text>
      <text className="profiler-chart-axis" x="312" y="87" textAnchor="end">latest</text>
      {segments.map(segment => <g key={segment.points[0].timestamp}>
        <path className="profiler-chart-line" d={segment.path} />
        {segment.points.length === 1 && <circle className="profiler-chart-point" cx={segment.points[0].x} cy={segment.points[0].y} r="1.7" />}
      </g>)}
      {!segments.length && <text className="profiler-chart-empty" x="182" y="43" textAnchor="middle">{history.length ? 'Unavailable' : 'Waiting for samples'}</text>}
    </svg>
  </section>;
}

export function ProfilerPanel({ client }: { client?: ProfilerClient }) {
  const [history, setHistory] = useState<ProfilerSnapshot[]>([]);
  const [latest, setLatest] = useState<ProfilerSnapshot>();
  const [paused, setPaused] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [hidden, setHidden] = useState(() => document.hidden);
  const [error, setError] = useState<string>();
  const inFlight = useRef(false);
  const historyGeneration = useRef(0);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  useEffect(() => {
    if (!client) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      if (!disposed && !paused && !clearing && !document.hidden) timer = setTimeout(() => { void sample(); }, PROFILER_SAMPLE_MS);
    };
    const sample = async () => {
      if (disposed || paused || clearing || document.hidden) return;
      if (inFlight.current) { schedule(); return; }
      inFlight.current = true;
      const generation = historyGeneration.current;
      try {
        const snapshots = await client.readProfilerHistory();
        if (!disposed && !document.hidden && generation === historyGeneration.current) {
          setLatest(snapshots.at(-1));
          setHistory(snapshots);
          setError(undefined);
        }
      } catch (reason) {
        if (!disposed && generation === historyGeneration.current) {
          const message = reason instanceof Error ? reason.message : 'Unable to read application measurements.';
          setError(/No handler registered for ['"]profiler:/.test(message) ? 'Restart unintellij to enable the profiler.' : message);
        }
      } finally {
        inFlight.current = false;
        schedule();
      }
    };
    const visibility = () => {
      setHidden(document.hidden);
      clearTimeout(timer);
      if (!document.hidden && !paused && !clearing && !inFlight.current) void sample();
    };
    document.addEventListener('visibilitychange', visibility);
    setHidden(document.hidden);
    void sample();
    return () => { disposed = true; clearTimeout(timer); document.removeEventListener('visibilitychange', visibility); };
  }, [client, paused, clearing]);

  if (!client) return <section className="profiler-panel"><p className="profiler-muted">Live application measurements are available in the desktop app.</p></section>;
  const clear = async () => {
    historyGeneration.current++;
    setClearing(true);
    try {
      await client.clearProfilerHistory();
      if (mounted.current) { setHistory([]); setLatest(undefined); setError(undefined); }
    } catch (reason) {
      if (mounted.current) setError(reason instanceof Error ? reason.message : 'Unable to clear profiler history.');
    } finally { if (mounted.current) setClearing(false); }
  };
  return <section className="profiler-panel" aria-label="Live application profiler" data-sample-count={history.length}>
    <div className="profiler-toolbar">
      <span className="profiler-muted">Last 2 minutes · all app windows</span>
      <div className="profiler-actions"><button type="button" onClick={() => setPaused(value => !value)}>{paused ? 'Resume charts' : 'Pause charts'}</button><button type="button" onClick={() => { void clear(); }} disabled={!history.length || clearing} title="Clear recorded history for all app windows; recording continues">Clear history</button></div>
    </div>
    <div className="profiler-status" role="status" title={error}>{error ? `Measurements unavailable: ${error}` : paused ? 'Charts paused · recording continues' : hidden ? 'Charts hidden · recording continues' : 'Recording since app startup · updated every second'}</div>
    <div className="profiler-metrics">{metrics.map(metric => <MetricGraph key={metric.id} metric={metric} history={history} latest={latest} />)}</div>
    <p className="profiler-scope-note">Electron-owned processes only; Git and other external subprocesses are excluded.</p>
    <p className="profiler-device-note">{latest?.gpu.device ? `${latest.gpu.device} · ` : ''}{latest ? `Acceleration: ${latest.gpu.status}. ` : ''}Hardware GPU utilization, VRAM, and disk I/O rates are unavailable.</p>
    <div className="profiler-process-heading"><h3>Processes</h3><span className="profiler-muted">{latest?.processes.length ?? '—'}</span></div>
    <div className="profiler-process-scroll"><table className="profiler-processes"><thead><tr><th scope="col">Process / type</th><th scope="col">PID</th><th scope="col">CPU</th><th scope="col">RAM</th></tr></thead><tbody>
      {latest?.processes.map(process => <tr key={`${process.pid}:${process.createdAt}`}>
        <td title={`${process.name} · ${process.type}`}><span>{process.name || process.type}</span>{process.name && process.name !== process.type && <small>{process.type}</small>}</td>
        <td>{process.pid}</td><td>{formatProfilerPercent(process.cpuPercent)}</td><td>{formatProfilerBytes(process.memoryBytes)}</td>
      </tr>)}
      {!latest && <tr><td colSpan={4} className="profiler-muted">Waiting for process measurements</td></tr>}
    </tbody></table></div>
  </section>;
}
