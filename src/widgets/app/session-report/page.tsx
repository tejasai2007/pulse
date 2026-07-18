'use client';

import { useEffect, useState, type MouseEvent, type ReactNode } from 'react';
import { useApp } from '@modelcontextprotocol/ext-apps/react';
import { useTheme, useWidgetSDK } from '@nitrostack/widgets';

type VitalItem = {
  kind: 'vital';
  atMs: number;
  evidenceId: string;
  sample: { bpm: number; availability: string };
};
type TranscriptItem = {
  kind: 'transcript';
  atMs: number;
  evidenceId: string;
  segment: { segmentId: string; text: string; startMs: number; endMs: number };
};
type Report = {
  session: { sessionId: string; startedAt: string | null; endedAt: string | null };
  durationMs: number;
  summary: {
    averageBpm: number | null;
    maximumBpm: number | null;
    paceWordsPerMinute: number;
    stressEpisodeCount: number;
    averageRecoveryTimeMs: number | null;
  };
  timeline: Array<VitalItem | TranscriptItem | { kind: string; atMs: number }>;
  limitations: Array<'heart_rate_unavailable' | 'transcript_unavailable' | 'audio_playback_unavailable'>;
};

export default function SessionReportWidget() {
  return <SessionReportContent />;
}

function SessionReportContent() {
  const { isReady: isNitroReady, getToolOutput } = useWidgetSDK();
  const nitroTheme = useTheme();
  const mcp = useMcpAppReport();
  const [scrubberMs, setScrubberMs] = useState<number | null>(null);
  const report = mcp.report ?? (isNitroReady ? getToolOutput<Report>() : null);
  const theme = mcp.theme ?? nitroTheme;

  if (!isNitroReady && !mcp.hasResult) return <Shell dark={theme === 'dark'}>Aligning evidence...</Shell>;
  if (!report) return <Shell dark={theme === 'dark'}>No report data available.</Shell>;

  const vitals = report.timeline.filter((item): item is VitalItem => item.kind === 'vital');
  const transcript = report.timeline.filter((item): item is TranscriptItem => item.kind === 'transcript');
  const peak = vitals.reduce<VitalItem | undefined>((current, item) =>
    !current || item.sample.bpm > current.sample.bpm ? item : current, undefined);
  const selectedMs = scrubberMs ?? peak?.atMs ?? 0;
  const selectedSegment = closestSegment(transcript, selectedMs);
  const selectedVital = closestVital(vitals, selectedMs);
  const dark = theme === 'dark';
  const ink = dark ? '#f5f0e6' : '#18231f';
  const muted = dark ? '#a9b6ae' : '#64726a';
  const panel = dark ? '#14201c' : '#f4f0e7';
  const line = dark ? '#31453d' : '#d8d1c2';
  const accent = '#eb6b43';
  const chartPoints = vitalPoints(vitals, report.durationMs);

  const selectChartTime = (event: MouseEvent<SVGSVGElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    setScrubberMs(Math.round(((event.clientX - bounds.left) / bounds.width) * report.durationMs));
  };

  return (
    <Shell dark={dark}>
      <div style={{ color: ink, fontFamily: 'Georgia, Cambria, serif' }}>
        <header style={{ display: 'flex', justifyContent: 'space-between', gap: 20, alignItems: 'flex-end', marginBottom: 24 }}>
          <div>
            <div style={{ color: accent, font: '700 11px system-ui', letterSpacing: '0.16em', textTransform: 'uppercase' }}>Evidence review</div>
            <h1 style={{ fontSize: 'clamp(27px, 5vw, 46px)', lineHeight: 0.95, margin: '8px 0 0' }}>Session pulse</h1>
          </div>
          <time style={{ color: muted, font: '12px system-ui', whiteSpace: 'nowrap' }}>{formatTime(report.durationMs)}</time>
        </header>

        <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: 1, background: line, border: `1px solid ${line}` }}>
          <Metric label="Average" value={report.summary.averageBpm === null ? '--' : `${Math.round(report.summary.averageBpm)} bpm`} dark={dark} />
          <Metric label="Peak" value={report.summary.maximumBpm === null ? '--' : `${report.summary.maximumBpm} bpm`} dark={dark} />
          <Metric label="Pace" value={`${Math.round(report.summary.paceWordsPerMinute)} wpm`} dark={dark} />
          <Metric label="Episodes" value={String(report.summary.stressEpisodeCount)} dark={dark} />
          <Metric label="Recovery" value={report.summary.averageRecoveryTimeMs === null ? '--' : formatTime(report.summary.averageRecoveryTimeMs)} dark={dark} />
        </section>

        <section style={{ marginTop: 26, background: panel, border: `1px solid ${line}`, padding: '18px 18px 12px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', color: muted, font: '600 11px system-ui', textTransform: 'uppercase', letterSpacing: '0.1em' }}>
            <span>Heart rate</span><span>{selectedVital ? `${selectedVital.sample.bpm} bpm at ${formatTime(selectedVital.atMs)}` : 'No samples'}</span>
          </div>
          <svg viewBox="0 0 800 180" role="img" aria-label="Heart-rate timeline" onClick={selectChartTime}
            style={{ display: 'block', width: '100%', height: 180, cursor: 'crosshair', marginTop: 10 }}>
            <line x1="0" y1="150" x2="800" y2="150" stroke={line} />
            {chartPoints && <polyline points={chartPoints} fill="none" stroke={accent} strokeWidth="4" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />}
            <line x1={xAt(selectedMs, report.durationMs)} y1="4" x2={xAt(selectedMs, report.durationMs)} y2="160" stroke={ink} strokeDasharray="5 5" opacity="0.65" />
            {vitals.map((item) => <circle key={item.evidenceId} cx={xAt(item.atMs, report.durationMs)} cy={yAt(item.sample.bpm, vitals)} r="7" fill={panel} stroke={accent} strokeWidth="3"
              onClick={(event) => { event.stopPropagation(); setScrubberMs(item.atMs); }} />)}
          </svg>
          <input aria-label="Session timeline scrubber" type="range" min={0} max={Math.max(1, report.durationMs)} value={selectedMs}
            onChange={(event) => setScrubberMs(Number(event.target.value))} style={{ width: '100%', accentColor: accent }} />
          <div style={{ display: 'flex', justifyContent: 'space-between', color: muted, font: '11px system-ui' }}><span>00:00</span><span>{formatTime(report.durationMs)}</span></div>
        </section>

        <section style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.35fr) minmax(190px, .65fr)', gap: 18, marginTop: 18 }}>
          <div style={{ borderLeft: `4px solid ${accent}`, padding: '8px 0 8px 18px', minHeight: 110 }}>
            <div style={{ color: muted, font: '700 11px system-ui', letterSpacing: '0.12em', textTransform: 'uppercase' }}>Transcript at {formatTime(selectedMs)}</div>
            <blockquote style={{ fontSize: 'clamp(18px, 3vw, 27px)', lineHeight: 1.28, margin: '12px 0 8px' }}>
              {selectedSegment ? `“${selectedSegment.segment.text}”` : 'No transcript near this moment.'}
            </blockquote>
            {selectedSegment && <code style={{ color: muted, fontSize: 11 }}>{selectedSegment.evidenceId}</code>}
          </div>
          <div style={{ font: '13px/1.45 system-ui', color: muted }}>
            <strong style={{ color: ink, display: 'block', marginBottom: 8 }}>Jump to a moment</strong>
            {transcript.slice(0, 5).map((item) => <button key={item.evidenceId} onClick={() => setScrubberMs(item.atMs)}
              style={{ display: 'block', width: '100%', color: muted, background: 'transparent', border: 0, borderTop: `1px solid ${line}`, padding: '8px 0', textAlign: 'left', cursor: 'pointer' }}>
              {formatTime(item.atMs)} · {item.segment.text.slice(0, 42)}{item.segment.text.length > 42 ? '...' : ''}
            </button>)}
          </div>
        </section>

        {report.limitations.length > 0 && <footer style={{ color: muted, borderTop: `1px solid ${line}`, marginTop: 22, paddingTop: 12, font: '12px/1.5 system-ui' }}>
          {report.limitations.map(limitationLabel).join(' · ')}
        </footer>}
      </div>
    </Shell>
  );
}

