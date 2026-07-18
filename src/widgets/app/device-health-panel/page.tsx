'use client';

import { useTheme, useWidgetSDK } from '@nitrostack/widgets';

type State = 'connected' | 'degraded' | 'offline' | 'unavailable' | 'unknown';
type Mode = 'live' | 'simulated' | 'fallback' | 'unavailable' | null;

interface ComponentStatus { state: State; mode: Mode; detail: string; checkedAt: string }
interface DeviceStatus {
  session: { sessionId: string; status: string } | null;
  flags: { simulatedVitals: boolean; simulatedDeviceActions: boolean; activeFallbacks: string[] };
  watch: ComponentStatus;
  phone: ComponentStatus;
  earbuds: ComponentStatus;
  microphone: ComponentStatus;
  transcriptionProvider: ComponentStatus;
  backend: ComponentStatus;
  agentAccess: ComponentStatus;
}

const labels: Array<[keyof Pick<DeviceStatus, 'watch' | 'phone' | 'earbuds' | 'microphone' | 'transcriptionProvider' | 'backend' | 'agentAccess'>, string]> = [
  ['watch', 'Watch'], ['phone', 'Phone'], ['earbuds', 'Earbuds'], ['microphone', 'Microphone'],
  ['transcriptionProvider', 'Transcription'], ['backend', 'Backend'], ['agentAccess', 'Agent access']
];

const tone: Record<State, string> = {
  connected: '#1d9b68', degraded: '#bf7d00', offline: '#ba3d3d', unavailable: '#ba3d3d', unknown: '#65717f'
};

export default function DeviceHealthPanel() {
  const theme = useTheme();
  const { getToolOutput } = useWidgetSDK();
  const data = getToolOutput<DeviceStatus>();
  const dark = theme === 'dark';
  const background = dark ? '#111820' : '#f5f7f8';
  const card = dark ? '#18232d' : '#ffffff';
  const text = dark ? '#edf4f7' : '#10212a';
  const muted = dark ? '#aac0c9' : '#536a75';

  if (!data) return <main style={{ padding: 20, color: text, background }}>Loading device health...</main>;
  const notices = [
    ...(data.flags.simulatedVitals ? ['Simulated vitals active'] : []),
    ...(data.flags.simulatedDeviceActions ? ['Simulated device actions active'] : []),
    ...data.flags.activeFallbacks.map((fallback) => `${fallback.replaceAll('_', ' ')} fallback active`)
  ];

  return (
    <main style={{ background, color: text, padding: 16, minWidth: 280, maxWidth: 760 }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'baseline', marginBottom: 14 }}>
        <div><h1 style={{ margin: 0, fontSize: 20 }}>Device Health</h1><p style={{ color: muted, fontSize: 12, margin: '4px 0 0' }}>{data.session ? `Session ${data.session.status}` : 'No active session'}</p></div>
        <span style={{ color: tone[data.backend.state], fontSize: 12, fontWeight: 700 }}>{data.backend.state.toUpperCase()}</span>
      </header>
      {notices.length > 0 && <section aria-label="Active modes" style={{ borderLeft: '4px solid #bf7d00', background: dark ? '#332a14' : '#fff4d7', padding: '9px 10px', marginBottom: 14, fontSize: 12 }}>
        {notices.join(' | ')}
      </section>}
      <section aria-label="Device connectivity" style={{ display: 'grid', gap: 9, gridTemplateColumns: 'repeat(auto-fit, minmax(205px, 1fr))' }}>
        {labels.map(([key, label]) => {
          const item = data[key];
          return <article key={key} style={{ background: card, border: `1px solid ${dark ? '#30414d' : '#d7e0e5'}`, borderRadius: 8, padding: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}><strong>{label}</strong><span style={{ color: tone[item.state], fontSize: 11, fontWeight: 700 }}>{item.state.toUpperCase()}</span></div>
            <p style={{ color: muted, fontSize: 12, lineHeight: 1.35, margin: '8px 0' }}>{item.detail}</p>
            <small style={{ color: muted }}>{item.mode ? item.mode.toUpperCase() : 'NO MODE'} | {new Date(item.checkedAt).toLocaleTimeString()}</small>
          </article>;
        })}
      </section>
    </main>
  );
}
