import type { PanelData } from '@galactic/protocol';

export function ListPanel({ list }: { list: NonNullable<PanelData['list']> }) {
  return (
    <ul className="dash-feed">
      {list.map((item, i) => (
        <li key={i}>
          {item.tag && <span className="dash-tag">{item.tag}</span>}
          <span className="dash-feed-title">{item.title}</span>
          {item.detail && <span className="muted dash-feed-detail"> — {item.detail}</span>}
        </li>
      ))}
    </ul>
  );
}