function useMcpAppReport(): {
  report: Report | null;
  hasResult: boolean;
  theme: 'light' | 'dark' | null;
} {
  const [report, setReport] = useState<Report | null>(null);
  const [hasResult, setHasResult] = useState(false);
  const [theme, setTheme] = useState<'light' | 'dark' | null>(null);
  const { app, isConnected } = useApp({
    appInfo: { name: 'Pulse session report', version: '0.2.0' },
    capabilities: {},
    onAppCreated: (createdApp) => {
      createdApp.addEventListener('toolresult', (result) => {
        setReport(reportFromToolResult(result));
        setHasResult(true);
      });
      createdApp.addEventListener('hostcontextchanged', (context) => {
        if (context.theme) setTheme(context.theme);
      });
    }
  });

  useEffect(() => {
    if (!app || !isConnected) return;
    const hostTheme = app.getHostContext()?.theme;
    if (hostTheme) setTheme(hostTheme);
  }, [app, isConnected]);

  return { report, hasResult, theme };
}

function reportFromToolResult(result: { structuredContent?: unknown; content?: unknown }): Report | null {
  if (isReport(result.structuredContent)) return result.structuredContent;
  if (!Array.isArray(result.content)) return null;

  const textBlock = result.content.find((item) =>
    isRecord(item) && item.type === 'text' && typeof item.text === 'string');
  if (!isRecord(textBlock) || typeof textBlock.text !== 'string') return null;

  try {
    const parsed: unknown = JSON.parse(textBlock.text);
    return isReport(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isReport(value: unknown): value is Report {
  return isRecord(value) &&
    isRecord(value.session) &&
    typeof value.durationMs === 'number' &&
    isRecord(value.summary) &&
    Array.isArray(value.timeline) &&
    Array.isArray(value.limitations);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function Shell({ dark, children }: { dark: boolean; children: ReactNode }) {
  return <main style={{ boxSizing: 'border-box', minHeight: 240, padding: 'clamp(18px, 4vw, 38px)', background: dark ? '#0a110f' : '#fffdf8' }}>{children}</main>;
}

function Metric({ label, value, dark }: { label: string; value: string; dark: boolean }) {
  return <div style={{ background: dark ? '#0a110f' : '#fffdf8', padding: '14px 12px' }}><div style={{ font: '10px system-ui', opacity: .62, textTransform: 'uppercase', letterSpacing: '.1em' }}>{label}</div><strong style={{ display: 'block', marginTop: 6, fontSize: 17 }}>{value}</strong></div>;
}

function closestSegment(items: TranscriptItem[], atMs: number): TranscriptItem | undefined {
  return items.find(({ segment }) => atMs >= segment.startMs && atMs <= segment.endMs) ??
    items.reduce<TranscriptItem | undefined>((closest, item) => !closest || distanceToSegment(item, atMs) < distanceToSegment(closest, atMs) ? item : closest, undefined);
}

function distanceToSegment(item: TranscriptItem, atMs: number): number {
  return Math.min(Math.abs(atMs - item.segment.startMs), Math.abs(atMs - item.segment.endMs));
}

function closestVital(items: VitalItem[], atMs: number): VitalItem | undefined {
  return items.reduce<VitalItem | undefined>((closest, item) => !closest || Math.abs(item.atMs - atMs) < Math.abs(closest.atMs - atMs) ? item : closest, undefined);
}

function vitalPoints(items: VitalItem[], durationMs: number): string | undefined {
  if (items.length === 0) return undefined;
  return items.map((item) => `${xAt(item.atMs, durationMs)},${yAt(item.sample.bpm, items)}`).join(' ');
}

function xAt(atMs: number, durationMs: number): number {
  return durationMs <= 0 ? 0 : Math.min(800, Math.max(0, atMs / durationMs * 800));
}

function yAt(bpm: number, items: VitalItem[]): number {
  const values = items.map((item) => item.sample.bpm);
  const low = Math.min(...values);
  const high = Math.max(...values);
  return high === low ? 90 : 150 - ((bpm - low) / (high - low)) * 120;
}

function formatTime(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1_000));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function limitationLabel(value: Report['limitations'][number]): string {
  if (value === 'heart_rate_unavailable') return 'Heart-rate data unavailable';
  if (value === 'transcript_unavailable') return 'Transcript unavailable';
  return 'Audio playback unavailable because raw audio is not retained';
}
