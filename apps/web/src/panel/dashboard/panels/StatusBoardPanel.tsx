import type { PanelData } from '@galactic/protocol';

export function StatusBoardPanel({ board }: { board: NonNullable<PanelData['statusBoard']> }) {
  return (
    <div className="dash-board">
      {board.columns.map((col) => (
        <section key={col.name} className="dash-board-col" aria-label={col.name}>
          <h4 className="dash-tag">{col.name}</h4>
          <ul>
            {col.items.map((item, i) => (
              <li key={i}>
                {item.title}
                {item.detail && <span className="muted"> — {item.detail}</span>}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
